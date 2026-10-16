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
const HAS_TAG = new RegExp(`${TAG}|<!--`, 'i');
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
  const text = inner.replace(ANY_TAG, '').trim();
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

function htmlToPlain(html: string): string {
  const text = html
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)(?=[\s/>])[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a(?=[\s>])([^>]*)>((?:(?!<\/?a[\s>])[\s\S])*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => linkText(attrs, inner))
    .replace(/<br(?=[\s/>])[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li)\s*>/gi, '\n')
    .replace(/<li(?=[\s/>])[^>]*>/gi, '• ')
    .replace(ANY_TAG, '');
  return trimLines(decodeEntities(text).replace(/ /g, ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A Google event description as plain text. Google keeps descriptions as HTML ("Line
 * one<br>Line two", links, "&amp;"); the home shows the text and the summaries put it in
 * the prompt, so both read the same thing.
 * - <br>, </p>, </li> and </div> become a newline, <li> becomes "• ";
 * - <a href=u>t</a> becomes "t (u)", or u when the text is the address;
 * - other tags go (a <style> or <script> block with its content), entities are decoded;
 * - runs of blank lines collapse to one, and the ends are trimmed.
 * A tag is an HTML element's (TAG_NAMES): "<https://…>" or "<dana@corp.com>" is text.
 * Text with no tags and no entities passes through unchanged. The result is cut at `max`
 * code points, so an emoji is never split. A missing description is ''.
 */
export function htmlToText(s: string | null | undefined, max = 500): string {
  if (!s) return '';
  const text = HAS_TAG.test(s) || HAS_ENTITY.test(s) ? htmlToPlain(s) : s;
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join('') : text;
}
