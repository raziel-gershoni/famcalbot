/**
 * Telegram albums (media groups) for the invitation reader.
 *
 * Telegram delivers an album as separate webhook updates that share a media_group_id and
 * sends no "last part" marker. Several requests run at once (and two instances may briefly
 * overlap during a zero-downtime deploy), so the parts are collected in Redis. A Redis
 * lock (SET NX) elects ONE request as the leader; it waits until no new part has arrived
 * for a quiet period, then reads every part in one Gemini request (handleMediaMessage).
 *
 * Redis keys, all under album:{chatId}:{media_group_id}:
 *   seen  set of file_unique_id: a part counts once, even if Telegram retries the update
 *         (also after the album was already read)
 *   parts list of JSON parts, drained by the leader
 *   lock  the leader's lock
 */

import { redis } from '../../utils/redis';
import { getMessagingService } from '../telegram';
import { startTypingInterval } from '../telegram/command-pipeline';
import { captureError } from '../../lib/error-capture';
import {
  handleMediaMessage,
  mediaFileOfDocument,
  type MediaFile,
  type TelegramDocument,
  type TelegramPhotoSize,
  type TelegramUser,
} from './handler';

/** Telegram puts at most 10 items in an album (longer sets arrive as several albums). */
export const MAX_ALBUM_PARTS = 10;

export const albumConfig = {
  /** How long the leader waits with no new part before reading the album. */
  quietMs: 1500,
};

/** Outlives a long Gemini read with its retry, so a second leader cannot start mid-read. */
const LOCK_TTL_SECONDS = 300;
/** Collected parts and the seen set expire on their own if nothing drains them. */
const KEY_TTL_SECONDS = 600;

type PartKind = 'image' | 'pdf' | 'video' | 'other';

interface AlbumPart {
  messageId: number;
  kind: PartKind;
  fileId: string;
  mimeType: string;
  fileSize?: number;
  caption?: string;
}

/** The slice of a Telegram message an album part needs. */
export interface AlbumMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  video?: { file_id: string; file_unique_id: string; mime_type?: string; file_size?: number };
  document?: TelegramDocument;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Redis may hand a stored JSON string back already parsed. */
function parsePart(raw: unknown): AlbumPart {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as AlbumPart;
}

/** What a message contributes to its album, with the id that makes it count once. */
function partOfMessage(message: AlbumMessage): { part: AlbumPart; uniqueId: string } | null {
  const base = { messageId: message.message_id, caption: message.caption };
  if (message.photo && message.photo.length > 0) {
    // Telegram sends ascending resolutions; the last is the highest.
    const photo = message.photo[message.photo.length - 1];
    return {
      uniqueId: photo.file_unique_id,
      part: { ...base, kind: 'image', fileId: photo.file_id, mimeType: 'image/jpeg', fileSize: photo.file_size },
    };
  }
  if (message.video) {
    return {
      uniqueId: message.video.file_unique_id,
      part: { ...base, kind: 'video', fileId: message.video.file_id, mimeType: message.video.mime_type || 'video/mp4', fileSize: message.video.file_size },
    };
  }
  if (message.document) {
    const file = mediaFileOfDocument(message.document);
    return {
      uniqueId: message.document.file_unique_id,
      part: {
        ...base,
        kind: file ? file.kind : 'other',
        fileId: message.document.file_id,
        mimeType: file ? file.mimeType : message.document.mime_type || 'application/octet-stream',
        fileSize: message.document.file_size,
      },
    };
  }
  return null;
}

/** Is this message one part of an album? Such a message is never handled as a single photo. */
export function isAlbumPart(message: Partial<AlbumMessage> | undefined): message is AlbumMessage {
  return !!message?.media_group_id && !!(message.photo?.length || message.video || message.document);
}

/**
 * Store one part of an album; the request that wins the lock becomes the leader and reads
 * the whole album when it goes quiet. Every other request returns as soon as its part is
 * stored.
 */
export async function handleAlbumPart(message: AlbumMessage): Promise<void> {
  const from = message.from;
  const groupId = message.media_group_id;
  const found = partOfMessage(message);
  if (!from || !groupId || !found) return;

  const chatId = message.chat.id;
  const key = `album:${chatId}:${groupId}`;
  const seenKey = `${key}:seen`;
  const partsKey = `${key}:parts`;
  const lockKey = `${key}:lock`;
  const label = `${key} message ${message.message_id}`;

  try {
    const isNew = await redis.sadd(seenKey, found.uniqueId);
    if (!isNew) {
      console.log(`[Album] ${label}: part ${found.uniqueId} already seen, ignoring (Telegram retry)`);
      return;
    }
    await redis.rpush(partsKey, JSON.stringify(found.part));
    await redis.expire(partsKey, KEY_TTL_SECONDS);
    await redis.expire(seenKey, KEY_TTL_SECONDS);
    console.log(`[Album] ${label}: stored ${found.part.kind} part ${found.uniqueId}`);
  } catch (error) {
    // The part is not handled as a single photo; the album is read without it.
    console.error(`[Album] ${label}: could not store the part:`, error);
    captureError(error, 'album-collect', { key });
    return;
  }

  try {
    const acquired = await redis.set(lockKey, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS });
    if (acquired !== 'OK') {
      console.log(`[Album] ${label}: another request is reading this album, leaving the part to it`);
      return;
    }
  } catch (error) {
    console.error(`[Album] ${label}: could not take the album lock:`, error);
    captureError(error, 'album-collect', { key });
    return;
  }

  console.log(`[Album] ${label}: leading the read`);
  await leadAlbum(chatId, from, { key, partsKey, lockKey });
}

/** Wait until the album has been quiet for quietMs (or is full), then return. */
async function waitForQuiet(partsKey: string, label: string): Promise<void> {
  let count = await redis.llen(partsKey);
  for (;;) {
    if (count >= MAX_ALBUM_PARTS) {
      console.log(`[Album] ${label}: ${count} parts, the album is full`);
      return;
    }
    await sleep(albumConfig.quietMs);
    const now = await redis.llen(partsKey);
    if (now === count) {
      console.log(`[Album] ${label}: quiet for ${albumConfig.quietMs} ms with ${count} part(s)`);
      return;
    }
    console.log(`[Album] ${label}: ${now - count} more part(s) arrived, waiting again`);
    count = now;
  }
}

async function leadAlbum(
  chatId: number,
  from: TelegramUser,
  keys: { key: string; partsKey: string; lockKey: string }
): Promise<void> {
  const { key, partsKey, lockKey } = keys;
  let holdingLock = true;
  let stopTyping: () => void = () => {};

  try {
    while (holdingLock) {
      // Typing runs through the quiet wait, the downloads and the read, in every round.
      stopTyping = startTypingInterval(chatId, getMessagingService());
      await waitForQuiet(partsKey, key);

      // Take everything collected so far; parts landing from now on stay in the list.
      const raw = await redis.lrange(partsKey, 0, -1);
      await redis.ltrim(partsKey, raw.length, -1);
      const parts = raw.map(parsePart).sort((a, b) => a.messageId - b.messageId);
      console.log(`[Album] ${key}: reading ${parts.length} part(s): ${parts.map(p => p.kind).join(',')}`);

      const files: MediaFile[] = parts
        .filter(p => p.kind === 'image' || p.kind === 'pdf')
        .map(p => ({ fileId: p.fileId, mimeType: p.mimeType, kind: p.kind as 'image' | 'pdf', fileSize: p.fileSize }));
      const skippedVideos = parts.filter(p => p.kind === 'video').length;
      const unsupportedParts = parts.filter(p => p.kind === 'other').length;
      // The caption of any item is the album's caption.
      const caption = [...new Set(parts.map(p => p.caption?.trim()).filter((c): c is string => !!c))].join('\n');

      if (files.length === 0) {
        console.log(`[Album] ${key}: nothing to read (${skippedVideos} video, ${unsupportedParts} other); ignoring like a lone video`);
      } else {
        await handleMediaMessage(chatId, from.id, from, files, caption || undefined, { skippedVideos, unsupportedParts, stopTyping });
      }

      stopTyping();

      // Release, then look again: a part that landed while we read must not be stranded.
      await redis.del(lockKey);
      holdingLock = false;
      const left = await redis.llen(partsKey);
      if (left === 0) break;
      console.log(`[Album] ${key}: ${left} part(s) arrived during the read, taking the lock again`);
      holdingLock = (await redis.set(lockKey, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS })) === 'OK';
    }
  } catch (error) {
    console.error(`[Album] ${key}: error while reading the album:`, error);
    captureError(error, 'album-read', { key });
    if (holdingLock) {
      try {
        await redis.del(lockKey);
      } catch (delError) {
        console.error(`[Album] ${key}: could not release the lock (it expires on its own):`, delError);
        captureError(delError, 'album-read', { key }, 'warning');
      }
    }
  } finally {
    stopTyping();
  }
}
