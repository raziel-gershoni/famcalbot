// Which Google account a token belongs to (google-sync spec §2 googleAccount, §4 Another
// Google account).
//
// FamCal's consent asks only for calendar scopes: no openid or email, so Google's token
// response carries no id_token and there is no `sub` to read. Adding openid would change
// the consent screen for everyone. Instead the account is the id of its primary calendar:
// calendars.get with the 'primary' keyword, which calendar.readonly (held since connect)
// allows. Google documents that this id "usually matches the user's primary email
// address"; FamCal only compares it for equality (the copy's account against the token's),
// and never logs it, since it is an address.

import { googleFetch } from '../google-retry';

const PRIMARY_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary?fields=id';

/**
 * The account of an access token: its primary calendar's id. Throws on any failure (the
 * caller logs it with the user id and decides what an unknown account means). No timeout
 * of its own: the request ends at Google's or the platform's ceiling. The request goes
 * through the one Google retry policy (googleFetch: a rate limit or a 5xx is retried, and
 * Retry-After honoured); what still fails is thrown with Google's headers on its response, so
 * retryAfterMs reads the wait Google asked for.
 */
export async function googleAccountOf(accessToken: string): Promise<string> {
  let res: Response;
  try {
    res = await googleFetch(PRIMARY_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    // No answer at all (native fetch rejects with TypeError('fetch failed'), the cause carrying
    // the network code): a string code and no response, which classifyGoogleError counts as
    // transient, so the run ends for the next tick instead of reading it as the token.
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    const code = typeof cause?.code === 'string' ? cause.code : 'FETCH_FAILED';
    throw Object.assign(new Error(`calendars.get(primary) got no answer: ${error instanceof Error ? error.message : String(error)} (${code})`), { code, cause: error });
  }
  if (!res.ok) {
    // The status and Google's error body ride on the error as the API client shapes them
    // (response: { status, data, headers }, the headers as gaxios keeps them: a plain object with
    // lowercase keys), so classifyGoogleError and isGoogleRateLimit read the 403's
    // reasons too: usageLimits (rateLimitExceeded, userRateLimitExceeded) is a rate limit,
    // insufficientPermissions a missing scope; 401 is the token, 429 a rate limit, 5xx transient.
    const data = await errorBody(res);
    const headers = Object.fromEntries(res.headers.entries());
    throw Object.assign(new Error(`calendars.get(primary) answered HTTP ${res.status}`), { status: res.status, response: { status: res.status, data, headers } });
  }
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== 'string' || body.id === '') throw new Error('calendars.get(primary) answered with no id');
  return body.id;
}

/** Google's JSON error body ({ error: { code, message, errors: [{ domain, reason }] } }), or null when it isn't JSON. */
async function errorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    console.warn(`[google-sync] calendars.get(primary) answered HTTP ${res.status} with a body that isn't JSON`, error instanceof Error ? error.message : error);
    return null;
  }
}
