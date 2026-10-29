import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/src/utils/prisma';
import { getUserById } from '@/src/services/user-service';
import { localeFromAcceptLanguage, normalizeLocale, type Locale } from '@/src/utils/locale';
import { buildUrl } from '@/src/config/urls';
import { captureError } from '@/src/lib/error-capture';
import { loggable, OAUTH_RETURN_MISSING_CODE, OAUTH_RETURN_MISSING_STATE, OAUTH_STATE_PREFIX } from '@/src/lib/oauth-state';
import { createPendingGoogleToken, finishPageUrl, type GoogleGrant } from '@/src/services/google-connect';
import { GOOGLE_CONNECT_SCOPES, parseGrantedScopes } from '@/src/services/google-sync/scopes';
import { googleAccountOf } from '@/src/services/google-sync/account';
import { googleFetch } from '@/src/services/google-retry';
import { DEFAULT_BOT_USERNAME } from '@/src/lib/gate-links';
import type { UserConfig } from '@/src/types';
import { ConnectShell } from '../ConnectShell';
import { CallbackCard, type CallbackKind } from './CallbackCard';
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';
import ruMessages from '@/messages/ru.json';

const OAUTH = { en: enMessages.oauth, he: heMessages.oauth, ru: ruMessages.oauth };

interface PageProps {
  searchParams: Promise<{
    code?: string;
    state?: string;
    /** Google's own error when it came back with no code (access_denied), or missing_code (/api/refresh-token) */
    error?: string;
  }>;
}

/**
 * Where "Back to FamCal" goes from the consent browser. That browser has no Telegram initData,
 * so /refresh-token would only show its gate to a Telegram user: send them back to the
 * bot. A WhatsApp-only user may have their session cookie here. Nobody known: the bot.
 */
function retryHrefFor(user: UserConfig | null): string {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  if (!user || user.telegramId) return `https://t.me/${botUsername}?start=dashboard`;
  return `/refresh-token?user_id=${user.telegramId ?? user.id}`;
}

/**
 * The language of a card and its way back: the owner's, when the state names one; else the browser's
 * (Accept-Language), and the bot.
 */
async function readerOf(user: UserConfig | null): Promise<{ locale: Locale; retryHref: string }> {
  if (user) return { locale: normalizeLocale(user.language), retryHref: retryHrefFor(user) };
  return { locale: localeFromAcceptLanguage((await headers()).get('accept-language')), retryHref: retryHrefFor(null) };
}

/** The document's title for a card: the card's own. */
function titleOf(kind: CallbackKind, locale: Locale): string {
  const m = OAUTH[locale];
  return kind === 'exchangeFailed' ? m.exchangeFailed.title : kind === 'insufficientScopes' ? m.insufficientScopes.title : m[kind].title;
}

/** A connect that did not go through: the card in the shell (CallbackCard), in the reader's language. */
function CallbackResult({ kind, locale, retryHref }: { kind: CallbackKind; locale: Locale; retryHref: string }) {
  return (
    <ConnectShell locale={locale} namespaces={['oauth']} title={titleOf(kind, locale)}>
      <CallbackCard kind={kind} retryHref={retryHref} />
    </ConnectShell>
  );
}

/** Google's token endpoint answer, as far as the callback reads it. */
interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Why Google refused the exchange, for the log: the status, and its OAuth error and
 * description when the body has them ('HTTP 400 invalid_grant: Bad Request'). Never the code
 * or a token. null when the answer is a success.
 */
function exchangeRefusal(status: number, ok: boolean, answer: TokenAnswer | null): string | null {
  if (ok && answer && answer.error === undefined) return null;
  const error = typeof answer?.error === 'string' ? ` ${answer.error}` : '';
  const description = error && typeof answer?.error_description === 'string' ? `: ${answer.error_description}` : '';
  return `HTTP ${status}${error}${description}${answer ? '' : ' (no JSON body)'}`;
}

/**
 * The owner a state names, read only (the state stays as it is), for a card's language and way back. A lookup that
 * fails is logged and captured, and the card goes to the browser's language and the bot: it must still show.
 */
async function ownerOfState(state: unknown): Promise<UserConfig | null> {
  if (typeof state !== 'string' || !state.startsWith(OAUTH_STATE_PREFIX)) return null;
  try {
    const record = await prisma.oAuthState.findUnique({ where: { token: state } });
    return record ? await getUserById(Number(record.userId)) : null;
  } catch (error) {
    console.error('[oauth-callback] looking up the owner of a state Google came back with failed:', error instanceof Error ? error.message : String(error));
    captureError(error, 'oauth-callback-owner');
    return null;
  }
}

/**
 * The card for a Google return with no code: the person said no on Google's screen (access_denied); our own redirect
 * URI found no code or no state (an expired link); anything else is Google refusing the connection (a workplace or school
 * policy, an app it blocks).
 */
function kindOfReturn(error: string): CallbackKind {
  if (error === 'access_denied') return 'denied';
  if (error === OAUTH_RETURN_MISSING_CODE || error === OAUTH_RETURN_MISSING_STATE) return 'expired';
  return 'refused';
}

export default async function OAuthCallbackPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { code, state, error } = params;

  // Google came back without a code: the person said no on its screen (access_denied), Google refused, or our redirect
  // URI found no code or state (kindOfReturn). Nothing to exchange; the state is left as it is (it ends on its own).
  if (error !== undefined) {
    const owner = await ownerOfState(state);
    console.warn(`[oauth-callback] Google came back without a code (${loggable(String(error))}) for ${owner ? `user ${owner.id}` : 'no known user'}`);
    return <CallbackResult kind={kindOfReturn(String(error))} {...await readerOf(owner)} />;
  }

  // A link that is used up or out of date: one card for the person, the reason in the log
  const expired = async (why: string, owner: UserConfig | null = null) => {
    console.warn(`[oauth-callback] ${why}: the link has expired`);
    return <CallbackResult kind="expired" {...await readerOf(owner)} />;
  };

  // Validate state token
  if (!state || typeof state !== 'string') {
    return expired('no state');
  }

  // Only states from POST /api/oauth/start (bound to an authenticated user) are
  // honoured. An unprefixed one came from the old unauthenticated /refresh-token page.
  if (!state.startsWith(OAUTH_STATE_PREFIX)) {
    return expired('a state without the u1_ prefix');
  }

  // Look up state token in database
  const stateRecord = await prisma.oAuthState.findUnique({ where: { token: state } });

  // Validate state exists
  if (!stateRecord) {
    return expired('a state that is not there (used, or swept)');
  }

  // Use the state up (one-time use only). deleteMany checks and deletes in one statement,
  // so of two callbacks with the same state only one gets count 1; the other is refused
  // here instead of failing on a row that is already gone.
  const { count } = await prisma.oAuthState.deleteMany({ where: { id: stateRecord.id } });
  if (count !== 1) {
    return expired(`user ${stateRecord.userId}'s state, used by another callback`, await getUserById(Number(stateRecord.userId)));
  }

  // Validate state hasn't expired
  if (stateRecord.expiresAt < new Date()) {
    return expired(`user ${stateRecord.userId}'s state, past its time`, await getUserById(Number(stateRecord.userId)));
  }

  // The state holds the DB id of the user oauth/start authenticated. Resolve it before
  // talking to Google: the token can be committed on this user and no other.
  const user = await getUserById(Number(stateRecord.userId));
  if (!user) {
    return expired(`user ${stateRecord.userId} of the state is not there`);
  }
  const retryHref = retryHrefFor(user);
  const userLocale = normalizeLocale(user.language);

  // Exchange code for tokens. googleFetch retries a rate limit or a 5xx on the token endpoint
  // (the state is used up already, so a failure here is a "start again" card); a code Google
  // had redeemed before the answer was lost comes back invalid_grant, the card it would have been.
  const redirectUri = buildUrl('/api/refresh-token');
  let tokenResponse;

  try {
    tokenResponse = await googleFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
  } catch (error) {
    // The reason goes to the log and Sentry; the person gets the card
    console.error(`[oauth-callback] user ${user.id}: the code exchange threw:`, error instanceof Error ? error.message : String(error));
    captureError(error, 'oauth-token-exchange');
    return <CallbackResult kind="generic" locale={userLocale} retryHref={retryHref} />;
  }

  // Google's answer. A refusal (invalid_grant: a code used already or expired;
  // redirect_uri_mismatch; invalid_client) has no scope list, so it used to show as the
  // permissions page. It is its own card, logged with Google's reason.
  const tokens: TokenAnswer | null = await tokenResponse.json().catch((error: unknown) => {
    console.warn(`[oauth-callback] user ${user.id}: Google's token answer (HTTP ${tokenResponse.status}) isn't JSON:`, error instanceof Error ? error.message : String(error));
    return null;
  });
  const refusal = exchangeRefusal(tokenResponse.status, tokenResponse.ok, tokens);
  if (refusal || !tokens) {
    console.error(`[oauth-callback] user ${user.id}: Google refused the code exchange (${refusal})`);
    captureError(new Error(`Google refused the code exchange (${refusal})`), 'oauth-token-exchange', { user_id: user.id, purpose: stateRecord.purpose ?? 'connect' });
    return <CallbackResult kind="exchangeFailed" locale={userLocale} retryHref={retryHref} />;
  }

  // Check if all required scopes were granted. Connecting needs the two calendar scopes
  // only; a 'sync' consent's calendar.app.created may be unticked, and the copy then waits
  // in 'scopes' (google-sync spec §3).
  const grantedScopes = parseGrantedScopes(tokens.scope);
  const missingScopes = GOOGLE_CONNECT_SCOPES.filter(s => !grantedScopes.includes(s));

  if (missingScopes.length > 0) {
    console.warn(`[oauth-callback] user ${user.id}: the consent left out ${missingScopes.join(' ')}`);
    return <CallbackResult kind="insufficientScopes" locale={userLocale} retryHref={retryHref} />;
  }

  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!refreshToken) {
    // Google gave no refresh token: the person starts again from FamCal
    console.warn(`[oauth-callback] user ${user.id}: Google's answer has no refresh token`);
    return <CallbackResult kind="noRefreshToken" locale={userLocale} retryHref={retryHref} />;
  }

  // Nothing is saved here. This browser finished Google's consent, but the state only says
  // who started it, and anyone can start one and send the Google URL to someone else. So
  // the token waits in Redis until the state's owner claims it from their own Telegram or
  // WhatsApp (src/services/google-connect.ts).
  // What the commit saves with the token: the granted scopes, and for a 'sync' consent the
  // calendar to copy and the account it goes to (googleAccountOf: the token carries no id
  // token). An account Google doesn't tell stays unknown, logged; the copy still starts.
  const grant: GoogleGrant = { scopes: grantedScopes };
  if (stateRecord.purpose === 'sync' && stateRecord.nativeCalendarId) {
    let googleAccount: string | null = null;
    try {
      googleAccount = await googleAccountOf(String(tokens.access_token ?? ''));
    } catch (error) {
      console.warn(`[oauth-callback] user ${user.id}: the Google account of a sync consent is unknown:`, error instanceof Error ? error.message : String(error));
      captureError(error, 'google-sync-account', { user_id: user.id }, 'warning');
    }
    grant.sync = { nativeCalendarId: stateRecord.nativeCalendarId, googleAccount };
  }

  let pendingId: string;
  try {
    pendingId = await createPendingGoogleToken(user.id, refreshToken, grant);
  } catch (error) {
    // The reason goes to the log and Sentry; the person gets the card
    console.error(`[oauth-callback] user ${user.id}: parking the token failed:`, error instanceof Error ? error.message : String(error));
    captureError(error, 'oauth-save-token');
    return <CallbackResult kind="generic" locale={userLocale} retryHref={retryHref} />;
  }

  // The finish page, with the pendingId in the URL fragment: a reload keeps it, and it
  // never reaches a server or a Referer
  redirect(finishPageUrl(userLocale, pendingId, user));
}
