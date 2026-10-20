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

const PRIMARY_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary?fields=id';

/**
 * The account of an access token: its primary calendar's id. Throws on any failure (the
 * caller logs it with the user id and decides what an unknown account means). No timeout
 * of its own: the request ends at Google's or the platform's ceiling.
 */
export async function googleAccountOf(accessToken: string): Promise<string> {
  const res = await fetch(PRIMARY_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  // The status rides on the error, so classifyGoogleError sorts it (401 token, 429 rate limit, 5xx transient).
  if (!res.ok) throw Object.assign(new Error(`calendars.get(primary) answered HTTP ${res.status}`), { status: res.status });
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== 'string' || body.id === '') throw new Error('calendars.get(primary) answered with no id');
  return body.id;
}
