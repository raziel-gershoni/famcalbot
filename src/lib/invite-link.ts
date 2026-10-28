/**
 * The pair invite's Telegram link: t.me/<bot>?start=<param>, read back by /start
 * (src/services/telegram/commands.ts).
 *
 * Telegram's start parameter holds at most 64 base64url characters (core.telegram.org/api/links).
 * An invite token is 64 hex characters, so "invite_" plus the token is 71: Telegram drops such a
 * parameter and opens a bare chat with the bot, and the invite is never accepted. The link carries
 * the token's 32 bytes as base64url instead (43 characters, 50 with the prefix), and /start turns
 * them back into the hex token, so the stored token, the web link and WhatsApp's "accept <token>"
 * are unchanged.
 */

const PREFIX = 'invite_';
const START_PARAM = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_TOKEN = /^[0-9a-f]{64}$/;
const PACKED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The start parameter for an invite token, or null (logged) when it cannot fit Telegram's rule. */
export function inviteStartParam(token: string): string | null {
  const payload = HEX_TOKEN.test(token) ? Buffer.from(token, 'hex').toString('base64url') : token;
  const param = `${PREFIX}${payload}`;
  if (!START_PARAM.test(param)) {
    console.error(`[pairing] an invite token cannot ride a Telegram start link: ${param.length} characters`);
    return null;
  }
  return param;
}

/** The invite token in a /start parameter's text after "invite_": a packed one is unpacked, anything else is taken as it is. */
export function inviteTokenFromStart(payload: string): string {
  return PACKED_TOKEN.test(payload) ? Buffer.from(payload, 'base64url').toString('hex') : payload;
}
