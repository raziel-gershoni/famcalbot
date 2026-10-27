// A small fake DOM for react-dom/client (no jsdom in node_modules), the smokes' shared mount helpers:
// a document and window that React can render into, `mount` (render, click, key, unmount, all inside
// act), element lookups, and a fake Telegram.WebApp that records every call (and keeps the BackButton's
// handlers, so a smoke can tap it). The render smoke keeps a larger copy of its own for the home; this
// is the small one smoke-calendar-home-tabs.ts and smoke-app-ui.ts share. scripts/lib/ is not a
// smoke (ci-smokes.sh runs scripts/smoke-*.ts only).

import { createRequire } from 'module';
import React, { type ReactElement } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

const nodeRequire = createRequire(__filename);
const noop = () => undefined;

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };

export class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners: Listener[] = [];
  constructor(
    public nodeType: number,
    public nodeName: string,
  ) {}
  get ownerDocument(): Row {
    return fakeDocument;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(String(value)));
  }
  addEventListener(type: string, fn: (event: Row) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, capture, fn });
  }
  removeEventListener(type: string, fn: (event: Row) => void) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
}

export class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3, '#text');
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = String(value);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

// ---- Selectors: what querySelector(All) understands ----

type ElementTest = (e: FakeElement) => boolean;

/** `.class`, `[attr]`, `[attr="v"]` or `[attr^="v"]` at the start of `text`: its test and what follows. */
const SIMPLE_SELECTOR = /^(?:\.([\w-]+)|\[([\w-]+)(?:(\^?=)"([^"]*)")?\])/;
function simpleTest(text: string): [ElementTest, string] | null {
  const m = SIMPLE_SELECTOR.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const [, cls, name, op, value] = m;
  if (cls !== undefined) return [(e) => e.className.split(' ').includes(cls), rest];
  if (op === undefined) return [(e) => e.hasAttribute(name), rest];
  if (op === '=') return [(e) => e.getAttribute(name) === value, rest];
  return [(e) => (e.getAttribute(name) ?? '').startsWith(value), rest];
}

/** A selector list as one test. Throws `fake-dom: unsupported selector <selector>` on anything it cannot parse. */
function selectorTest(selector: string): ElementTest {
  const unsupported = () => new Error(`fake-dom: unsupported selector ${selector}`);
  // Split at the commas outside quotes and brackets
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '[' || ch === '(')) depth++;
    else if (!quoted && (ch === ']' || ch === ')')) depth--;
    else if (!quoted && depth === 0 && ch === ',') {
      parts.push(selector.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(selector.slice(from));
  const compounds = parts.map((part) => {
    let rest = part.trim();
    if (!rest) throw unsupported();
    const tests: ElementTest[] = [];
    const tag = /^[a-z][\w-]*/i.exec(rest);
    if (tag) {
      const name = tag[0].toLowerCase();
      tests.push((e) => e.localName === name);
      rest = rest.slice(tag[0].length);
    }
    while (rest) {
      const not = /^:not\(((?:[^()"]|"[^"]*")*)\)/.exec(rest);
      if (not) {
        const inner = simpleTest(not[1]);
        if (!inner || inner[1] !== '') throw unsupported();
        const inside = inner[0];
        tests.push((e) => !inside(e));
        rest = rest.slice(not[0].length);
        continue;
      }
      const one = simpleTest(rest);
      if (!one) throw unsupported();
      tests.push(one[0]);
      rest = one[1];
    }
    if (tests.length === 0) throw unsupported();
    return (e: FakeElement) => tests.every((t) => t(e));
  });
  return (e) => compounds.some((c) => c(e));
}

export class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  style: Row = { setProperty(k: string, v: string) { this[k] = v; }, removeProperty(k: string) { delete this[k]; } };
  constructor(
    public localName: string,
    public namespaceURI: string,
  ) {
    super(1, namespaceURI === HTML_NS ? localName.toUpperCase() : localName);
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_ns: string | null, name: string) {
    this.attributes.delete(name);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  /** What a form control holds: set by a test (see `change` and `input` of mount) or by React; an option's own, and a select's chosen one, otherwise. */
  private held: string | undefined;
  get value(): string {
    if (this.held !== undefined) return this.held;
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    if (this.localName === 'select') {
      const options = this.options;
      return (options.find((o) => (o as unknown as Row).selected) ?? options[0])?.value ?? '';
    }
    return this.getAttribute('value') ?? '';
  }
  set value(v: string) {
    this.held = String(v);
  }
  /** What React asks of a text field to tell it from other inputs. */
  get type(): string {
    return this.getAttribute('type') ?? (this.localName === 'textarea' ? 'textarea' : this.localName === 'select' ? 'select-one' : 'text');
  }
  set type(v: string) {
    this.setAttribute('type', v);
  }
  /**
   * Descendants matching a selector list, in document order. It knows what the app's own code passes (see `selectorTest`):
   * a tag, .class, [attr], [attr="v"] and [attr^="v"] combined into one compound, :not() of one of them, and commas.
   * Any other selector throws, so a check that reaches one fails loudly instead of finding nothing.
   */
  querySelectorAll(selector: string): FakeElement[] {
    const test = selectorTest(selector);
    const hits: FakeElement[] = [];
    const walk = (node: FakeNode) => {
      for (const c of node.childNodes) {
        if (c instanceof FakeElement) {
          if (test(c)) hits.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return hits;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** A select's options, as React reads them. */
  get options(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement && c.localName === 'option');
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
}

export const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML' },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
};
// React asks whether the document has `oninput` before it trusts the platform's input events for text fields.
fakeDocument.oninput = null;
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

/** A Storage-like object over a Map. */
export function memoryStorage(saved = new Map<string, string>()): Row {
  return {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, String(v)),
    removeItem: (k: string) => void saved.delete(k),
  };
}

export const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: memoryStorage(),
  localStorage: memoryStorage(),
};
fakeDocument.defaultView = fakeWindow;

const g = globalThis as Row;
export function installWindow() {
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

export type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  /** A keydown on `el` (`extra`: modifiers such as shiftKey); returns the event, to see whether it was taken (defaultPrevented). */
  key: (el: FakeNode, key: string, extra?: Row) => Row;
  /** A select's change to `value`, as the platform's picker makes it. */
  change: (el: FakeNode, value: string) => void;
  /** Typing `value` into a text field. */
  input: (el: FakeNode, value: string) => void;
  unmount: () => void;
};

export function mount(el: ReactElement, rootOptions?: Row): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container, rootOptions);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string, extra: Row): Row => {
    const event: Row = {
      type,
      target,
      srcElement: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      timeStamp: Date.now(),
      button: 0,
      buttons: 0,
      detail: 1,
      ...extra,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation: noop,
      stopImmediatePropagation: noop,
    };
    React.act(() => {
      fakeWindow.event = event;
      for (const capture of [true, false]) {
        for (const l of container.listeners.filter((x) => x.type === type && x.capture === capture)) l.fn(event);
      }
      fakeWindow.event = undefined;
    });
    return event;
  };
  return {
    container,
    render: (next) => React.act(() => root.render(next)),
    click: (target) => void dispatch(target, 'click', {}),
    key: (target, key, extra = {}) => dispatch(target, 'keydown', { key, ...extra }),
    change: (target, value) => {
      (target as FakeElement).value = value;
      dispatch(target, 'change', {});
    },
    input: (target, value) => {
      // Past React's value tracker (it keeps the last value it saw on the element itself): the platform sets the value the way a keystroke does.
      Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')?.set?.call(target, value);
      dispatch(target, 'input', {});
    },
    unmount: () => React.act(() => root.unmount()),
  };
}

export function elements(node: FakeNode, out: FakeElement[] = []): FakeElement[] {
  for (const c of node.childNodes) {
    if (c instanceof FakeElement) {
      out.push(c);
      elements(c, out);
    }
  }
  return out;
}
export const byRole = (node: FakeNode, role: string) => elements(node).filter((e) => e.getAttribute('role') === role);

// ---- A fake Telegram.WebApp (records calls, as the SDK's methods are called) ----

/** Bot API versions compared as the SDK does: part by part, missing parts 0. */
function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * The SDK object, recording each call in `calls`. `backHandlers` holds the BackButton's registered
 * handlers (onClick adds, offClick removes), so a smoke taps the button by calling them.
 */
export function fakeTelegram(calls: string[], version: string): Row {
  const backHandlers: (() => void)[] = [];
  const eventHandlers: Record<string, (() => void)[]> = {};
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
    if (typeof a !== 'function') return String(a);
    if (!ids.has(a)) ids.set(a, `fn${ids.size + 1}`);
    return ids.get(a) as string;
  };
  const rec =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push(`${name}(${args.map(label).join(',')})`);
  return {
    initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc',
    version,
    colorScheme: 'light',
    isVersionAtLeast: (v: string) => versionAtLeast(version, v),
    setHeaderColor: rec('setHeaderColor'),
    setBackgroundColor: rec('setBackgroundColor'),
    onEvent: (event: string, fn: () => void) => {
      rec('onEvent')(event, fn);
      (eventHandlers[event] ??= []).push(fn);
    },
    offEvent: (event: string, fn: () => void) => {
      rec('offEvent')(event, fn);
      eventHandlers[event] = (eventHandlers[event] ?? []).filter((h) => h !== fn);
    },
    enableVerticalSwipes: rec('enableVerticalSwipes'),
    disableVerticalSwipes: rec('disableVerticalSwipes'),
    ready: rec('ready'),
    expand: rec('expand'),
    close: rec('close'),
    backHandlers,
    eventHandlers,
    BackButton: {
      onClick: (fn: () => void) => {
        rec('BackButton.onClick')(fn);
        backHandlers.push(fn);
      },
      offClick: (fn: () => void) => {
        rec('BackButton.offClick')(fn);
        const at = backHandlers.indexOf(fn);
        if (at >= 0) backHandlers.splice(at, 1);
      },
      show: rec('BackButton.show'),
      hide: rec('BackButton.hide'),
    },
  };
}
