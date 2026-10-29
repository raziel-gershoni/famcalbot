// First-strong isolation (U+2068 ... U+2069): a name keeps its own direction and its place inside a
// sentence of either direction, so a Hebrew name in an English line, or a Latin name in a Hebrew one,
// never pulls the neighbouring punctuation or words across. Client-safe and pure.

/** First-strong isolation, so a Hebrew name keeps its place inside a sentence of either direction. */
export const isolate = (name: string): string => `⁨${name}⁩`;
