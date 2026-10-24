// Smoke test for the Mini App side of "Disconnect Google"
// (docs/superpowers/specs/2026-10-25-disconnect-google-design.md): Settings' Google section
// and its confirmation (app/[locale]/settings/GoogleDisconnect.tsx), the request helper
// (google-disconnect-client.ts), the copy in en, he and ru, the admin timeline's wording of
// the activity row, and the privacy page's promise. Rendered through next-intl with the real
// messages. No network, no DB, no Redis.
//
// Run: TZ=UTC npx tsx scripts/smoke-google-disconnect-ui.ts (and TZ=Asia/Jerusalem)

import fs from 'fs';
import path from 'path';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { GoogleDisconnectView, GOOGLE_DISCONNECT_CSS, type GoogleDisconnectViewProps } from '../app/[locale]/settings/GoogleDisconnect';
import { requestDisconnect } from '../app/[locale]/settings/google-disconnect-client';
import { activityDetail } from '../src/lib/admin-activity';
import PrivacyPage from '../app/[locale]/privacy/page';

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

function render(locale: Locale, element: ReactElement): string {
  const provider = { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as ComponentProps<typeof NextIntlClientProvider>;
  return renderToString(createElement(NextIntlClientProvider, { ...provider, children: element } as ComponentProps<typeof NextIntlClientProvider>));
}
const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[0].slice(0, m[0].indexOf('>') + 1), text: textOf(m[1]) }));
const noop = () => undefined;
const view = (o: Partial<GoogleDisconnectViewProps> = {}) =>
  createElement(GoogleDisconnectView, { connected: true, phase: 'idle', deleteCopies: true, leftover: [], error: null, onOpen: noop, onToggleCopies: noop, onConfirm: noop, onCancel: noop, onClose: noop, ...o });
const html = (l: Locale, o: Partial<GoogleDisconnectViewProps> = {}) => render(l, view(o));
const EMOJI = /\p{Extended_Pictographic}/u;

async function main() {
  await check('section: connected shows the title, the hint and one "Disconnect Google" button, in en, he and ru', () => {
    for (const l of LOCALES) {
      const h = html(l);
      const t = gd(l);
      assert(textOf(h).includes(t.sectionTitle) && textOf(h).includes(t.sectionHint), `${l} text ${textOf(h)}`);
      const b = buttons(h);
      assert(b.length === 1 && b[0].text === t.button && /type="button"/.test(b[0].tag), `${l} buttons ${show(b)}`);
    }
  });

  await check('section: not connected and nothing open renders nothing', () => {
    assert(html('en', { connected: false }) === '', `rendered ${html('en', { connected: false })}`);
  });

  await check('confirm: a dialog with the title, the explanation, the copies checkbox ticked by default and Cancel / Disconnect', () => {
    for (const l of LOCALES) {
      const h = html(l, { phase: 'confirm' });
      const t = gd(l);
      assert(/role="dialog"/.test(h) && /aria-modal="true"/.test(h), `${l} not a modal dialog`);
      const text = textOf(h);
      assert(text.includes(t.confirmTitle) && text.includes(t.confirmBody) && text.includes(t.copiesLabel) && text.includes(t.copiesHint), `${l} text ${text}`);
      // Copies the user chose to Keep are untouched (owner's call), and others on the same Google account must reconnect.
      assert(t.copiesKeptNote && text.includes(t.copiesKeptNote), `${l} no note that kept copies stay`);
      assert(t.confirmShared && text.includes(t.confirmShared), `${l} no line about others on the same Google account`);
      const box = h.match(/<input\b[^>]*type="checkbox"[^>]*>/);
      assert(box && /checked=""/.test(box[0]), `${l} checkbox ${box?.[0]}`);
      assert(/<label\b[^>]*>[\s\S]*<input\b[^>]*type="checkbox"/.test(h) || /<input\b[^>]*id="([^"]+)"[\s\S]*<label\b[^>]*for="\1"/.test(h), `${l} checkbox has no label`);
      const names = buttons(h).map((b) => b.text);
      assert(names.includes(t.cancel) && names.includes(t.confirm), `${l} buttons ${show(names)}`);
    }
  });

  await check('confirm: the box unticked when deleteCopies is false', () => {
    const box = html('en', { phase: 'confirm', deleteCopies: false }).match(/<input\b[^>]*type="checkbox"[^>]*>/);
    assert(box && !/checked/.test(box[0]), `checkbox ${box?.[0]}`);
  });

  await check('confirm: the failure line never claims nothing changed (Google may already have revoked the token), in en, he and ru', () => {
    const claims = { en: /nothing was changed/i, he: /שום דבר לא השתנה/, ru: /ничего не изменилось/i };
    for (const l of LOCALES) assert(!claims[l].test(gd(l).errorFailed), `${l}: ${gd(l).errorFailed}`);
  });

  await check('confirm: an error line (role=alert) in words, never a raw code', () => {
    for (const l of LOCALES) {
      for (const [code, key] of [['failed', 'errorFailed'], ['busy', 'errorBusy']] as const) {
        const h = html(l, { phase: 'confirm', error: code });
        assert(/role="alert"/.test(h) && textOf(h).includes(gd(l)[key]), `${l} ${code}: ${textOf(h)}`);
      }
    }
  });

  await check('working: both buttons disabled, a spinner and the working line; the checkbox is disabled too', () => {
    for (const l of LOCALES) {
      const h = html(l, { phase: 'working' });
      assert(textOf(h).includes(gd(l).working) && /gd-spin/.test(h), `${l} no working line or spinner`);
      assert(buttons(h.slice(h.indexOf('role="dialog"'))).every((b) => /disabled=""/.test(b.tag)), `${l} a dialog button is enabled: ${show(buttons(h))}`);
      assert(/<input\b[^>]*type="checkbox"[^>]*disabled=""/.test(h) || /<input\b[^>]*disabled=""[^>]*type="checkbox"/.test(h), `${l} checkbox enabled`);
    }
  });

  await check('done: "disconnected" with Done; the copy calendars that stayed are listed, one item each; none listed when none stayed', () => {
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

  await check('look: classes only from the gd- set, icons hidden from screen readers, no raw key, no emoji, in every phase and language', () => {
    for (const phase of ['idle', 'confirm', 'working', 'done'] as const) {
      for (const l of LOCALES) {
        const h = html(l, { phase, leftover: phase === 'done' ? ['FamCal · Home'] : [] }).replace(/<style>[\s\S]*?<\/style>/, '');
        for (const cls of h.match(/class="[^"]*"/g) ?? []) assert(cls.slice(7, -1).split(' ').every((c) => c.startsWith('gd-') || c.startsWith('lucide')), `${l}/${phase} ${cls}`);
        assert(!/googleDisconnect|settings\./.test(textOf(h)) && !EMOJI.test(textOf(h)), `${l}/${phase} raw key or emoji`);
        for (const svg of h.match(/<svg\b[^>]*>/g) ?? []) assert(/aria-hidden="true"/.test(svg), `${l}/${phase} an icon is read aloud: ${svg}`);
      }
    }
  });

  await check('css: 44 px targets, no hover-only styling, logical properties only (RTL), a dark scheme for the dialog, 16px+ section title, no font under 12px', () => {
    const css = GOOGLE_DISCONNECT_CSS;
    assert(/\.gd-btn \{[^}]*min-height: 44px/.test(css) && /\.gd-check \{[^}]*min-height: 44px/.test(css), 'tap targets');
    assert(!/:hover/.test(css), 'hover rule');
    assert(!/(?:margin|padding|border)-(?:left|right)|text-align: (?:left|right)|(?:^|[\s;{])(?:left|right):/m.test(css), `physical direction: ${css.match(/(?:margin|padding|border)-(?:left|right)|text-align: (?:left|right)|[\s;{](?:left|right):/)?.[0]}`);
    assert(/@media \(prefers-color-scheme: dark\)[\s\S]*\.gd-dialog[\s\S]*\.gd-btn-confirm/.test(css), 'dark scheme');
    assert(!/font-size: (?:\d|1[01])px/.test(css), 'a font under 12px');
  });

  await check('css: the Disconnect button reads at 4.5:1 or better in light and in dark', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const dark = GOOGLE_DISCONNECT_CSS.slice(GOOGLE_DISCONNECT_CSS.indexOf('@media (prefers-color-scheme: dark)'));
    for (const [label, css] of [['light', GOOGLE_DISCONNECT_CSS.slice(0, GOOGLE_DISCONNECT_CSS.indexOf('@media'))], ['dark', dark]] as const) {
      const rule = css.match(/\.gd-btn-confirm \{([^}]*)\}/)?.[1] ?? '';
      const bg = rule.match(/background: (#[0-9a-f]{6})/i)?.[1];
      const fg = rule.match(/(?:^|[\s;])color: (#[0-9a-f]{6})/i)?.[1];
      assert(bg && fg, `${label}: ${rule}`);
      assert(ratio(bg, fg) >= 4.5, `${label}: ${fg} on ${bg} is ${ratio(bg, fg).toFixed(2)}:1`);
    }
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
    const client = fs.readFileSync(path.join(ROOT, 'app/[locale]/settings/SettingsClient.tsx'), 'utf8');
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
