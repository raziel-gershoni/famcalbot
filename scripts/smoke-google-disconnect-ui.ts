// Smoke test for the Mini App side of "Disconnect Google"
// (docs/superpowers/specs/2026-10-25-disconnect-google-design.md): Settings' Google section
// and its confirmation (app/[locale]/(app)/settings/GoogleDisconnect.tsx, drawn with the app's kit),
// the request helper (google-disconnect-client.ts), the copy in en, he and ru, the admin
// timeline's wording of the activity row, and the privacy page's promise. Rendered through
// next-intl with the real messages. No network, no DB, no Redis.
//
// Run: TZ=UTC npx tsx scripts/smoke-google-disconnect-ui.ts (and TZ=Asia/Jerusalem)

import fs from 'fs';
import path from 'path';
import { act, createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import GoogleDisconnect, { GoogleDisconnectView, type GoogleDisconnectViewProps } from '../app/[locale]/(app)/settings/GoogleDisconnect';
import { requestDisconnect } from '../app/[locale]/(app)/settings/google-disconnect-client';
import { FORM_CSS } from '../components/app-ui/form-kit';
import { activityDetail } from '../src/lib/admin-activity';
import PrivacyPage from '../app/[locale]/(site)/privacy/page';
import { TEXT_PAIRS } from './lib/css-resolve';
import { byRole, elements, installWindow, mount } from './lib/fake-dom';

type Row = Record<string, unknown>;
type Locale = 'en' | 'he' | 'ru';
const ROOT = path.resolve(__dirname, '..');
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;
const gd = (l: Locale) => (messages[l].settings as Row).googleDisconnect as Record<string, string>;

const results: { name: string; ok: boolean; reason?: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

function provider(locale: Locale) {
  return { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as ComponentProps<typeof NextIntlClientProvider>;
}
function render(locale: Locale, element: ReactElement): string {
  return renderToString(createElement(NextIntlClientProvider, { ...provider(locale), children: element } as ComponentProps<typeof NextIntlClientProvider>));
}
const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[0].slice(0, m[0].indexOf('>') + 1), text: textOf(m[1]) }));
const noop = () => undefined;
const view = (o: Partial<GoogleDisconnectViewProps> = {}) =>
  createElement(GoogleDisconnectView, { connected: true, phase: 'idle', deleteCopies: true, leftover: [], error: null, onOpen: noop, onToggleCopies: noop, onConfirm: noop, onCancel: noop, onClose: noop, ...o });
const html = (l: Locale, o: Partial<GoogleDisconnectViewProps> = {}) => render(l, view(o));
const EMOJI = /\p{Extended_Pictographic}/u;
/** The sheet's own Close button: the last button of the dialog (the sheet puts it after the content). */
const sheetClose = (h: string) => buttons(h.slice(h.indexOf('role="dialog"'))).at(-1);
const switchTag = (h: string) => h.match(/<button\b[^>]*role="switch"[^>]*>/)?.[0];

async function main() {
  await check('G1 section: connected shows the title (an h2 section label), the hint and one "Disconnect Google" button (a danger row of the card), in en, he and ru', () => {
    for (const l of LOCALES) {
      const h = html(l);
      const t = gd(l);
      assert(textOf(h).includes(t.sectionTitle) && textOf(h).includes(t.sectionHint), `${l} text ${textOf(h)}`);
      assert(h.includes(`<h2 class="ch-section-label">${t.sectionTitle}</h2>`), `${l}: the label: ${h}`);
      const b = buttons(h);
      assert(b.length === 1 && b[0].text === t.button && /type="button"/.test(b[0].tag) && /class="ch-form-row ch-danger-row"/.test(b[0].tag), `${l} buttons ${show(b)}`);
    }
  });

  await check('G1b section: not connected and nothing open renders nothing', () => {
    assert(html('en', { connected: false }) === '', `rendered ${html('en', { connected: false })}`);
  });

  await check('G2 confirm: a modal sheet with the title, the explanation, the copies switch on by default (off after a toggle) and Cancel (the sheet\'s close) / Disconnect', () => {
    for (const l of LOCALES) {
      const h = html(l, { phase: 'confirm' });
      const t = gd(l);
      assert(/role="dialog"/.test(h) && /aria-modal="true"/.test(h), `${l} not a modal dialog`);
      const text = textOf(h);
      assert(text.includes(t.confirmTitle) && text.includes(t.confirmBody) && text.includes(t.copiesLabel) && text.includes(t.copiesHint), `${l} text ${text}`);
      // Copies the user chose to Keep are untouched (owner's call), and others on the same Google account must reconnect.
      assert(t.copiesKeptNote && text.includes(t.copiesKeptNote), `${l} no note that kept copies stay`);
      assert(t.confirmShared && text.includes(t.confirmShared), `${l} no line about others on the same Google account`);
      assert(/aria-checked="true"/.test(switchTag(h) ?? ''), `${l} switch ${switchTag(h)}`);
      assert(/aria-checked="false"/.test(switchTag(html(l, { phase: 'confirm', deleteCopies: false })) ?? ''), `${l} the switch after a toggle`);
      const names = buttons(h).map((b) => b.text);
      assert(names.includes(t.cancel) && names.includes(t.confirm), `${l} buttons ${show(names)}`);
      assert(sheetClose(h)?.text === t.cancel, `${l} the sheet's close reads Cancel: ${show(sheetClose(h))}`);
    }
  });

  await check('G2b confirm: the failure line never claims nothing changed (Google may already have revoked the token), in en, he and ru', () => {
    const claims = { en: /nothing was changed/i, he: /שום דבר לא השתנה/, ru: /ничего не изменилось/i };
    for (const l of LOCALES) assert(!claims[l].test(gd(l).errorFailed), `${l}: ${gd(l).errorFailed}`);
  });

  await check('G2c confirm: an error line (role=alert) in words, never a raw code', () => {
    for (const l of LOCALES) {
      for (const [code, key] of [['failed', 'errorFailed'], ['busy', 'errorBusy']] as const) {
        const h = html(l, { phase: 'confirm', error: code });
        assert(/role="alert"/.test(h) && textOf(h).includes(gd(l)[key]), `${l} ${code}: ${textOf(h)}`);
      }
    }
  });

  await check('G3 working: a spinner and the working line; the switch is aria-disabled; Disconnect and the sheet\'s close are disabled', () => {
    for (const l of LOCALES) {
      const h = html(l, { phase: 'working' });
      assert(textOf(h).includes(gd(l).working) && /ch-spin/.test(h), `${l} no working line or spinner`);
      assert(/aria-disabled="true"/.test(switchTag(h) ?? ''), `${l} the switch is not disabled: ${switchTag(h)}`);
      const confirmButton = buttons(h).find((b) => b.text === gd(l).confirm);
      assert(confirmButton && /disabled=""/.test(confirmButton.tag), `${l} Disconnect is enabled: ${show(confirmButton)}`);
      const close = sheetClose(h);
      assert(close && /disabled=""/.test(close.tag), `${l} the close button is enabled: ${show(close)}`);
    }
  });

  await check("G3b the stateful section: onSheet gets the sheet's closer while it is open (Cancel; a closer that does nothing while the request is in flight; the result's close, which also reports the disconnect) and null once it is closed; Escape does nothing while working", async () => {
    installWindow();
    const origFetch = globalThis.fetch;
    let release: (r: Response) => void = noop;
    globalThis.fetch = (() => new Promise<Response>((resolve) => void (release = resolve))) as typeof fetch;
    // What the screen would hold (it is state there): the closer and how often the section reported the disconnect
    const screen: { closer: (() => void) | null; disconnected: number } = { closer: null, disconnected: 0 };
    const reported = () => screen.disconnected;
    const seen: string[] = [];
    const onSheet = (close: (() => void) | null) => {
      screen.closer = close;
      seen.push(close ? 'closer' : 'null');
    };
    const m = mount(createElement(NextIntlClientProvider, { ...provider('en'), children: createElement(GoogleDisconnect, { userId: 7, connected: true, onDisconnected: () => void screen.disconnected++, onSheet }) } as ComponentProps<typeof NextIntlClientProvider>));
    const dialogs = () => byRole(m.container, 'dialog').length;
    const buttonOf = (className: string) => elements(m.container).find((e) => e.localName === 'button' && e.className.split(' ').includes(className));
    try {
      assert(screen.closer === null && dialogs() === 0, `closed: ${show(seen)}`);
      // Open, then Back (the screen calls the closer): the sheet goes, onSheet gets null
      const open = buttonOf('ch-danger-row');
      assert(open, 'the section button');
      m.click(open);
      assert(dialogs() === 1 && typeof screen.closer === 'function', `open: ${show(seen)}`);
      act(() => (screen.closer as unknown as () => void)());
      assert(dialogs() === 0 && screen.closer === null && reported() === 0, `after Back: ${show(seen)}, ${reported()} disconnected`);
      // Open again and confirm: the request hangs, the sheet is working
      m.click(buttonOf('ch-danger-row') as NonNullable<typeof open>);
      m.click(buttonOf('ch-btn-danger') as NonNullable<typeof open>);
      assert(dialogs() === 1 && /Disconnecting/.test(m.container.textContent) && typeof screen.closer === 'function', `working: ${show(seen)}`);
      const working = screen.closer as unknown as () => void;
      act(() => working());
      m.key(byRole(m.container, 'dialog')[0], 'Escape');
      assert(dialogs() === 1 && screen.closer === working, `Back and Escape do nothing while working: ${dialogs()} dialog(s), ${show(seen)}`);
      // The request answers: the result, whose close reports the disconnect
      await act(async () => {
        release(new Response(JSON.stringify({ status: 'disconnected', leftover: ['FamCal · Home'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert(dialogs() === 1 && /FamCal · Home/.test(m.container.textContent) && screen.closer && screen.closer !== working, `done: ${show(seen)}`);
      act(() => (screen.closer as unknown as () => void)());
      assert(dialogs() === 0 && screen.closer === null && reported() === 1, `after the result's close: ${dialogs()} dialog(s), ${reported()} disconnected, ${show(seen)}`);
    } finally {
      m.unmount();
      globalThis.fetch = origFetch;
    }
    assert(seen.at(-1) === 'null', `onSheet ends on null: ${show(seen)}`);
  });

  await check('G4 done: "disconnected" with Done as the sheet\'s close; the copy calendars that stayed are listed, one item each; none listed when none stayed', () => {
    for (const l of LOCALES) {
      const t = gd(l);
      const clean = html(l, { phase: 'done', connected: false });
      assert(textOf(clean).includes(t.doneTitle) && textOf(clean).includes(t.doneBody) && !/<li\b/.test(clean) && !textOf(clean).includes(t.leftoverIntro), `${l} clean: ${textOf(clean)}`);
      assert(buttons(clean).length === 1 && buttons(clean)[0].text === t.close, `${l} done buttons ${show(buttons(clean))}`);
      const left = html(l, { phase: 'done', connected: false, leftover: ['FamCal · Home', 'FamCal · Work'] });
      const items = [...left.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]));
      assert(textOf(left).includes(t.leftoverIntro) && show(items) === show(['FamCal · Home', 'FamCal · Work']), `${l} left: ${show(items)}`);
    }
  });

  await check('G5 look: every class is the kit\'s (ch-*, the switch\'s is-on, or the icon library\'s own), nothing of the old gd- set anywhere in app/, icons hidden from screen readers, no raw key, no emoji, in every phase and language', () => {
    for (const phase of ['idle', 'confirm', 'working', 'done'] as const) {
      for (const l of LOCALES) {
        const h = html(l, { phase, leftover: phase === 'done' ? ['FamCal · Home'] : [] });
        assert(!/<style/.test(h), `${l}/${phase}: it brings no style sheet of its own`);
        for (const cls of h.match(/class="[^"]*"/g) ?? []) assert(cls.slice(7, -1).split(' ').every((c) => c.startsWith('ch-') || c === 'is-on' || c.startsWith('lucide')), `${l}/${phase} ${cls}`);
        assert(!/googleDisconnect|settings\./.test(textOf(h)) && !EMOJI.test(textOf(h)), `${l}/${phase} raw key or emoji`);
        for (const svg of h.match(/<svg\b[^>]*>/g) ?? []) assert(/aria-hidden="true"/.test(svg), `${l}/${phase} an icon is read aloud: ${svg}`);
      }
    }
    const old: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.(?:tsx?|css)$/.test(entry.name) && /\bgd-|GOOGLE_DISCONNECT_CSS/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) old.push(rel);
      }
    };
    walk('app');
    assert(old.length === 0, `the old gd- classes or GOOGLE_DISCONNECT_CSS are still in: ${show(old)}`);
  });

  await check('G6 css: a danger row reads in the danger colour and the Disconnect button fills with it, each text on a pair the contrast smoke measures (4.5:1, light and dark)', () => {
    const body = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(FORM_CSS)?.[1];
    const row = body('button.ch-danger-row');
    assert(row && /(?:^|[\s;])color:\s*var\(--ch-danger\)/.test(row), `the row: ${row}`);
    const button = body('.ch-btn-danger');
    const fill = /background:\s*var\((--[\w-]+)\)/.exec(button ?? '')?.[1];
    const text = /(?:^|[\s;])color:\s*var\((--[\w-]+)\)/.exec(button ?? '')?.[1];
    assert(fill === '--ch-danger' && text, `the button: ${button}`);
    const measured = (fg: string, bg: string) => TEXT_PAIRS.some(([a, b]) => a === fg && b === bg);
    assert(measured('--ch-danger', '--ch-section'), "the row's text on the card is not a pair #2b measures");
    assert(measured(text, fill), `${text} on ${fill} is not a pair #2b measures`);
  });

  // ---- The request helper ----

  const calls: { url: string; init: RequestInit }[] = [];
  let answer: { status: number; body: unknown } | 'throw' = { status: 200, body: { status: 'disconnected', leftover: [] } };
  (globalThis as Row).window = { Telegram: { WebApp: { initData: 'signed-init-data' } }, location: { hash: '' } };
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    if (answer === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const quiet = { warn: console.warn, error: console.error };
  console.warn = () => undefined;
  console.error = () => undefined;

  await check('client: POSTs { deleteCopies } to /api/google-disconnect with the initData in the header, never in the URL; returns the leftover list', async () => {
    calls.length = 0;
    answer = { status: 200, body: { status: 'disconnected', leftover: ['FamCal · Home'] } };
    const r = await requestDisconnect(7, false);
    assert(r.kind === 'ok' && show(r.leftover) === show(['FamCal · Home']), `result ${show(r)}`);
    const c = calls[0];
    const headers = new Headers(c.init.headers);
    assert(c.url === '/api/google-disconnect?user_id=7' && c.init.method === 'POST' && headers.get('x-telegram-init-data') === 'signed-init-data' && !c.url.includes('signed'), `call ${show(c)}`);
    assert(show(JSON.parse(String(c.init.body))) === show({ deleteCopies: false }), `body ${String(c.init.body)}`);
  });

  await check('client: 429 is busy; 500, 401, a network failure and a body that is not the expected shape are failed (and logged, not thrown)', async () => {
    for (const [a, code] of [[{ status: 429, body: { error: 'Too many requests' } }, 'busy'], [{ status: 500, body: { error: 'failed' } }, 'failed'], [{ status: 401, body: {} }, 'failed'], ['throw', 'failed'], [{ status: 200, body: { status: 'nope' } }, 'failed']] as const) {
      answer = a as typeof answer;
      const r = await requestDisconnect(7, true);
      assert(r.kind === 'error' && r.code === code, `${show(a)} -> ${show(r)}`);
    }
    answer = { status: 200, body: { status: 'disconnected', leftover: ['ok', 5, null] } };
    const r = await requestDisconnect(7, true);
    assert(r.kind === 'ok' && show(r.leftover) === show(['ok']), `non-string names kept: ${show(r)}`);
  });

  console.warn = quiet.warn;
  console.error = quiet.error;

  // ---- Wiring, activity row, privacy ----

  await check('wiring: Settings renders the section from a googleConnected prop that page-data fills from the stored token', () => {
    const client = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/settings/SettingsClient.tsx'), 'utf8');
    const pageData = fs.readFileSync(path.join(ROOT, 'src/lib/page-data.ts'), 'utf8');
    assert(/<GoogleDisconnect\b/.test(client) && /googleConnected: boolean/.test(client), 'SettingsClient does not render the section');
    assert(/googleConnected: Boolean\(user\.googleRefreshToken\)/.test(pageData), 'page-data does not pass googleConnected');
  });

  await check('admin timeline: calendar_disconnected reads as words, not raw JSON', () => {
    const d = activityDetail('calendar_disconnected', { provider: 'google', copies_deleted: 2, copies_left: 1, revoked: true });
    assert(d === 'google · 2 copies deleted · 1 left · revoked', `detail ${d}`);
    assert(activityDetail('calendar_disconnected', { provider: 'google', copies_deleted: 0, copies_left: 0, revoked: false }).endsWith('not revoked'), 'not revoked');
  });

  await check('privacy: the retention paragraph says what happens, in en, he and ru; the old blanket promise is gone', async () => {
    const want: Record<Locale, RegExp[]> = {
      en: [/Disconnect Google/, /revoke/i, /delete the Google refresh token/, /Also delete the FamCal copies from Google/, /FamCal · <name>/, /Copies you chose to keep stay in Google/, /no Google account id or email is kept/],
      he: [/ניתוק Google/, /מבטלים את הגישה/, /אסימון/, /למחוק גם את העותקים של FamCal מ-Google/, /FamCal · <שם>/, /עותקים שבחרת להשאיר נשארים ב-Google/, /לא נשמר מזהה או כתובת של חשבון Google/],
      ru: [/Отключить Google/, /отзываем доступ/, /токен/, /Также удалить копии FamCal из Google/, /FamCal · <название>/, /Копии, которые вы решили оставить, остаются в Google/, /идентификатор и адрес аккаунта Google не сохраняются/],
    };
    const old = [/When you disconnect your Google Calendar or delete your account/, /כאשר אתה מנתק את יומן Google או מוחק את חשבונך/, /Когда вы отключаете Google Calendar или удаляете свой аккаунт/];
    for (const [i, l] of LOCALES.entries()) {
      const page = await PrivacyPage({ params: Promise.resolve({ locale: l }) });
      const text = textOf(renderToString(page as ReactElement));
      for (const re of want[l]) assert(re.test(text), `${l}: ${re} missing`);
      assert(!old[i].test(text), `${l}: the old promise is still there`);
    }
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
