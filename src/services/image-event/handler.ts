/**
 * Image message handler
 * Processes invitation photos, albums of photos, PDFs and images sent as documents for
 * automatic event creation. Twin of the forwarded-text and voice handlers; converges on
 * the same confirmation / auto-create seam.
 */

import { getBot, getMessagingService } from '../telegram';
import { getUserByTelegramId } from '../user-service';
import { MessageFormat } from '../messaging/types';
import { processMediaWithGemini, MediaPart } from './gemini-image';
import { preparePdf, PdfUnreadableError } from './pdf';
import { resolveUserTimezone } from '../../lib/timezone';
import { buildUrl } from '../../config/urls';
import { getBotMessages, getBotMessage } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb, setUserContext } from '../analytics-service';
import { checkFeatureAccess } from '../subscription-service';
import { showEventConfirmation } from '../voice/confirmations';
import { downloadTelegramFile } from '../voice/event-resolution';
import { captureError } from '../../lib/error-capture';
import { startTypingInterval } from '../telegram/command-pipeline';
import type { VoiceIntentResult } from '../event-parser';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

/** Telegram PhotoSize (the highest-resolution entry of message.photo). */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** Telegram document as the webhook delivers it. */
export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Telegram's bot download limit (getFile): larger files cannot be fetched at all. */
export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Most bytes of files one request carries. Gemini's inline limit is 100 MB per request and
 * base64 adds a third, so 40 MB of files leaves a wide margin and keeps the memory
 * (raw bytes, base64 and the JSON body at once) gentle on a 1 GB server.
 */
export const MAX_TOTAL_MEDIA_BYTES = 40 * 1024 * 1024;

/** One file to read: a photo, an image sent as a document, or a PDF. */
export interface MediaFile {
  fileId: string;
  mimeType: string;
  kind: 'image' | 'pdf';
  fileSize?: number;
}

/** Why a file could not be read, to pick the message when none could be. */
type FailureReason = 'too_large' | 'download' | 'pdf' | 'budget';

/** Image types Gemini accepts that may arrive as a document (a photo sent "as a file"). */
const IMAGE_DOCUMENT_MIME: Record<string, string> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'image/heic': 'image/heic',
  'image/heif': 'image/heif',
};

/** What a document is for the reader, or null when it is neither an image nor a PDF. */
export function mediaFileOfDocument(document: TelegramDocument): MediaFile | null {
  const mime = (document.mime_type || '').toLowerCase();
  if (mime === 'application/pdf') {
    return { fileId: document.file_id, mimeType: 'application/pdf', kind: 'pdf', fileSize: document.file_size };
  }
  const imageMime = IMAGE_DOCUMENT_MIME[mime];
  if (imageMime) {
    return { fileId: document.file_id, mimeType: imageMime, kind: 'image', fileSize: document.file_size };
  }
  return null;
}

/** The same event read twice (a flyer on two photos) is one event: same title and start. */
export function dedupeIntents(intents: VoiceIntentResult[]): VoiceIntentResult[] {
  const seen = new Set<string>();
  return intents.filter(intent => {
    const event = intent.event;
    if (!event) return true;
    const key = `${event.title.trim().replace(/\s+/g, ' ').toLowerCase()}|${event.startTime.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Handle an invitation photo for event creation.
 */
export async function handleImageMessage(
  chatId: number,
  userId: number,
  photo: TelegramPhotoSize,
  from: TelegramUser,
  caption?: string
): Promise<void> {
  await handleMediaMessage(
    chatId,
    userId,
    from,
    [{ fileId: photo.file_id, mimeType: 'image/jpeg', kind: 'image', fileSize: photo.file_size }],
    caption
  );
}

/**
 * Handle a document: a PDF or an image sent as a file is read like a photo; anything else
 * gets a polite "send a photo or PDF".
 */
export async function handleDocumentMessage(
  chatId: number,
  userId: number,
  document: TelegramDocument,
  from: TelegramUser,
  caption?: string
): Promise<void> {
  const file = mediaFileOfDocument(document);
  if (file) {
    await handleMediaMessage(chatId, userId, from, [file], caption);
    return;
  }

  await replyUnsupportedDocument(chatId, userId);
}

/** The polite "I can read photos and PDF files" for a document that is neither. */
export async function replyUnsupportedDocument(chatId: number, userId: number): Promise<void> {
  console.log(`[Image] Unsupported document from user ${userId}`);
  const messagingService = getMessagingService();
  try {
    const user = await getUserByTelegramId(userId);
    const t = await getBotMessages(user?.language || 'en');
    await messagingService.sendMessage(
      chatId,
      user ? t.imageEvent.unsupportedDocument : t.voice.notRegistered,
      { format: MessageFormat.PLAIN }
    );
  } catch (error) {
    console.error('[Image] Error answering an unsupported document:', error);
    captureError(error, 'image-handler');
  }
}

/** The generic error reply for an album whose collection or read broke before the handler could answer. */
export async function replyAlbumFailed(chatId: number, userId: number): Promise<void> {
  try {
    const user = await getUserByTelegramId(userId);
    const t = await getBotMessages(user?.language || 'en');
    await getMessagingService().sendMessage(chatId, t.voice.geminiError, { format: MessageFormat.PLAIN });
  } catch (error) {
    console.error('[Image] Could not tell the user the album failed:', error);
    captureError(error, 'image-handler');
  }
}

export interface MediaOptions {
  /** Videos left out of an album; the user is told. */
  skippedVideos?: number;
  /** Album members that are neither an image nor a PDF; counted as unreadable. */
  unsupportedParts?: number;
  /** A typing indicator the caller already started (an album's quiet wait); stopped here before the answer. */
  stopTyping?: () => void;
}

/**
 * Read one or more files (a photo, an album, a PDF) in ONE Gemini request and show the
 * events on the confirmation / auto-create seam. The gates, the usage event and the
 * typing indicator run once however many files there are: an album or PDF is one use.
 */
export async function handleMediaMessage(
  chatId: number,
  userId: number,
  from: TelegramUser,
  files: MediaFile[],
  caption?: string,
  options: MediaOptions = {}
): Promise<void> {
  console.log(`[Image] Starting media handler for user ${userId}, ${files.length} file(s)`);
  const messagingService = getMessagingService();
  let user: Awaited<ReturnType<typeof getUserByTelegramId>> | null = null;
  let stopTyping: (() => void) | null = options.stopTyping ?? null;

  setUserContext(userId, from.first_name);
  addBreadcrumb('image_processing_started', { user_id: userId, files: files.length }, 'image');

  try {
    user = await getUserByTelegramId(userId);

    if (!user) {
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId, t.voice.notRegistered, { format: MessageFormat.PLAIN });
      return;
    }

    const t = await getBotMessages(user.language || 'en');

    // Reuse the same "AI event creation" toggle as voice / forwarded text.
    if (!user.voiceInputEnabled) {
      const bot = getBot();
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.telegramId ?? user.id}`);
      await bot.sendMessage(chatId, t.voice.featureDisabled, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: t.voice.enableInSettings, web_app: { url: settingsUrl } }]],
        },
      });
      return;
    }

    const eventAccess = await checkFeatureAccess(user.id, 'voice_events');
    if (!eventAccess.allowed) {
      const bot = getBot();
      const upgradeUrl = buildUrl(`/${user.language || 'en'}/subscription?user_id=${user.telegramId ?? user.id}`);
      const upgradeMessage = t.subscription?.voiceEventsRequired
        || '⭐ <b>Voice event creation is a Pro feature</b>\n\nUpgrade to Pro to create calendar events using voice messages!';
      await bot.sendMessage(chatId, upgradeMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: t.subscription?.upgradeButton || '⭐ Upgrade to Pro', web_app: { url: upgradeUrl } }]],
        },
      });
      return;
    }

    trackActivityAsync(user.id, 'image_event_started', { language: user.language, files: files.length });

    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
    if (!(await hasUsableCalendar(user))) {
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }
    const userCalendars = await getCalendarAssignmentsForUser(user);

    if (!stopTyping) stopTyping = startTypingInterval(chatId, messagingService);

    // Fetch every file; one that fails is left out and reported, the rest go on.
    const media: MediaPart[] = [];
    const failures: FailureReason[] = [];
    let trimmed: { kept: number; total: number } | null = null;
    let totalBytes = 0;
    for (const file of files) {
      try {
        if (file.fileSize && file.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
          console.warn(`[Image] File ${file.fileId} is ${file.fileSize} bytes, over Telegram's download limit`);
          failures.push('too_large');
          continue;
        }
        if (totalBytes + (file.fileSize ?? 0) > MAX_TOTAL_MEDIA_BYTES) {
          console.warn(`[Image] File ${file.fileId} (${file.fileSize} bytes) would take the request over ${MAX_TOTAL_MEDIA_BYTES} bytes (${totalBytes} so far), skipping it`);
          failures.push('budget');
          continue;
        }
        console.log(`[Image] Downloading ${file.kind} for user ${userId}, file_id: ${file.fileId}`);
        let buffer = await downloadTelegramFile(file.fileId);
        console.log(`[Image] Downloaded ${buffer.length} bytes`);
        if (file.kind === 'pdf') {
          try {
            const prepared = await preparePdf(buffer);
            buffer = prepared.buffer;
            if (prepared.keptPages < prepared.totalPages && !trimmed) {
              trimmed = { kept: prepared.keptPages, total: prepared.totalPages };
            }
          } catch (error) {
            if (!(error instanceof PdfUnreadableError)) throw error;
            console.warn(`[Image] ${error.message} (file_id ${file.fileId})`);
            captureError(error, 'image-handler', { fileId: file.fileId }, 'warning');
            failures.push('pdf');
            continue;
          }
        }
        if (totalBytes + buffer.length > MAX_TOTAL_MEDIA_BYTES) {
          console.warn(`[Image] File ${file.fileId} (${buffer.length} bytes) would take the request over ${MAX_TOTAL_MEDIA_BYTES} bytes (${totalBytes} so far), skipping it`);
          failures.push('budget');
          continue;
        }
        // Counted by the larger of the real and the declared size, so the cap holds either way.
        totalBytes += Math.max(buffer.length, file.fileSize ?? 0);
        media.push({ buffer, mimeType: file.mimeType });
      } catch (error) {
        console.error(`[Image] Could not fetch file ${file.fileId}:`, error);
        captureError(error, 'image-handler', { fileId: file.fileId });
        failures.push('download');
      }
    }
    for (let i = 0; i < (options.unsupportedParts ?? 0); i++) failures.push('download');

    if (media.length === 0) {
      stopTyping();
      const reason = failures.every(f => f === 'too_large') ? 'too_large'
        : failures.every(f => f === 'pdf') ? 'pdf' : 'other';
      console.warn(`[Image] Nothing to read for user ${userId}: ${failures.join(',')}`);
      trackActivityAsync(user.id, 'image_event_failed', { error_type: `no_readable_file:${failures.join(',')}` });
      await messagingService.sendMessage(
        chatId,
        reason === 'too_large' ? t.imageEvent.fileTooLarge
          : reason === 'pdf' ? t.imageEvent.pdfUnreadable
          : t.voice.geminiError,
        { format: MessageFormat.PLAIN }
      );
      return;
    }

    // Short notes about what was left out, sent with the answer (never one per file).
    const notes: string[] = [];
    if (options.skippedVideos) notes.push(t.imageEvent.videoSkipped);
    if (failures.length > 0) notes.push(t.imageEvent.partsUnreadable);
    if (trimmed) {
      notes.push(await getBotMessage(user.language || 'en', 'imageEvent.pdfTrimmed', {
        kept: String(trimmed.kept),
        total: String(trimmed.total),
      }));
    }

    const timezone = await resolveUserTimezone(user);
    const { intentResults: rawResults, metrics } = await processMediaWithGemini(
      media,
      caption,
      user.language || 'en',
      userCalendars,
      timezone
    );
    const intentResults = dedupeIntents(rawResults || []);
    const intentResult = intentResults[0];

    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;

    addBreadcrumb('image_intent_detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      has_event: !!intentResult.event,
      files: media.length,
    }, 'image');

    console.log(`[Image] Intent detected: ${intentResult.intent}, confidence: ${intentResult.confidence}, ${intentResults.length} result(s) from ${media.length} file(s)`);

    stopTyping();

    const sendNotes = async () => {
      if (notes.length > 0) {
        await messagingService.sendMessage(chatId, notes.join('\n'), { format: MessageFormat.PLAIN });
      }
    };

    // Source label shown on the confirmation card (there is no transcription).
    const onlyPdf = media.length === 1 && media[0].mimeType === 'application/pdf';
    const sourceLabel = caption?.trim()
      || (media.length > 1 ? t.imageEvent?.fromImages : onlyPdf ? t.imageEvent?.fromPdf : t.imageEvent?.fromImage)
      || 'an invitation image';

    // Multi-event flyer or album: 2+ valid CREATE intents → bulk card (never auto-creates).
    const validBulk = intentResults.filter(r => r.intent === 'create' && r.event && !r.error);
    if (validBulk.length > 1) {
      await sendNotes();
      const { showBulkConfirmation } = await import('../voice/bulk-confirmations');
      await showBulkConfirmation(chatId, validBulk, user, sourceLabel, t, messagingService, timezone);
      return;
    }

    if (intentResult.intent === 'create' && intentResult.event) {
      await sendNotes();
      // Auto-create only for HIGH-confidence, non-recurring single events, and
      // only when the shared admin flag is on. The image prompt already
      // downgrades confidence on any ambiguity (RSVP-vs-event date, a guessed
      // time, a printed weekday that doesn't match, a Hebrew-calendar-only date,
      // or a date that is or looks past), so "high" here means the day, month
      // and time were printed and the year, if missing, is clear — the approved
      // ambiguity guard, expressed through the confidence channel.
      const { isAutoCreateEnabled, autoCreateEvent } = await import('../voice/auto-create');
      if (
        intentResult.confidence === 'high' &&
        !intentResult.event.recurrence &&
        (await isAutoCreateEnabled())
      ) {
        const handled = await autoCreateEvent(user, intentResult.event, t, messagingService, chatId);
        if (handled) return;
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, sourceLabel, user, adminFooter, 'image');
      return;
    }

    // intent === 'none' (or no event) → ONE friendly reply with the notes folded in, nothing created.
    const noEvent = media.length > 1 ? t.imageEvent?.noEventFoundMany
      : onlyPdf ? t.imageEvent?.noEventFoundPdf
      : t.imageEvent?.noEventFound;
    await messagingService.sendMessage(
      chatId,
      [...notes, noEvent || "🤔 I couldn't find an event in that image."].join('\n\n'),
      { format: MessageFormat.PLAIN }
    );

  } catch (error) {
    if (stopTyping) stopTyping();
    console.error('[Image] Error handling image message:', error);
    captureError(error, 'image-handler');

    if (user) {
      trackActivityAsync(user.id, 'image_event_failed', {
        error_type: error instanceof Error ? error.message : 'unknown',
      });
    }

    // A genuine failure (download / Gemini error) — report an error, NOT the
    // "no event found" copy, which is reserved for the intent === 'none' path.
    const errorMessages = await getBotMessages(user?.language || 'en');
    await messagingService.sendMessage(
      chatId,
      errorMessages.voice.geminiError,
      { format: MessageFormat.PLAIN }
    );
  }
}
