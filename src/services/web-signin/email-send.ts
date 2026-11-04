/**
 * The sign-in emails (spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §2.5, §3 "Email"): the code, and
 * the security notice for an account with no chat (web sign-up spec 2026-11-03 §2.11). Each is one POST to
 * Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email) through fetchWithRetry, with an
 * Idempotency-Key, so a retried POST still sends one email. From FamCal <signin@famcal.bot>, replies to
 * privacy@famcal.bot; the words are messages' signinEmail (and the notice's own, from notice.ts) in the person's
 * language, Hebrew right to left. Notices have their own budget (takeNoticeSend: 3 a day per account, then 10 a day in
 * all), apart from the codes' 90.
 *
 * No console line or error holds the address or the code: a line names the user id (or "a new account" for a sign-up
 * code), the purpose, the status and Resend's id. A failed send is logged here (onGiveUp) and thrown, so the caller
 * reports it. The sign-up code (web sign-up spec §2.21) goes to the address typed on /signin, since no account has it.
 * Server only.
 */

import crypto from 'crypto';
import enMessages from '../../../messages/en.json';
import heMessages from '../../../messages/he.json';
import ruMessages from '../../../messages/ru.json';
import { fetchWithRetry, HttpStatusError } from '../../utils/fetch-retry';
import { escapeHtml } from '../../utils/html';
import { normalizeLocale, type Locale } from '../../utils/locale';
import { SafeSignInError, safeErrorSummary } from './safe-error';
import { takeNoticeSend } from './limits';

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const SIGNIN_FROM = 'FamCal <signin@famcal.bot>';
export const SIGNIN_REPLY_TO = 'privacy@famcal.bot';

/** What a code is for: signing in, adding this address as a way to sign in (Settings), or creating an account with it. */
export type CodePurpose = 'signin' | 'add' | 'signup';

/** Who a code is for, in a log line: the user id, or "a new account" for a sign-up code (no account yet). */
export function codeOwner(userId: number | null): string {
  return userId === null ? 'a new account' : `user ${userId}`;
}

type EmailWords = typeof enMessages.signinEmail;
const WORDS: Record<Locale, EmailWords> = {
  en: enMessages.signinEmail,
  he: heMessages.signinEmail,
  ru: ruMessages.signinEmail,
};

/** Whether email codes can be sent at all (RESEND_API_KEY is set). */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export interface CodeEmail {
  subject: string;
  text: string;
  html: string;
}

/** The text's direction and side in a language. */
const directionOf = (lang: Locale): { dir: 'rtl' | 'ltr'; align: 'right' | 'left' } =>
  lang === 'he' ? { dir: 'rtl', align: 'right' } : { dir: 'ltr', align: 'left' };

const paragraph = (line: string, style = '') => `<p style="margin:0 0 16px;${style}">${escapeHtml(line)}</p>`;
const heading = (line: string) => `<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${escapeHtml(line)}</h1>`;

/**
 * An email's HTML around its blocks, in `lang`. Gmail and others drop <html>'s and <body>'s attributes, so the
 * direction is also on the block that holds the text.
 */
function emailHtml(lang: Locale, subject: string, blocks: string): string {
  const { dir, align } = directionOf(lang);
  return (
    `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    `<title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0">` +
    `<div dir="${dir}" lang="${lang}" style="direction:${dir};text-align:${align};max-width:480px;margin:0 auto;padding:32px 16px;` +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:1.5\">" +
    blocks +
    '</div></body></html>'
  );
}

/** The email for `code`: its subject, plain text and HTML, in `locale` (English for an unknown one). */
export function codeEmail(code: string, locale: string, purpose: CodePurpose): CodeEmail {
  const lang = normalizeLocale(locale);
  const words = WORDS[lang];
  const own = words[purpose];
  const subject = own.subject.replace('{code}', code);
  const text = [own.heading, own.body, code, words.expiry, words.warning, own.ignore, words.footer].join('\n\n');
  const { align } = directionOf(lang);
  // The code is digits: its own line, left to right, on the text's side.
  const html = emailHtml(
    lang,
    subject,
    heading(own.heading) +
      paragraph(own.body) +
      `<p dir="ltr" style="margin:0 0 16px;direction:ltr;text-align:${align};font-size:32px;font-weight:700;letter-spacing:6px;` +
      `font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>` +
      paragraph(words.expiry) +
      paragraph(words.warning) +
      paragraph(own.ignore) +
      paragraph(words.footer, 'font-size:13px'),
  );
  return { subject, text, html };
}

/** The notice email: the subject as its heading, the notice's lines, the footer, in `locale`. */
export function noticeEmail(subject: string, lines: string[], locale: string): CodeEmail {
  const lang = normalizeLocale(locale);
  const footer = WORDS[lang].footer;
  const text = [subject, ...lines, footer].join('\n\n');
  const html = emailHtml(lang, subject, heading(subject) + lines.map(line => paragraph(line)).join('') + paragraph(footer, 'font-size:13px'));
  return { subject, text, html };
}

/**
 * One email to Resend, `what` naming it in the log lines (never the address) and `owner` who it is for (codeOwner, or
 * "user <id>"): the Resend id once it took it. Throws when it refused (any 4xx, at once), or a 429/5xx or no answer ran
 * out of retries, after one line with the owner and status.
 */
async function postEmail(args: { apiKey: string; to: string; email: CodeEmail; idempotencyKey: string; what: string; owner: string }): Promise<string> {
  const { subject, text, html } = args.email;
  const response = await fetchWithRetry(
    RESEND_EMAILS_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
        // One key per email, the same on every retry of it: Resend keeps it 24 hours and sends once.
        'Idempotency-Key': args.idempotencyKey,
      },
      body: JSON.stringify({ from: SIGNIN_FROM, to: [args.to], reply_to: SIGNIN_REPLY_TO, subject, text, html }),
    },
    {
      label: '[signin-email]',
      onGiveUp: (error, { retried, why }) => {
        const status = error instanceof HttpStatusError ? `status ${error.status}` : 'no answer';
        console.error(`[signin-email] gave up on the ${args.what} for ${args.owner}: ${status}, ${why} (${retried} retries)`);
      },
    }
  );
  let id = 'unknown';
  try {
    const answer = (await response.json()) as { id?: unknown };
    if (typeof answer.id === 'string') id = answer.id;
  } catch (error) {
    console.warn(`[signin-email] Resend took the ${args.what} for ${args.owner}, but its answer was unreadable: ${safeErrorSummary(error)}`);
  }
  console.log(`[signin-email] sent the ${args.what} for ${args.owner} (Resend id ${id})`);
  return id;
}

/**
 * Mails `code` to `to` (the address stored on the row; for a sign-up code, the normalised address typed). Resolves once
 * Resend took it; throws when it refused (any 4xx, at once), or a 429/5xx or no answer ran out of retries, after one
 * line with the user id (codeOwner) and status.
 */
export async function sendCodeEmail(args: { to: string; code: string; locale: string; purpose: CodePurpose; userId: number | null }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new SafeSignInError('RESEND_API_KEY is not set: no sign-in email can be sent');
  await postEmail({
    apiKey,
    to: args.to,
    email: codeEmail(args.code, args.locale, args.purpose),
    idempotencyKey: `signin-${args.purpose}-${crypto.randomUUID()}`,
    what: `${args.purpose} code`,
    owner: codeOwner(args.userId),
  });
}

/** Why a notice email was not sent before Resend was asked: takeNoticeSend's refusal (Task 4). */
export type NoticeRefusal = 'notice-account-day' | 'notice-budget' | 'store-down';

/**
 * Mails a security notice (notice.ts) to `to`: an address the account already signs in with, never typed text, never
 * the way just added. It takes from the notices' own budget first (takeNoticeSend(userId), apart from the codes' 90):
 * the account's 3 a UTC day, then the day's 10 in all. When that refuses, nothing is sent and the answer is the reason:
 * 'notice-account-day' (this account's are spent), 'notice-budget' (the day's 10 are spent) or 'store-down' (Redis
 * failed). 'sent' once Resend took it; throws when it refused or ran out of retries (logged here), so the caller reports
 * the notice as not sent.
 */
export async function sendNoticeEmail(args: { to: string; locale: string; subject: string; lines: string[]; userId: number }): Promise<'sent' | NoticeRefusal> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new SafeSignInError('RESEND_API_KEY is not set: no notice email can be sent');
  const taken = await takeNoticeSend(args.userId);
  if (!taken.ok) return taken.reason;
  await postEmail({
    apiKey,
    to: args.to,
    email: noticeEmail(args.subject, args.lines, args.locale),
    idempotencyKey: `signin-notice-${crypto.randomUUID()}`,
    what: 'notice',
    owner: `user ${args.userId}`,
  });
  return 'sent';
}
