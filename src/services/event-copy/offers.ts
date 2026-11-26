/**
 * Single-use offers to copy a FamCal event (docs/superpowers/specs/2026-11-27-send-event-copy-design.md).
 *
 * The sender's tap makes an offer; its token travels in the card's deep link (`?start=cp_<token>`), and only the token's
 * SHA-256 is stored. The first receiver to copy takes it: one conditional update (`claimCopyOffer`) decides the winner,
 * the copy is written through the event store (`copyEventFor`), and the offer remembers it (`recordCopy`).
 *
 * Logs: the prefix `[event-copy]`, user ids, the offer's id and outcomes. Never the token, a title or a name.
 */

import crypto from 'crypto';
import type { EventCopyOffer, NativeEvent, User } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { DEFAULT_BOT_USERNAME } from '../../lib/gate-links';
import { isIdentifierBlocked, isUserSuspended } from '../../lib/user-moderation';
import type { UserConfig } from '../../types';
import { createNativeEvent, getCalendarAccess } from '../native-calendar/event-store';
import type { HebrewRule } from '../native-calendar/recurrence';

const TAG = '[event-copy]';
/** The start payload's prefix (Telegram allows 64 characters of A-Z a-z 0-9 _ -). */
const START_PREFIX = 'cp_';
/** 16 random bytes in base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function copyTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** A new token (16 random bytes, base64url, as Connect Telegram's) and the hash that is stored for it. */
export function newCopyToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(16).toString('base64url');
  return { token, tokenHash: copyTokenHash(token) };
}

export function copyStartParam(token: string): string {
  return `${START_PREFIX}${token}`;
}

/** The token in a start payload's part after `cp_`, or null when it is not one. */
export function copyTokenFromStart(payload: string): string | null {
  return TOKEN_PATTERN.test(payload) ? payload : null;
}

export function copyDeepLink(token: string): string {
  const bot = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  return `https://t.me/${bot}?start=${copyStartParam(token)}`;
}

/** Makes a new offer for a tap on Send a copy (every tap makes its own). The caller has checked the sender may send this event. */
export async function createCopyOffer(senderUserId: number, sourceEventId: string): Promise<{ offerId: string; token: string }> {
  const { token, tokenHash } = newCopyToken();
  const offer = await prisma.eventCopyOffer.create({ data: { tokenHash, sourceEventId, senderUserId }, select: { id: true } });
  console.log(`${TAG} offer ${offer.id} made by user ${senderUserId} for event ${sourceEventId}`);
  return { offerId: offer.id, token };
}

export type CopyOfferView =
  | { state: 'invalid' }
  | { state: 'mine' | 'taken' | 'gone' | 'open'; offer: EventCopyOffer; source: NativeEvent; sender: User }
  /** Taken by the viewer; calendarName is null while the copy is not recorded yet (a second tap during the first). */
  | { state: 'yours'; offer: EventCopyOffer; source: NativeEvent; sender: User; calendarName: string | null };

/**
 * What a token means to a viewer now:
 *   - invalid: no such offer;
 *   - taken (by someone else) / yours (the viewer took it; with the calendar the copy is in);
 *   - gone: the original is deleted, the sender can no longer see its calendar (a partner's made private, or an unlink),
 *     or the sender is suspended or banned;
 *   - mine: the sender's own tap, which never uses it up;
 *   - open.
 * A taken offer answers taken or yours first, whatever became of the original since.
 */
export async function viewCopyOffer(token: string, viewerUserId: number): Promise<CopyOfferView> {
  const offer = await prisma.eventCopyOffer.findUnique({ where: { tokenHash: copyTokenHash(token) } });
  if (!offer) return { state: 'invalid' };
  const [source, sender] = await Promise.all([
    prisma.nativeEvent.findUnique({ where: { id: offer.sourceEventId } }),
    prisma.user.findUnique({ where: { id: offer.senderUserId } }),
  ]);
  // The rows cascade with the offer: one missing here is a race with a delete.
  if (!source || !sender) return { state: 'invalid' };

  if (offer.takenAt) {
    if (offer.takenByUserId === viewerUserId) {
      if (!offer.copyEventId) return { state: 'yours', offer, source, sender, calendarName: null };
      const copy = await prisma.nativeEvent.findUnique({ where: { id: offer.copyEventId }, select: { calendarId: true } });
      const calendar = copy ? await prisma.nativeCalendar.findUnique({ where: { id: copy.calendarId }, select: { name: true } }) : null;
      return { state: 'yours', offer, source, sender, calendarName: calendar?.name ?? null };
    }
    return { state: 'taken', offer, source, sender };
  }

  if (!(await senderCanStillSend(offer, source, sender))) return { state: 'gone', offer, source, sender };
  if (offer.senderUserId === viewerUserId) return { state: 'mine', offer, source, sender };
  return { state: 'open', offer, source, sender };
}

/** The original stands, the sender still sees its calendar, and the sender's account is active. */
async function senderCanStillSend(offer: EventCopyOffer, source: NativeEvent, sender: User): Promise<boolean> {
  if (source.isDeleted) return false;
  if (isUserSuspended(sender)) return false;
  const calendar = await prisma.nativeCalendar.findUnique({
    where: { id: source.calendarId },
    select: { ownerUserId: true, privacy: true, isDeleted: true },
  });
  if (!calendar || (await getCalendarAccess(sender, calendar)) === 'none') return false;
  if (sender.telegramId !== null && (await isIdentifierBlocked({ telegramId: sender.telegramId }))) {
    console.log(`${TAG} offer ${offer.id}: the sender's account is banned`);
    return false;
  }
  return true;
}

/**
 * Takes the offer for a user: one conditional update (untaken, the original not deleted), true only for the winner, so
 * two presses at once give one copy.
 */
export async function claimCopyOffer(offerId: string, userId: number): Promise<boolean> {
  // One plain conditional UPDATE (no relation filter, which could be read and written in two statements): two presses at
  // once, one wins.
  const { count } = await prisma.eventCopyOffer.updateMany({
    where: { id: offerId, takenAt: null },
    data: { takenAt: new Date(), takenByUserId: userId },
  });
  if (count !== 1) {
    console.log(`${TAG} offer ${offerId}: user ${userId} did not get it`);
    return false;
  }
  // The original may have been deleted since the press looked: then the claim is given back and the offer is gone.
  const offer = await prisma.eventCopyOffer.findUnique({ where: { id: offerId }, select: { sourceEventId: true } });
  const source = offer ? await prisma.nativeEvent.findUnique({ where: { id: offer.sourceEventId }, select: { isDeleted: true } }) : null;
  if (!source || source.isDeleted) {
    await releaseCopyOffer(offerId, userId);
    console.log(`${TAG} offer ${offerId}: the original is gone, the claim of user ${userId} given back`);
    return false;
  }
  console.log(`${TAG} offer ${offerId}: user ${userId} claimed it`);
  return true;
}

/** Gives a claim back (the copy's write failed): the offer is open again. Only its taker, and only before a copy is recorded. */
export async function releaseCopyOffer(offerId: string, userId: number): Promise<void> {
  const { count } = await prisma.eventCopyOffer.updateMany({
    where: { id: offerId, takenByUserId: userId, copyEventId: null },
    data: { takenAt: null, takenByUserId: null },
  });
  console.log(`${TAG} offer ${offerId}: user ${userId} released it${count === 1 ? '' : ' (nothing to release)'}`);
}

/**
 * Writes the receiver's copy through the event store (so the alerts gate opens): the title, the time or all-day, the
 * repeat with its Hebrew kind and skipped days, and the birthday mark with its year. Not the description, the location or
 * the alerts (the receiver's defaults apply), and not single-day changes. Throws NativePermissionDeniedError for a
 * calendar the receiver can't write.
 */
export async function copyEventFor(source: NativeEvent, receiver: UserConfig, calendarCuid: string): Promise<NativeEvent> {
  const copy = await createNativeEvent({
    calendarCuid,
    creatorUserId: receiver.id,
    title: source.title,
    startsAt: source.startsAt,
    endsAt: source.endsAt,
    allDay: source.allDay,
    timeZone: source.timeZone,
    rrule: source.rrule,
    hebrewRule: source.hebrewRule as HebrewRule | null,
    hebrewAnchor: source.hebrewAnchor,
    exdates: source.exdates,
    birthday: source.birthday,
    birthYear: source.birthday ? source.birthYear : null,
  });
  console.log(`${TAG} event ${source.id} copied to ${copy.id} in calendar ${calendarCuid} for user ${receiver.id}`);
  return copy;
}

/** The offer remembers its copy. */
export async function recordCopy(offerId: string, copyEventId: string): Promise<void> {
  await prisma.eventCopyOffer.update({ where: { id: offerId }, data: { copyEventId } });
}
