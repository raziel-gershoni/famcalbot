// Hebrew for satori, which lays text out left to right and knows no bidi (the summary card, the site's share image):
// a line is broken where a browser would break it first, then each line is reordered into visual order (bidi-js).
// Other languages pass through, broken the same way.

import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

/** Logical-order Hebrew as satori must draw it: in visual order. Other languages as they are. */
export function toVisualOrder(text: string, lang: string): string {
  if (lang !== 'he') return text;
  try {
    const embeddingLevels = bidi.getEmbeddingLevels(text, 'rtl');
    return bidi.getReorderedString(text, embeddingLevels);
  } catch (error) {
    console.error('[bidi] could not reorder a Hebrew line; drawing it in logical order:', error);
    return text;
  }
}

/**
 * Pre-break long lines at word boundaries, then bidi each segment.
 * Simulates what browsers do: line-break first, then apply bidi per visual line.
 * Short lines pass through untouched.
 */
export function wrapAndBidi(text: string, lang: string, maxChars: number): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= maxChars) return toVisualOrder(line, lang);
      const words = line.split(' ');
      const segments: string[] = [];
      let current = '';
      for (const word of words) {
        if (current && current.length + 1 + word.length > maxChars) {
          segments.push(toVisualOrder(current, lang));
          current = word;
        } else {
          current = current ? current + ' ' + word : word;
        }
      }
      if (current) segments.push(toVisualOrder(current, lang));
      return segments.join('\n');
    })
    .join('\n');
}
