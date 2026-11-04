// A pair invite's token as it rides a sign-in (web sign-up spec 2026-11-03 §3.7): 64 lowercase hex characters, as
// pairing-service's createInvite makes it (32 random bytes). Anything else is no invite and is dropped, so a crafted
// value never reaches a flow record or a landing URL. Client-safe: no import (the invite page builds its /signin link
// with it; the sign-in page, the start routes and the flow records read with it).

const INVITE_TOKEN = /^[0-9a-f]{64}$/;

/** The token when it is one, else null. */
export function cleanInviteToken(input: unknown): string | null {
  return typeof input === 'string' && INVITE_TOKEN.test(input) ? input : null;
}
