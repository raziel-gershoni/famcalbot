/**
 * HTML escaping for Telegram's parse_mode 'HTML'. Every user-supplied string (titles,
 * names, places) goes through escapeHtml before it is put into a message. Also
 * htmlToText, which reads a Google event description (HTML) as plain text.
 *
 * A leaf module with no imports, so the cron passes (event alerts, native reminder
 * pings) can escape text without loading the voice confirmation chain.
 */

/** Escapes &, < and > for parse_mode 'HTML'. A missing value (a create with no title) is ''. */
export function escapeHtml(text: string | null | undefined): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A message template with its {placeholders} filled in one pass, each value escaped for parse_mode 'HTML'. One pass, so a
 * value that contains "{name}" is never filled again, and a function replacement, so "$&" or "$'" in a value stays text.
 * A placeholder with no value is left as written.
 */
export function fillHtml(template: string, values: Record<string, string | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? escapeHtml(values[key]) : whole));
}

/** The named entities Google descriptions use; anything else is left as written. */
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
  ['ndash', '–'], ['mdash', '—'], ['hellip', '…'], ['bull', '•'], ['middot', '·'],
  ['lsquo', '‘'], ['rsquo', '’'], ['ldquo', '“'], ['rdquo', '”'], ['laquo', '«'], ['raquo', '»'],
  ['copy', '©'], ['reg', '®'], ['trade', '™'], ['euro', '€'], ['deg', '°'], ['times', '×'], ['shy', ''],
]);
const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
/**
 * The elements descriptions are written with: Google's editor and its <html-blob>
 * wrapper, Outlook and Teams invites (Word's <o:p> too), pasted web text. Only these are
 * tags, and only where the name ends (a space, "/" or ">"), so the "<https://…>",
 * "<dana@corp.com>" and "<b.levi@corp.com>" of a plain-text invite, or a "<Back>", are text.
 */
const TAG_NAMES = [
  'a', 'abbr', 'b', 'big', 'blockquote', 'body', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h[1-6]', 'head', 'hr', 'html', 'html-blob', 'i', 'img', 'ins',
  'kbd', 'li', 'mark', 'meta', 'o:p', 'ol', 'p', 'pre', 'q', 's', 'samp', 'script', 'small', 'span', 'strike',
  'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'tt', 'u', 'ul', 'wbr',
].join('|');
/** One tag, opening or closing, any case: a TAG_NAMES name, then its attributes up to ">". */
const TAG = `</?(?:${TAG_NAMES})(?=[\\s/>])[^>]*>`;
const HAS_TAG = new RegExp(TAG, 'i');
const HAS_ENTITY = new RegExp(`&(?:#\\d{1,7}|#[xX][0-9a-fA-F]{1,6}|${[...NAMED_ENTITIES.keys()].join('|')});`);
const ANY_TAG = new RegExp(TAG, 'gi');

/** Decodes each entity once, so '&amp;lt;' is '&lt;'. Unknown names and invalid code points stay. */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body) ?? whole;
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/** An <a> as text: "t (u)", or u alone when the text is the address (mailto:/tel: aside). */
function linkText(attrs: string, inner: string): string {
  const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
  const text = replaceTag(inner, ANY_TAG, '').trim();
  if (!url) return text;
  const shownText = decodeEntities(text);
  const shownUrl = decodeEntities(url);
  if (!shownText || shownText === shownUrl) return url;
  if (shownText === shownUrl.replace(/^(?:mailto|tel):/i, '')) return text;
  // Raw text and address: decodeEntities runs once on the whole result.
  return `${text} (${url})`;
}

/** The start or end of the text, or one of JavaScript's line breaks (the m flag's ^ and $). */
function isLineEdge(c: string | undefined): boolean {
  return c === undefined || c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

/**
 * Drops each run of spaces and tabs that starts or ends a line, keeps the rest. One
 * linear pass: /[ \t]+$/gm retries every start inside a run, so one long run inside a
 * line cost the square of its length (8,192 spaces took 140 ms).
 */
function trimLines(text: string): string {
  return text.replace(/[ \t]+/g, (run: string, at: number) =>
    isLineEdge(text[at - 1]) || isLineEdge(text[at + run.length]) ? '' : run,
  );
}

/**
 * text.replace(pattern, by) for a tag pattern (a name, then [^>]*>). A match ends at the
 * first ">" after its start, so only the text through the last ">" can match; the rest is
 * kept as is. On the whole text, every "<b " with no ">" after it read to the end again
 * (a 32K description of them took 160 ms).
 */
function replaceTag(text: string, pattern: RegExp, by: string): string {
  const end = text.lastIndexOf('>') + 1;
  return text.slice(0, end).replace(pattern, by) + text.slice(end);
}

/**
 * Whether there is a comment or a tag to read. A tag ends at a ">", so only the text
 * through the last one is tested. The value is read as text once, as a regex test reads
 * it, so a value cast past the string type (a number) is read as before, not thrown on.
 */
function hasTag(value: string): boolean {
  const s = `${value}`;
  return s.includes('<!--') || HAS_TAG.test(s.slice(0, s.lastIndexOf('>') + 1));
}

/**
 * Drops each <!--…-->, which the first "-->" after it ends. Once one has no "-->" after
 * it, no later one has either, so the scan stops there; /<!--[\s\S]*?-->/g read to the
 * end again from every later "<!--".
 */
function dropComments(text: string): string {
  let out = '';
  let from = 0;
  for (let open = text.indexOf('<!--'); open >= 0; open = text.indexOf('<!--', from)) {
    const close = text.indexOf('-->', open + 4);
    if (close < 0) break;
    out += text.slice(from, open);
    from = close + 3;
  }
  return out + text.slice(from);
}

/**
 * Drops each <script> and <style> block with its content: from the open to the first
 * closer of its name (any case) after the open's ">". Once a name has no closer there, no
 * later open of it can close, so those are skipped; the regex this replaces,
 * /<(script|style)(?=[\s/>])[^>]*>[\s\S]*?<\/\1\s*>/gi, read to the end from each.
 */
function dropBlocks(text: string): string {
  const opens = /<(script|style)(?=[\s/>])/gi;
  const closers: Record<string, RegExp> = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };
  const unclosed = new Set<string>();
  let out = '';
  let from = 0;
  for (let open = opens.exec(text); open; open = opens.exec(text)) {
    const name = open[1].toLowerCase();
    if (unclosed.has(name)) continue;
    const gt = text.indexOf('>', opens.lastIndex);
    if (gt < 0) break; // no ">" after it, nor after any later open
    const closer = closers[name];
    closer.lastIndex = gt + 1;
    if (!closer.exec(text)) {
      unclosed.add(name);
      continue;
    }
    out += text.slice(from, open.index);
    from = opens.lastIndex = closer.lastIndex;
  }
  return out + text.slice(from);
}

/**
 * Replaces each <a …>…</a> with its linkText. A link's text may not cross an "<a" or
 * "</a" (then a space or ">"), and its closer is one, so the link closes only if the first
 * of these edges after the open's ">" is a closer. Every open before that ">" ends at it
 * too and fails the same way, so the scan resumes past it; the regex this replaces,
 * /<a(?=[\s>])([^>]*)>((?:(?!<\/?a[\s>])[\s\S])*?)<\/a\s*>/gi, read to the edge from each.
 */
function replaceLinks(text: string): string {
  const opens = /<a(?=[\s>])/gi;
  const edges = /<\/?a[\s>]/gi;
  const closer = /<\/a\s*>/iy;
  let out = '';
  let from = 0;
  for (let open = opens.exec(text); open; open = opens.exec(text)) {
    const gt = text.indexOf('>', open.index + 2);
    if (gt < 0) break; // no ">" after it, nor after any later open
    edges.lastIndex = gt + 1;
    const edge = edges.exec(text);
    if (!edge) break; // an open is an edge too, so no open follows
    closer.lastIndex = edge.index;
    if (!closer.test(text)) {
      opens.lastIndex = gt + 1;
      continue;
    }
    out += text.slice(from, open.index) + linkText(text.slice(open.index + 2, gt), text.slice(gt + 1, edge.index));
    from = opens.lastIndex = closer.lastIndex;
  }
  return out + text.slice(from);
}

/**
 * A run of spaces, tabs, line breaks and block marks (\u0001) as htmlToPlain leaves it: a
 * run with a block mark becomes as many line breaks as it held, and at least one, so the
 * words on either side of a mark never run together and a block adds a line break only
 * where the run has none. A run without a mark stays. Entities are decoded later, so an
 * encoded break (&#10;) is text here.
 */
function breakBlocks(run: string): string {
  return run.includes('\u0001') ? '\n'.repeat(Math.max(1, run.split('\n').length - 1)) : run;
}

/**
 * Outlook's, Teams' and pasted web text's blocks, which start and end a line: headings,
 * paragraphs and divs where they open, tables and their rows, lists, quotes, <pre>, <hr>.
 */
const BLOCK_TAG = /<\/?(?:h[1-6]|table|tr|ul|ol|blockquote|pre)(?=[\s/>])[^>]*>|<(?:p|div|hr)(?=[\s/>])[^>]*>/gi;

function htmlToPlain(html: string): string {
  const linked = replaceLinks(dropBlocks(dropComments(html.replace(/[\u0001\u0002]/g, '').replace(/\r\n?/g, '\n'))));
  const lined = replaceTag(linked, /<br(?=[\s/>])[^>]*>/gi, '\n').replace(/<\/(?:p|div|li)\s*>/gi, '\n');
  // A list item starts a line (\u0001, a block mark) with its bullet (\u0002, written below).
  const listed = replaceTag(lined, /<li(?=[\s/>])[^>]*>/gi, '\u0001\u0002');
  // A block starts and ends a line; a table cell is set apart by a space.
  const celled = replaceTag(replaceTag(listed, BLOCK_TAG, '\u0001'), /<t[dh](?=[\s/>])[^>]*>/gi, ' ');
  const text = replaceTag(celled, ANY_TAG, '')
    // A bullet keeps its item on its line, past the item's own <p> or spaces.
    .replace(/\u0002[ \t\u0001]*/g, '\u0002')
    .replace(/[ \t\n\u0001]+/g, breakBlocks)
    .replace(/\u0002/g, '• ');
  return trimLines(decodeEntities(text).replace(/\u00a0/g, ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A Google event description as plain text. Google keeps descriptions as HTML ("Line
 * one<br>Line two", links, "&amp;"); the home shows the text and the summaries put it in
 * the prompt, so both read the same thing.
 * - <br>, </p>, </li> and </div> become a newline, <li> starts a line with "• ";
 * - headings, paragraphs, divs, tables and their rows, lists, quotes, <pre> and <hr>
 *   start and end a line, adding a line break only where the text has none yet (a
 *   newline, or a tag above), and a table cell is set apart by a space, so an Outlook or
 *   Teams invite's blocks don't run two words together. Not inside a link, whose text is
 *   flattened first; and an encoded break (&#10;) is decoded after, so a block next to
 *   one adds a blank line;
 * - <a href=u>t</a> becomes "t (u)", or u when the text is the address;
 * - other tags go (a <style> or <script> block with its content), entities are decoded;
 * - runs of blank lines collapse to one, and the ends are trimmed.
 * A tag is an HTML element's (TAG_NAMES): "<https://…>" or "<dana@corp.com>" is text.
 * Text with no tags and no entities passes through unchanged. The result is cut at `max`
 * code points, so an emoji is never split. A missing description is ''.
 */
export function htmlToText(s: string | null | undefined, max = 500): string {
  if (!s) return '';
  const text = hasTag(s) || HAS_ENTITY.test(s) ? htmlToPlain(s) : s;
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join('') : text;
}
