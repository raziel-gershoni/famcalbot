// Smoke test for the Feedback screen (plan docs/superpowers/plans/2026-10-27-app-ui-W1b-subscription-feedback-story.md,
// Task 3; spec 2026-10-19-screens-and-colours §4, §5): FeedbackClient on AppScreen and the form kit, in real React on the
// small fake DOM, with a fake Telegram.WebApp, a router stub and a fake fetch. No network, no DB.
//  - F1 the render in en, he and ru, light (server) and dark (Telegram): the grouped root, the title, the intro, the field with its
//    label, its limit (maxlength 1000) and the count line it is described by, the count left to right; no raw key, no emoji, no
//    Latin in he and ru beyond FamCal;
//  - F2 the counter and Send: nothing typed has no counter text and Send is off; the characters still to go in each language's
//    plural forms; spaces around the text do not count (the count is the trimmed length: "   short   " is 5); ten characters turn Send on;
//  - F3 the request: one POST to /api/feedback with the text trimmed, the user the page was opened for and the SDK's initData ('' in a browser);
//  - F4 the outcomes: 429 or rateLimit is the daily limit; 401, 403 and 404 say to open the page from the chat; tooShort and tooLong say
//    their numbers; anything else, or a throw (logged), is "couldn't send"; the text is kept and Send comes back; typing clears the error;
//  - F5 success: the thanks card in the same screen, its button back to the calendar, startMiniApp('app') run once (ready, expand, swipes);
//  - F6 TextField: maxLength, rows (default 3) and describedBy render, and a field that uses none of them is byte for byte what it was;
//  - F7 the route reads its limits from the shared constant; the messages: every key read, the old namespace gone, the old page's parts gone;
//  - F8 React logs no warning.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-feedback-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-feedback-render.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { FORM_CSS, TextField } from '../components/app-ui/form-kit';
import { FEEDBACK_LIMITS } from '../src/lib/feedback-limits';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message || String(((err as unknown as { errors?: Error[] }).errors?.[0] ?? err).stack).split('\n').slice(0, 5).join(' | ') : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (value: unknown) => JSON.stringify(value);

// ---- React must not warn; what the page itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[feedback]') || text.startsWith('[telegram-ui]')) return void appLogs.push(text);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: a router and a fetch ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
const router = { push: (href: string) => void pushes.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };

interface FetchCall {
  url: string;
  init: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const world = {
  feedback: (): Response | Promise<Response> => json({ success: true }),
};
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url === '/api/feedback') return world.feedback();
  throw new Error(`an unexpected request: ${url}`);
}) as typeof fetch;
const reset = () => {
  pushes.length = 0;
  fetchCalls.length = 0;
  appLogs.length = 0;
  world.feedback = () => json({ success: true });
};
const posts = () => fetchCalls.filter((c) => c.url === '/api/feedback');

let Feedback: (props: Row) => ReactElement;
function tree(locale: Locale): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Feedback, { userId: 5, locale }));
  return createElement(AppRouterContext.Provider, { value: router }, intl);
}

/** What the strings of a language say, by key ('title' in the feedback namespace). */
const word = (locale: Locale, key: string, ns = 'feedback'): string => {
  const value = `${ns}.${key}`.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${ns}.${key} in ${locale}`);
  return value;
};

// ---- Reading what is on the page ----

/** What a reader sees: style sheets, tags and React's separators out, entities decoded, spaces collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The text under a node of the mounted tree, without the style sheets. */
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
const flat = (node: FakeNode) => visible(node).replace(/\s+/g, ' ').trim();
const page = (m: Mounted) => flat(m.container);
const classes = (e: FakeElement) => e.className.split(' ');
const buttonsOf = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'button');
const sendButton = (m: Mounted) => buttonsOf(m).find((b) => classes(b).includes('ch-save'));
const field = (m: Mounted) => elements(m.container).find((e) => e.localName === 'textarea');
/** The count line: the element the field says it is described by. */
const countLine = (m: Mounted) => {
  const id = field(m)?.getAttribute('aria-describedby');
  return elements(m.container).find((e) => id && e.getAttribute('id') === id);
};
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

interface Opened {
  m: Mounted;
  tg: Row | null;
  calls: string[];
}
/** Mount in a browser (no Telegram) or in Telegram `version`; the caller closes it. */
function open(locale: Locale, telegram?: { version: string; scheme?: 'light' | 'dark' }): Opened {
  installWindow();
  const calls: string[] = [];
  const tg = telegram ? fakeTelegram(calls, telegram.version) : null;
  if (tg) {
    tg.initData = 'fake-init-data';
    if (telegram?.scheme) tg.colorScheme = telegram.scheme;
  }
  fakeWindow.Telegram = tg ? { WebApp: tg } : undefined;
  const m = mount(tree(locale));
  return { m, tg, calls };
}
const close = (opened: Opened) => {
  opened.m.unmount();
  fakeWindow.Telegram = undefined;
};
const type = (o: Opened, text: string) => o.m.input(field(o.m) as FakeElement, text);
/** Writes `text` and taps Send, then lets the request finish. */
async function send(o: Opened, text: string) {
  type(o, text);
  o.m.click(sendButton(o.m) as FakeElement);
  await settle();
}

async function main() {
  Feedback = (await import('../app/[locale]/(app)/feedback/FeedbackClient')).default as unknown as (props: Row) => ReactElement;

  await check('F1 render in en, he and ru, light (server) and dark (Telegram): a grouped AppScreen root with its direction and language, the title as the h1, the intro, a textarea with its label, placeholder, maxlength 1000 and the id of the count line that describes it, the count left to right; Send off; no raw key, no emoji, no Latin in he and ru beyond FamCal', () => {
    for (const locale of LOCALES) {
      const w = (key: string) => word(locale, key);
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const html = renderToString(tree(locale));
      assert(html.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the root: ${html.slice(0, 140)}`);
      assert(html.includes(`<h1 class="ch-screen-title">${w('title')}</h1>`), `${locale}: the title`);
      const text = textOf(html);
      assert(text.includes(textOf(w('intro'))), `${locale}: the intro`);
      assert(!/feedback\.|ui\.|dashboard\./.test(text), `${locale}: a raw key in ${text}`);
      assert(!/\p{Extended_Pictographic}/u.test(text), `${locale}: an emoji`);
      if (locale !== 'en') {
        const bare = text.replace(/FamCal/g, '');
        assert(!/[A-Za-z]/.test(bare), `${locale}: Latin letters in ${bare.match(/\S*[A-Za-z]\S*/g)?.slice(0, 5)}`);
      }
      const area = /<textarea\b[^>]*>/.exec(html)?.[0] ?? '';
      assert(area.includes(`aria-label="${w('fieldLabel')}"`) && area.includes(`placeholder="${w('placeholder')}"`) && /maxlength="1000"/i.test(area) && area.includes('rows="8"') && area.includes('dir="auto"'), `${locale}: the textarea: ${area}`);
      const describedBy = /aria-describedby="([^"]*)"/.exec(area)?.[1];
      assert(describedBy && html.includes(`<div id="${describedBy}" class="ch-form-count">`), `${locale}: the field is described by ${describedBy}, which is no count line`);
      assert(html.includes('<bdi dir="ltr">0 / 1000</bdi>'), `${locale}: the count`);
      assert(/<button type="button" class="ch-btn ch-btn-primary ch-save" disabled="">/.test(html) && html.includes(`${w('send')}</button>`), `${locale}: Send is off and says ${w('send')}`);
      assert(html.includes('ch-save-bar ch-save-bar-sticky'), `${locale}: the bar sticks`);
      assert(/\.ch-form-count \{[^}]*display:\s*flex[^}]*justify-content:\s*space-between[^}]*font-size:\s*13px[^}]*color:\s*var\(--ch-muted\)/.test(FORM_CSS), 'the count line is 13px muted, with its two parts at the two ends');
      // Dark, as Telegram says it
      const dark = open(locale, { version: '7.7', scheme: 'dark' });
      try {
        const root = elements(dark.m.container).find((e) => e.className === 'ch-app ch-screen ch-grouped');
        assert(root && root.getAttribute('data-theme') === 'dark' && root.getAttribute('dir') === dir && root.getAttribute('lang') === locale, `${locale}: the dark root`);
        assert(dark.calls.includes('setHeaderColor(bg_color)') && dark.calls.includes('setBackgroundColor(bg_color)') && !dark.calls.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), `${locale}: dark colours ${show(dark.calls)}`);
      } finally {
        close(dark);
      }
    }
  });

  await check('F2 the counter and Send: nothing typed has no counter text and Send is off; "abc" is 7 to go (in each language\'s words, with its one, two and few forms); spaces around the text do not count, so "   short   " is 5 and Send stays off; ten characters turn Send on and clear the words', () => {
    const to: Record<Locale, [number, string][]> = {
      en: [[7, '7 more characters to go'], [1, '1 more character to go'], [2, '2 more characters to go']],
      he: [[7, 'עוד 7 תווים'], [1, 'עוד תו אחד'], [2, 'עוד שני תווים']],
      ru: [[7, 'Ещё 7 символов'], [1, 'Ещё 1 символ'], [2, 'Ещё 2 символа'], [5, 'Ещё 5 символов'], [3, 'Ещё 3 символа']],
    };
    for (const locale of LOCALES) {
      const o = open(locale);
      try {
        // The count line is the words on its start side (when there are any) and the count on its end side, left to right
        const parts = () => {
          const line = countLine(o.m) as FakeElement;
          const [start, end] = line.childNodes;
          return { words: flat(start), count: flat(end), endTag: (end as FakeElement).localName, endDir: (end as FakeElement).getAttribute('dir') };
        };
        assert(sendButton(o.m)?.hasAttribute('disabled') && show(parts()) === show({ words: '', count: '0 / 1000', endTag: 'bdi', endDir: 'ltr' }), `${locale}: empty: ${show(parts())}`);
        for (const [left, words] of to[locale]) {
          type(o, 'x'.repeat(10 - left));
          assert(parts().words === words && parts().count === `${10 - left} / 1000`, `${locale}: ${left} to go: ${show(parts())}`);
          assert(sendButton(o.m)?.hasAttribute('disabled'), `${locale}: ${left} to go: Send is on`);
        }
        type(o, 'abc');
        assert(parts().words === to[locale][0][1] && parts().count === '3 / 1000', `${locale}: abc: ${show(parts())}`);
        // The count is of the trimmed text
        type(o, '   short   ');
        assert(parts().count === '5 / 1000' && parts().words === (locale === 'en' ? '5 more characters to go' : locale === 'he' ? 'עוד 5 תווים' : 'Ещё 5 символов') && sendButton(o.m)?.hasAttribute('disabled'), `${locale}: spaces: ${show(parts())}`);
        type(o, '          ');
        assert(parts().count === '0 / 1000' && parts().words === '' && sendButton(o.m)?.hasAttribute('disabled'), `${locale}: only spaces: ${show(parts())}`);
        type(o, 'x'.repeat(10));
        assert(parts().count === '10 / 1000' && parts().words === '' && !sendButton(o.m)?.hasAttribute('disabled'), `${locale}: ten: ${show(parts())}`);
        type(o, `  ${'x'.repeat(10)}  `);
        assert(parts().count === '10 / 1000' && !sendButton(o.m)?.hasAttribute('disabled'), `${locale}: ten between spaces: ${show(parts())}`);
        // The field takes 1000 characters and no more
        assert(field(o.m)?.getAttribute('maxlength') === '1000' || field(o.m)?.getAttribute('maxLength') === '1000', `${locale}: the limit: ${show([...(field(o.m)?.attributes ?? [])])}`);
      } finally {
        close(o);
      }
    }
  });

  await check('F3 the request: one POST to /api/feedback, JSON, with the text trimmed, the user the page was opened for and the initData the SDK holds (an empty one in a browser), and nothing else; a second tap while it is in flight sends nothing', async () => {
    for (const telegram of [true, false]) {
      reset();
      let release: (r: Response) => void = () => undefined;
      world.feedback = () => new Promise<Response>((resolve) => (release = resolve));
      const o = open('en', telegram ? { version: '7.7' } : undefined);
      try {
        type(o, '   the calendar is great   ');
        o.m.click(sendButton(o.m) as FakeElement);
        assert(posts().length === 1, `${telegram}: a tap posts: ${posts().length}`);
        const call = posts()[0];
        assert(call.init.method === 'POST' && (call.init.headers as Row)['Content-Type'] === 'application/json', `${telegram}: method and header: ${show(call.init)}`);
        assert(show(JSON.parse(String(call.init.body))) === show({ text: 'the calendar is great', user_id: 5, initData: telegram ? 'fake-init-data' : '' }), `${telegram}: the body: ${call.init.body}`);
        // In flight: the button is busy and off
        assert(sendButton(o.m)?.hasAttribute('disabled') && sendButton(o.m)?.getAttribute('aria-busy') === 'true', `${telegram}: busy`);
        o.m.click(sendButton(o.m) as FakeElement);
        assert(posts().length === 1, `${telegram}: a tap in flight: ${posts().length}`);
        release(json({ success: true }));
        await settle();
      } finally {
        close(o);
      }
    }
  });

  await check('F4 the outcomes, in the page\'s language: 429 and rateLimit say the daily limit; 401, 403 and 404 say to open the page from the chat; a 400 tooShort and tooLong say their numbers; a 500, an answer that is not JSON and a throw say it could not be sent (the throw logged); the text stays, Send comes back, and typing clears the message; the server\'s words are never shown', async () => {
    // [name, what the server answers, the message's key, what the page logs]
    const cases: [string, () => Response | Promise<Response>, string, string | null][] = [
      ['429 rateLimit', () => json({ success: false, error: 'rateLimit' }, 429), 'rateLimit', null],
      ['429 with no code', () => json({ success: false }, 429), 'rateLimit', null],
      ['rateLimit under another status', () => json({ success: false, error: 'rateLimit' }, 400), 'rateLimit', null],
      ['401', () => json({ success: false, error: 'Unauthorized' }, 401), 'openFromChat', '[feedback] send refused: 401'],
      ['403', () => json({ success: false, error: 'Forbidden' }, 403), 'openFromChat', '[feedback] send refused: 403'],
      ['404', () => json({ success: false, error: 'User not found' }, 404), 'openFromChat', '[feedback] send refused: 404'],
      ['400 tooShort', () => json({ success: false, error: 'tooShort' }, 400), 'tooShort', '[feedback] send refused: 400'],
      ['400 tooLong', () => json({ success: false, error: 'tooLong' }, 400), 'tooLong', '[feedback] send refused: 400'],
      ['500', () => json({ success: false, error: 'Failed to submit feedback' }, 500), 'failed', '[feedback] send refused: 500'],
      ['not JSON', () => new Response('<html>', { status: 200 }), 'failed', '[feedback] send failed:'],
      ['a throw', () => Promise.reject(new Error('network down')), 'failed', '[feedback] send failed:'],
    ];
    for (const locale of LOCALES) {
      for (const [name, answer, key, log] of cases) {
        reset();
        world.feedback = answer;
        const o = open(locale, { version: '7.7' });
        try {
          const text = 'a message that is long enough';
          await send(o, text);
          const alert = byRole(o.m.container, 'alert').find((e) => classes(e).includes('ch-form-error'));
          const want = word(locale, key).replace('{min}', String(FEEDBACK_LIMITS.minLength)).replace('{max}', String(FEEDBACK_LIMITS.maxLength));
          assert(alert && flat(alert) === want, `${locale} ${name}: the message ${alert && flat(alert)}, want ${want}`);
          assert(!/Unauthorized|Forbidden|not found|Failed to submit/i.test(page(o.m)), `${locale} ${name}: the server's words are on the page`);
          assert((field(o.m) as FakeElement).value === text && !sendButton(o.m)?.hasAttribute('disabled') && sendButton(o.m)?.getAttribute('aria-busy') === null, `${locale} ${name}: the text stays and Send is back`);
          assert(log === null ? appLogs.length === 0 : appLogs.length === 1 && appLogs[0].startsWith(log), `${locale} ${name}: the log ${show(appLogs)}, want ${log}`);
          if (name === 'a throw') assert(appLogs[0].includes('network down'), `${locale}: the error is in the log`);
          assert(!elements(o.m.container).some((e) => e.localName === 'p' && classes(e).includes('ch-home-card-title')), `${locale} ${name}: the thanks card`);
          // Another try: the old message goes as the request leaves, before any answer
          world.feedback = () => new Promise<Response>(() => undefined);
          o.m.click(sendButton(o.m) as FakeElement);
          assert(byRole(o.m.container, 'alert').length === 0 && sendButton(o.m)?.getAttribute('aria-busy') === 'true', `${locale} ${name}: the old message stays while the next request runs`);
          world.feedback = answer;
          type(o, `${text}!`);
          assert(byRole(o.m.container, 'alert').length === 0, `${locale} ${name}: typing leaves the message`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('F5 success: the thanks card takes the form\'s place in the same screen (the header stays), with a button back to the calendar that goes to /<locale>/dashboard?user_id=5; startMiniApp(\'app\') ran once on mount (ready, expand, swipes) and no colour of ours went to Telegram', async () => {
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, { version: '7.7' });
      try {
        assert(show(o.calls.filter((c) => /^(?:ready|expand|enableVerticalSwipes|disableVerticalSwipes)\(/.test(c))) === show(['ready()', 'expand()', 'enableVerticalSwipes()']), `${locale}: the mount's calls ${show(o.calls)}`);
        await send(o, 'a message that is long enough');
        assert(posts().length === 1, `${locale}: one request`);
        const card = elements(o.m.container).find((e) => classes(e).includes('ch-home-card'));
        assert(card && flat(card) === `${word(locale, 'thanksTitle')}${word(locale, 'thanksBody')}${word(locale, 'backToCalendar')}`, `${locale}: the card ${card && flat(card)}`);
        assert(elements(card).filter((e) => e.localName === 'p').map(flat).join('|') === `${word(locale, 'thanksTitle')}|${word(locale, 'thanksBody')}`, `${locale}: the card's title and body`);
        assert(!field(o.m) && !sendButton(o.m) && !countLine(o.m), `${locale}: the form is still there`);
        assert(elements(o.m.container).some((e) => e.localName === 'h1' && flat(e) === word(locale, 'title')), `${locale}: the header stays`);
        const back = buttonsOf(o.m).find((b) => flat(b) === word(locale, 'backToCalendar'));
        assert(back && classes(back).includes('ch-btn-primary'), `${locale}: the way back`);
        o.m.click(back);
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=5`]), `${locale}: back goes to ${show(pushes)}`);
        assert(show(o.calls.filter((c) => /^(?:ready|expand|enableVerticalSwipes)\(/.test(c))) === show(['ready()', 'expand()', 'enableVerticalSwipes()']), `${locale}: the calls after the send ${show(o.calls)}`);
        assert(!o.calls.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), `${locale}: a colour of ours: ${show(o.calls)}`);
        // Telegram's BackButton is AppScreen's and goes to the same place
        pushes.length = 0;
        o.tg?.backHandlers[0]();
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=5`]), `${locale}: the BackButton goes to ${show(pushes)}`);
      } finally {
        close(o);
      }
    }
    // In a browser the header carries its own back, and startMiniApp has nothing to call
    reset();
    const browser = open('en');
    try {
      const back = buttonsOf(browser.m).find((b) => b.getAttribute('aria-label') === word('en', 'back', 'ui'));
      assert(back, 'no back in a browser');
      browser.m.click(back);
      assert(show(pushes) === show(['/en/dashboard?user_id=5']), `the page's back goes to ${show(pushes)}`);
    } finally {
      close(browser);
    }
    const source = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/feedback/FeedbackClient.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/useTelegramBackButton\(/.test(source), 'FeedbackClient calls useTelegramBackButton');
    assert((source.match(/startMiniApp\(/g) ?? []).length === 1, 'startMiniApp is called once');
  });

  await check('F6 TextField: maxLength, rows and describedBy render (describedBy alone, or with the error\'s id after it); a field that uses none of them is byte for byte what it was, for a single line, the title, notes, and either with an error', () => {
    const noop = () => undefined;
    const base = { label: 'Notes', value: 'Bring the form', onChange: noop, placeholder: 'Add notes' };
    const html = (props: Row) => renderToString(createElement(TextField as unknown as (p: Row) => ReactElement, { ...base, ...props })).replace(/_R_[a-z0-9]+_/g, 'ID');
    // What the editor's notes and title fields were before W1b
    const before = {
      single: '<input class="ch-form-field" aria-label="Notes" placeholder="Add notes" dir="auto" type="text" enterKeyHint="done" autoComplete="off" value="Bring the form"/>',
      title: '<input class="ch-form-field ch-form-field-title" aria-label="Notes" placeholder="Add notes" dir="auto" type="text" enterKeyHint="done" autoComplete="off" value="Bring the form"/>',
      notes: '<textarea class="ch-form-field ch-form-notes" aria-label="Notes" placeholder="Add notes" dir="auto" rows="3">Bring the form</textarea>',
      notesError: '<textarea class="ch-form-field ch-form-notes" aria-label="Notes" aria-invalid="true" aria-describedby="ID" placeholder="Add notes" dir="auto" rows="3">Bring the form</textarea><p id="ID" class="ch-form-error" role="alert">Too long</p>',
      singleError: '<input class="ch-form-field" aria-label="Notes" aria-invalid="true" aria-describedby="ID" placeholder="Add notes" dir="auto" type="text" enterKeyHint="done" autoComplete="off" value="Bring the form"/><p id="ID" class="ch-form-error" role="alert">Required</p>',
    };
    assert(html({ multiline: false }) === before.single, `single: ${html({ multiline: false })}`);
    assert(html({ large: true }) === before.title, `title: ${html({ large: true })}`);
    assert(html({ multiline: true }) === before.notes, `notes: ${html({ multiline: true })}`);
    assert(html({ multiline: true, error: 'Too long' }) === before.notesError, `notes with an error: ${html({ multiline: true, error: 'Too long' })}`);
    assert(html({ error: 'Required' }) === before.singleError, `single with an error: ${html({ error: 'Required' })}`);
    // The new props
    const tall = html({ multiline: true, rows: 8, maxLength: 1000, describedBy: 'count-1' });
    assert(/rows="8"/.test(tall) && /maxLength="1000"/i.test(tall) && /aria-describedby="count-1"/.test(tall) && !/rows="3"/.test(tall), `the new props: ${tall}`);
    const both = html({ multiline: true, describedBy: 'count-1', error: 'Too long' });
    assert(/aria-describedby="count-1 ID"/.test(both) && /<p id="ID"/.test(both), `describedBy and an error: ${both}`);
    assert(/maxLength="20"/i.test(html({ maxLength: 20 })) && !/maxLength/i.test(html({})), 'maxLength on a single line, and none without it');
  });

  await check('F7 the route and the messages: /api/feedback reads its 10, 1000 and 3 a day from FEEDBACK_LIMITS and keeps its behaviour (its own 24 hours); every key of the feedback namespace is read, the old dashboard.feedback is gone with the dashboard namespace, and the old page\'s parts (TelegramLayout, styled-jsx, the purple colours, hard-coded English) are gone', () => {
    assert(show(FEEDBACK_LIMITS) === show({ minLength: 10, maxLength: 1000, perDay: 3 }), `the limits: ${show(FEEDBACK_LIMITS)}`);
    const route = fs.readFileSync(path.join(ROOT, 'app/api/feedback/route.ts'), 'utf8');
    assert(/from '@\/src\/lib\/feedback-limits'/.test(route) && /FEEDBACK_LIMITS\.minLength/.test(route) && /FEEDBACK_LIMITS\.maxLength/.test(route) && /FEEDBACK_LIMITS\.perDay/.test(route), 'the route does not read FEEDBACK_LIMITS');
    assert(!/\b(?:minLength|maxLength|rateLimitCount):\s*\d/.test(route) && /rateLimitHours:\s*24/.test(route), 'the route still has its own numbers, or lost its 24 hours');
    const client = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/feedback/FeedbackClient.tsx'), 'utf8');
    const code = client.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(/from '@\/src\/lib\/feedback-limits'/.test(code) && /FEEDBACK_LIMITS\.maxLength/.test(code) && /FEEDBACK_LIMITS\.minLength/.test(code), 'the screen does not read FEEDBACK_LIMITS');
    assert(!/(?<![\w.])1000(?![\w])|(?<![\w.])10(?![\w])/.test(code.replace(/rows=\{8\}/, '')), `a limit written out in the screen: ${code.match(/.*\b(?:1000|10)\b.*/)?.[0]}`);
    assert(!/TelegramLayout|@\/components\/Layout|styled-jsx|<style jsx|#667eea|#ffffff|setHeaderColor|setBackgroundColor|Loader2|MessageSquare|CheckCircle2|ArrowLeft/.test(code), 'a part of the old page is still there');
    assert(!/Failed to|Back to Dashboard|characters needed|aria-label="Back"/.test(code), 'hard-coded English is still there');
    const leaves = (node: Row, prefix = ''): string[] => Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? leaves(v as Row, `${prefix}${k}.`) : [`${prefix}${k}`]));
    for (const locale of LOCALES) {
      const ns = messages[locale].feedback as Row;
      const keys = leaves(ns);
      assert(keys.length === 14, `${locale}: ${keys.length} keys in feedback`);
      const unread = keys.filter((k) => !code.includes(`'${k}'`));
      assert(unread.length === 0, `${locale}: keys nothing reads: ${show(unread)}`);
      assert(!('dashboard' in messages[locale]), `${locale}: the dashboard namespace is still there`);
    }
    // Nothing reads the old namespace
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(rel);
      }
      return out;
    };
    const readers = ['app', 'components', 'src'].flatMap((dir) => walk(dir)).filter((f) => /useTranslations\(\s*'dashboard'|getTranslations\(\s*'dashboard'|['"]dashboard\.feedback/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    assert(readers.length === 0, `still reading the old namespace: ${show(readers)}`);
  });

  await check('F8 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
