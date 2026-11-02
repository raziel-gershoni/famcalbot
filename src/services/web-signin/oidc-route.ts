/**
 * The shared steps of the Telegram and Google sign-in routes (spec §3): the start (a redirect to the provider, with the
 * one-time checks kept for this browser) and the callback (the checks, then the route's own lookup of the account).
 *
 * The callback clears the famcal_signin cookie on every answer but two (no flow of its kind under the cookie, and a state
 * that differs: both leave this browser's current sign-in to finish, see handleOidcCallback), and never lets an error out of the route: Next would report it with the
 * callback URL, whose query holds the code and the state. Every refusal logs why, never a value.
 */

import { NextRequest, NextResponse } from 'next/server';
import { captureError } from '../../lib/error-capture';
import { matchesSecret } from '../../lib/secret-compare';
import { signInPageUrl, type SignInStatus } from '../../lib/web-session';
import { VALID_LOCALES, localeFromAcceptLanguage, type Locale } from '../../utils/locale';
import { clearFlowCookie, startFlow, takeFlow, type OidcFlow } from './flow';
import {
  authorizationUrl,
  describeOidcError,
  finishAuthorization,
  newOidcChecks,
  providerConfigured,
  redirectUri,
  type GoogleClaims,
  type OidcProvider,
  type TelegramClaims,
} from './oidc';

type ClaimsOf<P extends OidcProvider> = P extends 'telegram' ? TelegramClaims : GoogleClaims;

/** The page's language when it is one of ours, else the browser's. */
export function requestLocale(request: NextRequest, given?: string | null): Locale {
  return given && (VALID_LOCALES as readonly string[]).includes(given) ? (given as Locale) : localeFromAcceptLanguage(request.headers.get('accept-language'));
}

const toSignIn = (locale: string, status?: SignInStatus) => NextResponse.redirect(signInPageUrl(locale, status));

/** A provider's OAuth error word (`access_denied`) for a log line; anything else is not echoed (the link is anyone's to craft). */
const loggable = (word: string) => (/^[a-z_]{1,40}$/.test(word) ? word : 'unrecognised');

/**
 * GET /api/auth/<provider>/start?locale=: a fresh state, nonce and PKCE verifier, kept for this browser for 10 minutes
 * (startFlow), then the provider's page. A way that isn't set up yet, or a provider that can't be reached, goes back to
 * /signin with its status.
 */
export async function startOidcSignIn(provider: OidcProvider, request: NextRequest): Promise<NextResponse> {
  const locale = requestLocale(request, request.nextUrl.searchParams.get('locale'));
  if (!providerConfigured(provider)) {
    console.warn(`[signin] ${provider} sign-in was started but is not set up`);
    return toSignIn(locale, 'unavailable');
  }
  try {
    const checks = newOidcChecks();
    const response = NextResponse.redirect(await authorizationUrl(provider, checks));
    await startFlow(response, { kind: provider, ...checks, locale });
    return response;
  } catch (error) {
    captureError(new Error(`${provider} sign-in could not start: ${describeOidcError(error)}`), 'signin-oidc', { service: 'web-signin', provider });
    return toSignIn(locale, 'failed');
  }
}

/**
 * GET /api/auth/<provider>/callback: the flow this browser started (one use: takeFlow), its state, then the code
 * exchange and the id_token's checks (finishAuthorization). `onClaims` turns the proved identity into the response;
 * its result gets the flow cookie cleared like every other answer here.
 *
 * - no flow for this browser (no cookie, used, older than 10 minutes, or another kind): status=restart, with no request
 *   to the provider, and the cookie left alone (a flow of another kind is another tab's sign-in, which still finishes);
 * - a state that differs from the flow this browser holds (the answer of an older sign-in: a second one was started here
 *   since, say in another tab): status=restart, no request to the provider, and the flow just taken is put back under a
 *   new id with the new cookie on the answer, so the newer sign-in still finishes;
 * - the provider came back with `error` (the person cancelled, or refused): the plain /signin page, logged by the error
 *   word, not reported (it is not a failure of ours);
 * - a refused exchange or id_token: status=failed, reported to Sentry as a warning by error class and claim name.
 *
 * `kinds` is the list of flow kinds this callback accepts (takeFlow leaves a flow of another kind alone).
 */
export async function handleOidcCallback<P extends OidcProvider>(
  provider: P,
  request: NextRequest,
  kinds: OidcFlow['kind'][],
  onClaims: (claims: ClaimsOf<P>, flow: OidcFlow) => Promise<NextResponse>,
): Promise<NextResponse> {
  let locale: string = requestLocale(request);
  const done = (response: NextResponse) => {
    clearFlowCookie(response);
    return response;
  };
  try {
    const flow = await takeFlow(request, kinds);
    if (!flow || flow.kind === 'email') {
      console.warn(`[signin] ${provider} callback with no sign-in started in this browser; asked to start again`);
      // The cookie is left as it is: it may name this browser's newer sign-in of another way (another tab's Google,
      // Telegram or email sign-in, which takeFlow left alone), and a dead one ends by itself in 10 minutes.
      return toSignIn(locale, 'restart');
    }
    locale = flow.locale;
    if (!matchesSecret(request.nextUrl.searchParams.get('state'), flow.state)) {
      console.warn(`[signin] ${provider} callback state differs from this browser's current sign-in; asked to start again`);
      // takeFlow used the flow up (GETDEL), but it is this browser's current one and the answer is an older sign-in's:
      // keep it, under a new id, so the sign-in the person is in the middle of can still finish.
      const restart = toSignIn(locale, 'restart');
      await startFlow(restart, flow);
      return restart;
    }
    if (request.nextUrl.searchParams.has('error')) {
      console.warn(`[signin] ${provider} came back without a code (${loggable(request.nextUrl.searchParams.get('error') ?? '')})`);
      return done(toSignIn(locale));
    }
    const callbackUrl = new URL(redirectUri(provider));
    callbackUrl.search = request.nextUrl.search;
    let claims: ClaimsOf<P>;
    try {
      claims = (await finishAuthorization(provider, callbackUrl, flow)) as ClaimsOf<P>;
    } catch (error) {
      captureError(new Error(`${provider} sign-in refused: ${describeOidcError(error)}`), 'signin-oidc', { service: 'web-signin', provider }, 'warning');
      return done(toSignIn(locale, 'failed'));
    }
    return done(await onClaims(claims, flow));
  } catch (error) {
    captureError(new Error(`${provider} sign-in callback failed: ${describeOidcError(error)}`), 'signin-oidc', { service: 'web-signin', provider });
    return done(toSignIn(locale, 'failed'));
  }
}
