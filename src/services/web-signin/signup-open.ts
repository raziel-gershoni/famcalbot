/**
 * Whether a new person can create an account on this server, and with which ways (web sign-up spec §2.1, §2.4, §2.10,
 * §2.16): the one condition that /signin's words, the start buttons' "Use in the browser" and the Google callback's
 * sign-up all read, so no page offers what the server won't do.
 * - Google: Google sign-in set up (providerConfigured) and email sending (emailConfigured). An account made on
 *   famcal.bot has no chat, so its security notices go only by email; with no Resend none could reach it.
 * - Email: email sending and Cloudflare Turnstile (turnstileConfigured).
 * Read from the environment on every call: no database, no Redis, no request. A static page (the landing, a blog post)
 * reads it when it is built, so it follows a variable change on the redeploy that change brings.
 */

import { signInHref, signUpWays, type SignUpWays } from '../../site/signin';
import { emailConfigured } from './email-send';
import { providerConfigured } from './oidc';
import { turnstileConfigured } from './turnstile';

/** Whether a new person can sign up with this way here. */
export function signUpOpen(way: 'google' | 'email'): boolean {
  if (!emailConfigured()) return false;
  return way === 'google' ? providerConfigured('google') : turnstileConfigured();
}

/** The ways open for sign-up (the words /signin uses for "New to FamCal?"), or null when none is. */
export function openSignUpWays(): SignUpWays | null {
  return signUpWays(signUpOpen('google'), signUpOpen('email'));
}

/** "Use in the browser"'s address on the start buttons: /signin in the page's language while sign-up is open, else none (the button is not drawn). */
export function browserStartHref(locale: string): string | undefined {
  return openSignUpWays() ? signInHref(locale) : undefined;
}
