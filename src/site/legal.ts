// The Privacy and Terms pages' dates, their block format and the inline marks their text uses (spec
// 2026-10-28-public-website §7.3): each page shows a real "last updated" date, the day its text last changed.
// Client-safe: no import.

/** The day each page's text last changed (yyyy-MM-dd). Change it with the text. */
export const LEGAL_UPDATED = { privacy: '2026-10-29', terms: '2026-10-29' } as const;

export type LegalDoc = keyof typeof LEGAL_UPDATED;

/** A list item: a line, or a line with a list under it (and paragraphs after that list, inside the same item). */
export type LegalItem = string | { text: string; items: LegalItem[]; after?: string[] };

/** A block: a paragraph (a string), a bulleted list (an array), or a sub-heading, with an id to link to where given. */
export type LegalBlock = string | LegalItem[] | { title: string; id?: string };

/** A section of a legal page as messages hold it: its heading (the text's `##`), then its blocks. */
export interface LegalSection {
  heading: string;
  blocks: LegalBlock[];
}

/**
 * The arguments a legal string may carry, in ICU's syntax (`{phone}`): the seller's details (src/lib/seller.ts), filled
 * by the page. The strings are read raw, so ICU's quotes and tags don't apply ("FamCal · <name>" is plain text).
 */
export const SELLER_ARGS = ['sellerName', 'idNumber', 'postalAddress', 'phone', 'email'] as const;
export type SellerArg = (typeof SELLER_ARGS)[number];

/** A web address, an email address or a t.me link in plain text: what a legal paragraph links. */
const LINKABLE = /(https:\/\/[^\s)]+[^\s).,;:]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|t\.me\/[\w?=/]+)/g;

/** A paragraph's text cut into plain parts and links (`href` set), so the page can link them. */
export function linkParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(LINKABLE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    const found = m[0];
    const href = found.includes('@') && !found.startsWith('http') ? `mailto:${found}` : found.startsWith('t.me/') ? `https://${found}` : found;
    parts.push({ text: found, href });
    last = at + found.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** One piece of a legal string, as the page draws it. */
export type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  /** `address`: the words are the address itself (kept left to right); otherwise words that name it. */
  | { kind: 'link'; text: string; href: string; address: boolean }
  /** A bot command (/paysupport): plain text, kept left to right, never a link. */
  | { kind: 'command'; text: string }
  | { kind: 'arg'; name: SellerArg };

/** The marks a legal string may use: **bold**, `code`, [words](href) and {sellerArg}. */
const MARKS = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\{(\w+)\}/g;
/** A bot command in running text: a slash and a word, not inside a path or an address. */
const COMMAND = /(?<![\p{L}\p{N}_/.:@-])\/[a-z][a-z_]*(?![\p{L}\p{N}_/])/gu;

function plainParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  for (const piece of linkParts(text)) {
    if (piece.href) {
      parts.push({ kind: 'link', text: piece.text, href: piece.href, address: true });
      continue;
    }
    let last = 0;
    for (const m of piece.text.matchAll(COMMAND)) {
      const at = m.index ?? 0;
      if (at > last) parts.push({ kind: 'text', text: piece.text.slice(last, at) });
      parts.push({ kind: 'command', text: m[0] });
      last = at + m[0].length;
    }
    if (last < piece.text.length) parts.push({ kind: 'text', text: piece.text.slice(last) });
  }
  return parts;
}

/**
 * A legal string cut into what the page draws: plain text, bold, code, links (marked ones, and web and email addresses
 * in the text), bot commands and the seller's arguments. Throws on an argument that isn't one of SELLER_ARGS.
 */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKS)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(...plainParts(text.slice(last, at)));
    const [, strong, code, words, href, arg] = m;
    if (strong !== undefined) parts.push({ kind: 'strong', text: strong });
    else if (code !== undefined) parts.push({ kind: 'code', text: code });
    else if (words !== undefined) parts.push({ kind: 'link', text: words, href, address: false });
    else {
      if (!(SELLER_ARGS as readonly string[]).includes(arg)) throw new Error(`legal text: {${arg}} is not a seller argument`);
      parts.push({ kind: 'arg', name: arg as SellerArg });
    }
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(...plainParts(text.slice(last)));
  return parts;
}
