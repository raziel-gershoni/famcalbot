/**
 * A browser notification's payload (spec docs/superpowers/specs/2026-11-05-web-push-design.md §3.3): one JSON for every
 * browser, in Apple's declarative format ({ web_push: 8030, notification: {...} }), which iOS 18.4+ shows even when the
 * worker was evicted, and which public/sw.js reads everywhere else. At most MAX_PAYLOAD_BYTES of UTF-8 (Firefox for
 * Android takes about 2.7 KB): a long title is cut first, never below half the room, then the body, each with "…".
 * Built at send time; never kept, logged or sent to Sentry. Server only (node:crypto).
 */

import { createHash } from 'node:crypto';

export const MAX_PAYLOAD_BYTES = 2048;

export type PushLang = 'en' | 'he' | 'ru';

export interface PushMessage {
  title: string;
  body: string;
  /** Where a tap goes: an absolute https://famcal.bot URL (the declarative format's `navigate`). */
  url: string;
  /** A newer notification with the same tag replaces the older one on the device. */
  tag: string;
  lang: PushLang;
  /** No sound or vibration (the partner's Done, as on Telegram). */
  silent?: boolean;
}

const ELLIPSIS = '…';
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

function render(m: PushMessage, title: string, body: string): string {
  return JSON.stringify({
    web_push: 8030,
    notification: { title, body, navigate: m.url, lang: m.lang, dir: m.lang === 'he' ? 'rtl' : 'ltr', tag: m.tag, silent: m.silent === true },
  });
}

/** The longest start of `text` (whole characters, then "…") that `fits`; the text itself when it fits whole. */
function cut(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const chars = Array.from(text);
  const withEllipsis = (n: number) => `${chars.slice(0, n).join('').trimEnd()}${ELLIPSIS}`;
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(withEllipsis(mid))) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) return withEllipsis(lo);
  return fits(ELLIPSIS) ? ELLIPSIS : '';
}

/** The payload, its title and body cut to fit MAX_PAYLOAD_BYTES. */
export function buildPushPayload(m: PushMessage): string {
  const fits = (title: string, body: string) => utf8(render(m, title, body)) <= MAX_PAYLOAD_BYTES;
  if (fits(m.title, m.body)) return render(m, m.title, m.body);
  // The title first, as far as the whole body needs, but never below half the room: a long list keeps its title
  const half = Math.floor((MAX_PAYLOAD_BYTES - utf8(render(m, '', ''))) / 2);
  const inJson = (text: string) => utf8(JSON.stringify(text)) - 2;
  const title = cut(m.title, (t) => fits(t, m.body) || inJson(t) <= half);
  const body = cut(m.body, (b) => fits(title, b));
  return render(m, title, body);
}

/**
 * The push's Topic (RFC 8030: at most 32 base64url characters): a newer push with the same topic replaces one still
 * waiting at the push service. A SHA-256 of the tag, so the push service sees no FamCal id.
 */
export function topicFor(tag: string): string {
  return createHash('sha256').update(tag, 'utf8').digest('base64url').slice(0, 32);
}
