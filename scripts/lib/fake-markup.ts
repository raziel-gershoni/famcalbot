// Server markup into fake-dom nodes, so a smoke can hydrate a page the way a browser does: renderToString (what the
// server sent), these nodes (what the browser parsed), then hydrateRoot (React adopting them). A fresh createRoot mount reads
// the client's own snapshots at once and so misses what only happens while hydrating (a useSyncExternalStore that
// differs between the server and the client, with an effect that runs on the server's answer).
//
// It parses what React's server renderer writes (tags, double-quoted attributes, text, comments such as <!-- -->), not
// arbitrary HTML. scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).

import { FakeElement, FakeNode, FakeText } from './fake-dom';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** A comment node (React's <!-- --> text separators and its <!--$--> markers). */
export class FakeComment extends FakeNode {
  constructor(public data: string) {
    super(8, '#comment');
  }
  get nodeValue(): string {
    return this.data;
  }
  get textContent(): string {
    return this.data;
  }
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// <!--c-->, </tag>, <tag a="v" b>, or text; the attribute list is whitespace-separated name or name="value" pairs
const TOKEN = /<!--([\s\S]*?)-->|<\/([a-zA-Z0-9-]+)>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;

/** Appends the nodes of `html` to `container`. Throws on an end tag that closes nothing open, or a tag left open. */
export function parseMarkup(container: FakeNode, html: string): void {
  const stack: FakeNode[] = [container];
  for (const m of html.matchAll(TOKEN)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.appendChild(new FakeComment(m[1]));
    } else if (m[2]) {
      const open = stack.pop();
      if (stack.length === 0 || !(open instanceof FakeElement) || open.localName !== m[2].toLowerCase()) throw new Error(`fake-markup: </${m[2]}> closes ${open instanceof FakeElement ? `<${open.localName}>` : 'nothing'}`);
    } else if (m[3]) {
      const tag = m[3];
      const inSvg = tag === 'svg' || (top instanceof FakeElement && top.namespaceURI === SVG_NS);
      const el = new FakeElement(inSvg ? tag : tag.toLowerCase(), inSvg ? SVG_NS : HTML_NS);
      for (const a of m[4].matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] ?? ''));
      top.appendChild(el);
      if (!m[5] && !VOID.has(tag.toLowerCase())) stack.push(el);
    } else if (m[6]) {
      top.appendChild(new FakeText(decode(m[6])));
    }
  }
  if (stack.length !== 1) throw new Error(`fake-markup: ${stack.length - 1} tag(s) left open`);
}
