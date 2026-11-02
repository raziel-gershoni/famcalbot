/**
 * Email addresses for sign-in (web sign-in spec §3, "Email"): the one form an address is stored, looked up and limited
 * in, its keyed hash for Redis keys, and the masked form the chat notices show.
 *
 * An address is accepted only as ASCII after trimming; an internationalised domain is turned into punycode first.
 * Lower-casing is done on ASCII letters only, after the ASCII check: String.prototype.toLowerCase folds the Kelvin sign
 * (U+212A) into "k", and IDNA folds it, a full-width dot and others into ASCII, so "danK@gmail.com" would otherwise
 * become someone else's "dank@gmail.com". An IDN is accepted only when its punycode converts back to exactly what was
 * typed. Anything else is null, which the routes answer with the same words as any other address.
 */

import crypto from 'crypto';
import { domainToASCII, domainToUnicode } from 'url';
import { appKey } from '../../lib/app-keys';

const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
/** Printable ASCII, no space. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** RFC 5322's dot-atom, lower case: no quoted local parts, no leading, trailing or double dot. */
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
/** A DNS label: letters, digits and hyphens, 1 to 63, not starting or ending with a hyphen. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** The top label: letters, or punycode. */
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Upper-case ASCII letters lower-cased, and nothing else touched. */
const lowerAscii = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The domain in ASCII (punycode for an IDN), lower case, or null. */
function asciiDomain(typed: string): string | null {
  if (typed.length === 0) return null;
  const lowered = lowerAscii(typed);
  let domain = lowered;
  if (!PRINTABLE_ASCII.test(lowered)) {
    domain = domainToASCII(lowered);
    if (!domain || domainToUnicode(domain) !== lowered) return null;
  }
  if (domain.length > MAX_DOMAIN) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TOP_LABEL.test(labels[labels.length - 1])) return null;
  return domain;
}

/** The address as FamCal stores and compares it (`local@domain`, ASCII, lower case), or null for anything else. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_ADDRESS) return null;
  const at = text.indexOf('@');
  if (at <= 0 || at !== text.lastIndexOf('@')) return null;
  const typedLocal = text.slice(0, at);
  // ASCII before any case folding, so no character folds into another address
  if (!PRINTABLE_ASCII.test(typedLocal)) return null;
  const local = lowerAscii(typedLocal);
  if (local.length > MAX_LOCAL || !LOCAL_PART.test(local)) return null;
  const domain = asciiDomain(text.slice(at + 1));
  if (!domain) return null;
  const address = `${local}@${domain}`;
  return address.length <= MAX_ADDRESS ? address : null;
}

/** What a sign-in hash is of: an email address, a client address, an account, or a code bound to its address. */
export type SigninHashLabel = 'email' | 'ip' | 'account' | 'code';

/**
 * HMAC-SHA256 under the 'signin' key (from SESSION_SECRET, app-keys.ts) of `<label>:<value>`, hex, 32 characters.
 * Redis keys and stored values hold this, never the address, the IP or the code. Throws when SESSION_SECRET is unset
 * (appKey reports that once): sign-in can't run without it.
 */
export function signinHash(label: SigninHashLabel, value: string): string {
  const key = appKey('signin');
  if (!key) throw new Error('SESSION_SECRET is not set: no sign-in key');
  return crypto.createHmac('sha256', key).update(`${label}:${value}`).digest('hex').slice(0, 32);
}

/** The keyed hash of a normalised address: the id its limits, codes and flows are kept under. */
export function emailKey(normalized: string): string {
  return signinHash('email', normalized);
}

/** The address as the chat notices show it: "dana@gmail.com" → "d•••@gmail.com". */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${address[0]}•••${address.slice(at)}`;
}
