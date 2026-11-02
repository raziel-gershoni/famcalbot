/**
 * Signing in on famcal.bot with Telegram or Google (OpenID Connect): the authorization URL, and the callback's checks.
 * Spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §2.3 and §3.
 *
 * openid-client 6 (pinned exactly) does the protocol: discovery, PKCE (S256), state, nonce, and the id_token's
 * signature against the provider's published keys (enableNonRepudiationChecks), its issuer, its audience (our own
 * sign-in client id only), its expiry, and RS256 as the one algorithm accepted.
 *
 * Every request it makes goes through the repo's retry layer for that provider: Google's through googleFetch, Telegram's
 * through fetchWithRetry (CLAUDE.md). openid-client puts a 30 s timeout signal of its own on each request; repoFetch
 * drops it and the configuration's timeout is 0, so a call runs to the provider's ceiling (CLAUDE.md: no timeout of our own).
 *
 * Who the person is:
 * - Telegram: the `id` claim, the Telegram user id (sent only with the `profile` scope). Never `sub`: Telegram's sub
 *   is a different number for each bot.
 * - Google: `sub`, Google's account id. The email is a mutable attribute, verified only when Google says so.
 *
 * The configurations (discovered metadata, the cached signing keys) live on globalThis, so the route bundles share one
 * per process (Next 16 gives each bundle its own module instance). A failed discovery is not kept: the next sign-in tries again.
 *
 * Server only. No log line or Sentry field holds a claim, a token, a code, a state or a nonce: describeOidcError names
 * an error by its class, code and fixed message, and the claim it was about, never a value.
 */

import * as client from 'openid-client';
import { buildUrl, getBaseUrl } from '../../config/urls';
import { fetchWithRetry, HttpStatusError } from '../../utils/fetch-retry';
import { googleFetch } from '../google-retry';
import { googleSignInUsesCalendarClient } from './client-ids';
import type { OidcFlow } from './flow';

export type OidcProvider = 'telegram' | 'google';

/** What a Telegram sign-in proves: the Telegram user id (User.telegramId). */
export interface TelegramClaims {
  telegramId: bigint;
}

/** What a Google sign-in proves: Google's account id, and its email with whether Google verified it. */
export interface GoogleClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

const ISSUER: Record<OidcProvider, string> = {
  telegram: 'https://oauth.telegram.org',
  google: 'https://accounts.google.com',
};

/** The least each provider can give: Telegram's `profile` carries the `id` claim; Google's `email` its address. */
const SCOPE: Record<OidcProvider, string> = {
  telegram: 'openid profile',
  google: 'openid email',
};

/**
 * Seconds of clock difference allowed on exp and iat. Telegram's tokens are reported to live 30 s, so this stays
 * small; it is openid-client's default, set here so it can't drift.
 */
const CLOCK_TOLERANCE_SEC = 30;

/** A refusal of our own (not openid-client's): its reason is a fixed word, safe to log. */
class OidcRefusal extends Error {
  constructor(readonly reason: string) {
    super(`refused: ${reason}`);
    this.name = 'OidcRefusal';
  }
}

const warned = globalThis as { __famcalSigninSameClientWarned?: boolean };

/** The client id and secret, or null while the owner hasn't set them (the way then stays hidden). */
function credentials(provider: OidcProvider): { clientId: string; clientSecret: string } | null {
  const [clientId, clientSecret] =
    provider === 'telegram'
      ? [process.env.TELEGRAM_LOGIN_CLIENT_ID, process.env.TELEGRAM_LOGIN_CLIENT_SECRET]
      : [process.env.GOOGLE_SIGNIN_CLIENT_ID, process.env.GOOGLE_SIGNIN_CLIENT_SECRET];
  if (!clientId || !clientSecret) return null;
  // Sign-in has its own Google client: a token for the calendar client must never sign anyone in (spec §3).
  if (provider === 'google' && googleSignInUsesCalendarClient(clientId, process.env.GOOGLE_CLIENT_ID)) {
    if (!warned.__famcalSigninSameClientWarned) {
      warned.__famcalSigninSameClientWarned = true;
      console.warn('[signin] GOOGLE_SIGNIN_CLIENT_ID is the calendar client GOOGLE_CLIENT_ID; Google sign-in stays off until it has its own client');
    }
    return null;
  }
  return { clientId, clientSecret };
}

/** Whether this way of signing in is set up (its client id and secret are in the environment). */
export function providerConfigured(provider: OidcProvider): boolean {
  return credentials(provider) !== null;
}

/** The callback the provider sends the browser back to: from the app's base URL, never from the request's Host. */
export function redirectUri(provider: OidcProvider): string {
  return buildUrl(`/api/auth/${provider}/callback`);
}

/** A fresh state, nonce and PKCE verifier for one sign-in; the caller keeps them in the flow (startFlow). */
export function newOidcChecks(): Pick<OidcFlow, 'state' | 'nonce' | 'codeVerifier'> {
  return { state: client.randomState(), nonce: client.randomNonce(), codeVerifier: client.randomPKCECodeVerifier() };
}

/** A request's method, host and path for a log line, never its query. */
function requestOf(method: string | undefined, url: string): string {
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(url);
  return `${(method ?? 'GET').toUpperCase()} ${parts ? `${parts[1]}${parts[2]}` : '(not a URL)'}`;
}

/** Telegram is a third party with no policy of its own: the shared loop, which logs its give-up here. */
function telegramFetch(url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init, {
    label: '[signin-telegram]',
    onGiveUp: (error, info) => console.warn(`[signin-telegram] ${requestOf(init.method, url)} failed: ${describeOidcError(error)} (${info.why})`),
  });
}

/** openid-client's request, sent through the provider's retry layer, without openid-client's timeout signal. */
function repoFetch(provider: OidcProvider): client.CustomFetch {
  const send = provider === 'google' ? googleFetch : telegramFetch;
  // `signal` is left out on purpose (see the header). `body` is a form or nothing for every request made here.
  return (url, options) => send(url, { method: options.method, headers: options.headers, body: options.body as BodyInit | null | undefined, redirect: options.redirect });
}

const cache = globalThis as { __famcalOidcConfigs?: Partial<Record<OidcProvider, Promise<client.Configuration>>> };

async function discover(provider: OidcProvider, clientId: string, clientSecret: string): Promise<client.Configuration> {
  const config = await client.discovery(
    new URL(ISSUER[provider]),
    clientId,
    { client_secret: clientSecret, id_token_signed_response_alg: 'RS256', [client.clockTolerance]: CLOCK_TOLERANCE_SEC },
    client.ClientSecretPost(),
    { [client.customFetch]: repoFetch(provider) },
  );
  config.timeout = 0;
  client.enableNonRepudiationChecks(config);
  return config;
}

/** The provider's configuration: discovered once per process, and again after a failed discovery. */
function configFor(provider: OidcProvider): Promise<client.Configuration> {
  const creds = credentials(provider);
  if (!creds) return Promise.reject(new OidcRefusal('not configured'));
  const configs = (cache.__famcalOidcConfigs ??= {});
  const known = configs[provider];
  if (known) return known;
  const pending = discover(provider, creds.clientId, creds.clientSecret).catch((error: unknown) => {
    if (configs[provider] === pending) delete configs[provider];
    throw error;
  });
  configs[provider] = pending;
  return pending;
}

/** Tests only: forget the discovered configurations, as a fresh process would. */
export function __resetOidcForTests(): void {
  delete cache.__famcalOidcConfigs;
  delete warned.__famcalSigninSameClientWarned;
}

/**
 * The provider's authorization URL for one sign-in: PKCE S256, the flow's state and nonce, the least scope. Telegram
 * also gets the site's origin, which it checks against the bot's allowed URLs ("origin required" without it). Google
 * gets no include_granted_scopes and no access_type, so sign-in never carries the calendar's grant, and
 * prompt=select_account, so the person picks the account.
 */
export async function authorizationUrl(provider: OidcProvider, flow: Pick<OidcFlow, 'state' | 'nonce' | 'codeVerifier'>): Promise<URL> {
  const config = await configFor(provider);
  const params: Record<string, string> = {
    redirect_uri: redirectUri(provider),
    scope: SCOPE[provider],
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(flow.codeVerifier),
    code_challenge_method: 'S256',
  };
  if (provider === 'telegram') params.origin = new URL(getBaseUrl()).origin;
  // A family computer often has several Google accounts signed in: Google asks which one instead of taking the last used.
  if (provider === 'google') params.prompt = 'select_account';
  return client.buildAuthorizationUrl(config, params);
}

/** The largest value User.telegramId (a Postgres bigint, int64) can hold. */
const MAX_TELEGRAM_ID = BigInt('9223372036854775807');

/**
 * Telegram's user id from the `id` claim: a positive whole number that fits the column, sent as a JSON number or a
 * string of digits. One that doesn't fit is refused here, so the lookup never meets a number the database rejects.
 */
function telegramClaims(claims: client.IDToken): TelegramClaims {
  const id = claims.id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return { telegramId: BigInt(id) };
  if (typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= MAX_TELEGRAM_ID) return { telegramId: BigInt(id) };
  throw new OidcRefusal('the id_token has no Telegram user id');
}

/** Google's account id, and its email; `email_verified` counts only as true or Google's sample's string "true". */
function googleClaims(claims: client.IDToken): GoogleClaims {
  const email = typeof claims.email === 'string' && claims.email !== '' ? claims.email : null;
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return { sub: claims.sub, email, emailVerified: email !== null && verified };
}

/**
 * The callback's checks and the code exchange: the state (again; the route compares it first), the PKCE verifier,
 * the nonce, and the id_token (signature, issuer, audience, expiry, RS256). `callbackUrl` is our redirect URI with the
 * callback's query. Throws on any refusal; describe the error with describeOidcError.
 *
 * The nonce is required in the id_token for both providers (ruling R6 of the 6b plan, kept on purpose): openid-client
 * can't check a nonce only when one is there. Telegram's documentation (core.telegram.org/bots/telegram-login) lists
 * `nonce` as an optional request parameter "to be included in the resulting id_token", and we always send one. A token
 * without one is refused, and the log reads `JWT "nonce" (nonce) claim missing`. If the first live Telegram sign-in
 * shows that, drop the `expectedNonce` option for Telegram only (one line); state and PKCE still bind the browser.
 */
export async function finishAuthorization(provider: 'telegram', callbackUrl: URL, flow: OidcFlow): Promise<TelegramClaims>;
export async function finishAuthorization(provider: 'google', callbackUrl: URL, flow: OidcFlow): Promise<GoogleClaims>;
export async function finishAuthorization(provider: OidcProvider, callbackUrl: URL, flow: OidcFlow): Promise<TelegramClaims | GoogleClaims>;
export async function finishAuthorization(provider: OidcProvider, callbackUrl: URL, flow: OidcFlow): Promise<TelegramClaims | GoogleClaims> {
  const config = await configFor(provider);
  const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new OidcRefusal('no id_token');
  return provider === 'telegram' ? telegramClaims(claims) : googleClaims(claims);
}

/**
 * An error from this module, for a log line or Sentry: its class, code and fixed message, the OAuth error word and the
 * claim it was about. openid-client's messages name claims, never their values; its `cause` (which holds the claims,
 * the email among them) is never read past the claim's name.
 */
export function describeOidcError(error: unknown): string {
  if (error instanceof OidcRefusal) return error.message;
  if (error instanceof HttpStatusError) return `HTTP ${error.status}`;
  if (!(error instanceof Error)) return typeof error;
  const { code, error: word, cause } = error as { code?: unknown; error?: unknown; cause?: unknown };
  // openid-client wraps a failed request ("something went wrong"): the answer's status is the useful part.
  if (cause instanceof HttpStatusError) return `${error.name} | HTTP ${cause.status}`;
  // openid-client also wraps oauth4webapi's error, whose fixed message names the claim; that error's own cause holds
  // the claims and is read for the claim's name only.
  const inner = cause instanceof Error ? cause : error;
  const facts = (inner as { cause?: unknown }).cause;
  const claim = facts && typeof facts === 'object' ? (facts as { claim?: unknown }).claim : undefined;
  return [
    error.name,
    typeof code === 'string' ? code : null,
    typeof word === 'string' && /^[a-z_]{1,40}$/.test(word) ? word : null,
    typeof claim === 'string' && /^[a-z_]{1,20}$/.test(claim) ? `claim ${claim}` : null,
    inner.message.slice(0, 160),
  ]
    .filter(Boolean)
    .join(' | ');
}
