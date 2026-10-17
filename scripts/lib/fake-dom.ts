// One small fake DOM for react-dom/client (no jsdom in node_modules), shared by the calendar-home
// smokes. A fix a future React needs (a missing DOM method, say) goes here, once.
// A smoke adds what it needs to `fakeWindow` (storage, open, Telegram) with Object.assign.

import { createRequire } from 'module';
import React, { type ReactElement } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

const nodeRequire = createRequire(__filename);
const noop = () => undefined;

export const HTML_NS = 'http://www.w3.org/1999/xhtml';
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
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

/** The window every smoke shares; each adds its own storage, open, Telegram. */
export const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
};
fakeDocument.defaultView = fakeWindow;

export function installWindow() {
  const g = globalThis as Row;
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

export type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  /** A keydown on `el`; returns the event, to see whether it was taken (defaultPrevented). */
  key: (el: FakeNode, key: string) => Row;
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
    key: (target, key) => dispatch(target, 'keydown', { key }),
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
