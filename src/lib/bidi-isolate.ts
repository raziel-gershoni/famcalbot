// Unicode bidi isolates for plain text that has no <bdi> (a Telegram message): a value that reads left to right (a
// phone, an ID number, an email) keeps its own order inside a right-to-left line, so "+972-50-…" never shows its "+" on
// the far side. An isolate leaves the text around it alone (W3C, "Inline markup and bidirectional text"). Client-safe:
// no import. The site draws the same values in <bdi> (components/site/LegalInline.tsx).

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE: a value that is always left to right. */
export function isolateLtr(text: string): string {
  return `⁦${text}⁩`;
}

/** U+2068 FIRST STRONG ISOLATE … U+2069: a value whose own first letter sets its direction (an address, in Hebrew or not). */
export function isolateAuto(text: string): string {
  return `⁨${text}⁩`;
}
