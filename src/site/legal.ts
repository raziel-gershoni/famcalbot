// The Privacy and Terms pages' dates and their small text helpers (spec 2026-10-28-public-website §7.3): each page shows
// a real "last updated" date, the day its text last changed. Client-safe: no import.

/** The day each page's text last changed (yyyy-MM-dd). Change it with the text. */
export const LEGAL_UPDATED = { privacy: '2026-10-29', terms: '2026-10-29' } as const;

export type LegalDoc = keyof typeof LEGAL_UPDATED;

/** A section of a legal page as messages hold it: its heading, then blocks, each a paragraph or a list of items. */
export interface LegalSection {
  heading: string;
  blocks: (string | string[])[];
}

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
