/**
 * The sign-in code email (spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §2.5, §3 "Email"): one POST to
 * Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email) through fetchWithRetry, with an
 * Idempotency-Key, so a retried POST still sends one email. From FamCal <signin@famcal.bot>, replies to
 * privacy@famcal.bot; the words are messages' signinEmail in the person's language, Hebrew right to left.
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

/** The email for `code`: its subject, plain text and HTML, in `locale` (English for an unknown one). */
export function codeEmail(code: string, locale: string, purpose: CodePurpose): CodeEmail {
  const lang = normalizeLocale(locale);
  const words = WORDS[lang];
  const own = words[purpose];
  const subject = own.subject.replace('{code}', code);
  const text = [own.heading, own.body, code, words.expiry, words.warning, own.ignore, words.footer].join('\n\n');
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  const align = dir === 'rtl' ? 'right' : 'left';
  const paragraph = (line: string, style = '') => `<p style="margin:0 0 16px;${style}">${escapeHtml(line)}</p>`;
  // Gmail and others drop <html>'s and <body>'s attributes, so the direction is also on the block that holds the text.
  // The code is digits: its own line, left to right, on the text's side.
  const html =
    `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    `<title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0">` +
    `<div dir="${dir}" lang="${lang}" style="direction:${dir};text-align:${align};max-width:480px;margin:0 auto;padding:32px 16px;` +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:1.5\">" +
    `<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${escapeHtml(own.heading)}</h1>` +
    paragraph(own.body) +
    `<p dir="ltr" style="margin:0 0 16px;direction:ltr;text-align:${align};font-size:32px;font-weight:700;letter-spacing:6px;` +
    `font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>` +
    paragraph(words.expiry) +
    paragraph(words.warning) +
    paragraph(own.ignore) +
    paragraph(words.footer, 'font-size:13px') +
    '</div></body></html>';
  return { subject, text, html };
}

/**
 * Mails `code` to `to` (the address stored on the row; for a sign-up code, the normalised address typed). Resolves once
 * Resend took it; throws when it refused (any 4xx, at once), or a 429/5xx or no answer ran out of retries, after one
 * line with the user id (codeOwner) and status.
 */
export async function sendCodeEmail(args: { to: string; code: string; locale: string; purpose: CodePurpose; userId: number | null }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new SafeSignInError('RESEND_API_KEY is not set: no sign-in email can be sent');
  const { subject, text, html } = codeEmail(args.code, args.locale, args.purpose);
  const response = await fetchWithRetry(
    RESEND_EMAILS_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // One key per email, the same on every retry of it: Resend keeps it 24 hours and sends once.
        'Idempotency-Key': `signin-${args.purpose}-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ from: SIGNIN_FROM, to: [args.to], reply_to: SIGNIN_REPLY_TO, subject, text, html }),
    },
    {
      label: '[signin-email]',
      onGiveUp: (error, { retried, why }) => {
        const status = error instanceof HttpStatusError ? `status ${error.status}` : 'no answer';
        console.error(`[signin-email] gave up on the ${args.purpose} code for ${codeOwner(args.userId)}: ${status}, ${why} (${retried} retries)`);
      },
    }
  );
  let id = 'unknown';
  try {
    const answer = (await response.json()) as { id?: unknown };
    if (typeof answer.id === 'string') id = answer.id;
  } catch (error) {
    console.warn(`[signin-email] Resend took the ${args.purpose} code for ${codeOwner(args.userId)}, but its answer was unreadable: ${safeErrorSummary(error)}`);
  }
  console.log(`[signin-email] sent the ${args.purpose} code for ${codeOwner(args.userId)} (Resend id ${id})`);
}
