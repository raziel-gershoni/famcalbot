// The public site smokes' shared harness (plan docs/superpowers/plans/2026-10-29-public-website.md): the site's pages
// and layouts run as Next runs them on the server, with the boundaries stood in for.
//
// - next-intl/server is the real translator over messages/{en,he,ru}.json (createTranslator), with the request's locale
//   that setRequestLocale sets; getMessages gives the whole catalogue.
// - A style sheet import (`import '../../globals.css'`) is an empty module: Node has no CSS loader.
// - `render` is react-dom/static's prerender, which waits for async server components, so a page renders whole.
// - `stub` puts a module in require's cache and serves it to import() by a load hook.
// scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Locale = 'en' | 'he' | 'ru';

export const ROOT = path.resolve(__dirname, '../..');
export const LOCALES: Locale[] = ['en', 'he', 'ru'];
export const messages: Record<Locale, Row> = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]),
) as Record<Locale, Row>;
export const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const nodeRequire = createRequire(__filename);
// Untyped on purpose: registerHooks and _cache are Node's, beyond @types/node's view of the module API
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module: any = nodeRequire('node:module');

// ---- Checks ----

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
export async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    const inner = (err as { errors?: unknown[] } | null)?.errors?.[0];
    const shown = inner instanceof Error ? inner : err;
    const reason = shown instanceof Error ? shown.message || String(shown.stack ?? shown).split('\n').slice(0, 6).join(' | ') : String(shown);
    results.push({ name, ok: false, reason });
  }
}
export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
export const show = (value: unknown) => JSON.stringify(value);
/** An emoji, but not the text symbols © ® ™ (Unicode counts them as pictographs). */
export const EMOJI = /(?![\u00a9\u00ae\u2122])\p{Extended_Pictographic}/u;
/**
 * The truth list (spec 2026-10-28-public-website §4): what no public string says, in any language. Each entry names
 * the claim and the pattern that finds it (case-insensitive).
 */
export const UNTRUE: [string, RegExp][] = [
  ['"never stored"', /never stored|לא נשמר|לא נשמרים|не хран|никогда не сохран/i],
  ['"full feature parity"', /feature parity|full parity|אותם פיצ[׳']רים|одинаковые фич|всё одно и то же/i],
  ['early access', /early access|early adopter|גישה מוקדמת|תקופת ההשקה|ранн\S* доступ/i],
  ['OpenAI', /openai/i],
  ['OpenWeatherMap', /openweather/i],
  ['Google as a step', /connect your google calendars?|sign in with google|מחברים את יומני Google|подключаете google календари/i],
  ['two-way Google sync', /two-way|דו[- ]כיווני|двусторонн/i],
  ['events by zman', /events? by zman|אירועים לפי זמני היום|событи\S* по зманим/i],
  ['WhatsApp reminders', /reminders? (?:on|in|via) whatsapp|תזכורות בוואטסאפ|напоминания в whatsapp/i],
  ['auto-renewal', /auto-?renew|renews? automatically|מתחדש(?:ים)? אוטומטית|автоматически продлева|автопродлен/i],
  ['a scheduled weekly summary', /weekly summary every|every (?:sunday|week) (?:you get|it sends)|סיכום שבועי (?:בכל|כל)|еженедельн\S* сводк/i],
];

/** HTML entities React writes in attributes and text, decoded. */
export const decodeEntities = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** Prints the results and exits 1 on any failure. */
export function finish(): never {
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// ---- React's warnings ----

// The smokes render with react-dom/static and mount with react-dom/client in one process, so React (in development) sees
// two renderers on next-intl's context and says so: that is the harness, not the page. Any other warning is printed.
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (String(args[0]).startsWith('Detected multiple renderers concurrently rendering the same context provider')) return;
    original(...args);
  };
}

// ---- Boundaries ----

const stubs: Record<string, Row> = {};
(globalThis as Row).__siteSmokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('The site smokes need Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (file.endsWith('.css')) return { format: 'commonjs', source: '', shortCircuit: true };
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__siteSmokeStubs[${JSON.stringify(file)}];`,
      ...names.map((n) => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});
// tsx compiles the smokes to CommonJS: a required style sheet is an empty module too.
(Module._extensions as Row)['.css'] = (mod: Row) => {
  mod.exports = {};
};

/** Serves `exports` for the module at `rel` (from the repo root, or a resolved absolute path). */
export function stub(rel: string, exports: Row) {
  const filename = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

/** The request's locale, as setRequestLocale left it. */
export const request: { locale: Locale } = { locale: 'en' };

/** next-intl/server over the real messages: getTranslations, getMessages, getLocale, setRequestLocale. */
export function stubIntlServer() {
  const { createTranslator } = nodeRequire('next-intl');
  const translator = (locale: Locale, namespace?: string) => createTranslator({ locale, namespace, messages: messages[locale] });
  stub(nodeRequire.resolve('next-intl/server'), {
    __esModule: true,
    getTranslations: async (arg?: string | { locale?: string; namespace?: string }) => {
      if (typeof arg === 'string' || arg === undefined) return translator(request.locale, arg);
      return translator((arg.locale as Locale) ?? request.locale, arg.namespace);
    },
    getMessages: async (arg?: { locale?: string }) => messages[(arg?.locale as Locale) ?? request.locale],
    getLocale: async () => request.locale,
    setRequestLocale: (locale: string) => {
      request.locale = locale as Locale;
    },
  });
}

/** Loads a module of the repo (after the stubs it needs are in place). */
export const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

// ---- Rendering ----

/** The whole HTML of `el`, async server components awaited (react-dom/static's prerender). */
export async function render(el: ReactElement): Promise<string> {
  const { prerender } = nodeRequire('react-dom/static');
  const { prelude } = await prerender(el, { onError: (err: unknown) => console.error('[render]', err) });
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

/** An async component's element resolved one level: the element its function returns (for a layout's own tree). */
export async function expand(el: ReactElement): Promise<ReactElement> {
  const type = el.type as (props: unknown) => ReactElement | Promise<ReactElement>;
  return await type(el.props);
}

/** Every element in a tree that is already built (no component is called). */
export function elementsOf(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    out.push(child);
    elementsOf((child.props as Row).children, out);
  });
  return out;
}

/** The visible text of server markup: no tags, no style or script bodies, entities decoded, spaces collapsed. */
export const textOf = (html: string) =>
  html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export { createElement };
