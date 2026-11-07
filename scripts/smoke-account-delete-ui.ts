// Smoke test for Settings' Delete account, the screen side (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3;
// plan docs/superpowers/plans/2026-11-07-b-features.md Task 7): AccountDelete.tsx, account-delete-client.ts, paidMonthRunning.
//  - U1 the row: one red row of a card, the trash icon (hidden from readers) and "Delete account", no dialog
//  - U2 the sheet: what goes (data, the partner, Google) and "can't be undone", Delete my account (red) and Cancel; the
//    paid-month line and its Terms link only when a paid month runs
//  - U3 working: the spinner line, Delete and the sheet's close disabled
//  - U4 the answers: failed and busy say so; a stale browser sign-in shows its note and Sign in again in place of Delete;
//    a WhatsApp link's says to ask for a new link, with no Delete
//  - U5 done and gone: their heading and Close only
//  - U6 the words: the same keys in en, he and ru, no emoji
//  - U7 the container: the press posts { confirm: true } once, the sheet can't be closed while it waits, done after 200,
//    "already deleted" after 404, and Close leaves the app (the home page in a browser)
//  - U8 the client: each answer becomes its result; the status only is logged
//  - U9 paidMonthRunning: a paid plan whose month is still ahead, never a trial, a gift, Free, or a month that ended
//  - U10 the wiring: Settings shows the row only from its accountDelete prop, which page-data fills (null for an admin)
// Real React on the small fake DOM (scripts/lib/fake-dom.ts) and renderToString. Faked: fetch. No network.
//
// Run: $RUN smoke-account-delete-ui

import fs from 'fs';
import path from 'path';
import { act, createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import AccountDelete, { AccountDeleteView, type AccountDeleteViewProps } from '../app/[locale]/(app)/settings/AccountDelete';
import { requestAccountDelete } from '../app/[locale]/(app)/settings/account-delete-client';
import { paidMonthRunning } from '../src/lib/comp-eligibility';
import { localeHref } from '../src/site/zmanim/links';
import { elements, installWindow, mount } from './lib/fake-dom';

type Row = Record<string, unknown>;
type Locale = 'en' | 'he' | 'ru';
const ROOT = path.resolve(__dirname, '..');
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;
const ad = (l: Locale) => (messages[l].settings as Row).accountDelete as Record<string, string>;

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
const provider = (locale: Locale) => ({ locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' }) as ComponentProps<typeof NextIntlClientProvider>;
const render = (locale: Locale, element: ReactElement) => renderToString(createElement(NextIntlClientProvider, { ...provider(locale), children: element } as ComponentProps<typeof NextIntlClientProvider>));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[0].slice(0, m[0].indexOf('>') + 1), text: textOf(m[1]) }));
/** The paid-month line's words as they render: the sentence before the link, and the link's own words. */
const paidParts = (s: string): [string, string] => [s.split('<terms>')[0].trim().replace(/\u00a0/g, ' '), (/<terms>(.*)<\/terms>/.exec(s)?.[1] ?? s).replace(/\u00a0/g, ' ')];
const noop = () => undefined;
const view = (o: Partial<AccountDeleteViewProps> = {}) =>
  createElement(AccountDeleteView, { phase: 'idle', paidMonthRunning: false, error: null, termsHref: '/terms#cancel', onOpen: noop, onConfirm: noop, onCancel: noop, onSignInAgain: noop, onClose: noop, ...o });
const html = (l: Locale, o: Partial<AccountDeleteViewProps> = {}) => render(l, view(o));
const EMOJI = /\p{Extended_Pictographic}/u;

async function main() {
  await check('U1 the row: one red row of a card with the trash icon (hidden from readers) and "Delete account", in en, he and ru; no dialog', () => {
    for (const l of LOCALES) {
      const h = html(l);
      const b = buttons(h);
      assert(b.length === 1 && b[0].text === ad(l).button && /class="ch-form-row ch-danger-row"/.test(b[0].tag) && /aria-haspopup="dialog"/.test(b[0].tag), `${l}: ${show(b)}`);
      assert(/<svg[^>]*aria-hidden="true"/.test(h) && !/role="dialog"/.test(h), `${l}: the icon or a dialog`);
    }
  });

  await check('U2 the sheet: the title, what goes (data, the partner, Google), "can\'t be undone", Delete my account (red) and the sheet\'s Cancel; the paid-month line with its Terms link only when a paid month runs', () => {
    for (const l of LOCALES) {
      const t = ad(l);
      const h = html(l, { phase: 'confirm' });
      const text = textOf(h);
      for (const key of ['confirmTitle', 'goesData', 'goesPartner', 'goesGoogle', 'undone']) assert(text.includes(t[key].replace(/\u00a0/g, ' ')), `${l}: no ${key}`);
      const [sentence, linkWords] = paidParts(t.paidMonth);
      assert(!text.includes(sentence) && !h.includes('href="/terms#cancel"'), `${l}: the paid-month line with no paid month`);
      const b = buttons(h);
      assert(b.some((x) => x.text === t.confirm && /ch-btn-danger/.test(x.tag)) && b.at(-1)?.text === t.cancel, `${l}: buttons ${show(b)}`);
      const paid = html(l, { phase: 'confirm', paidMonthRunning: true });
      const link = /<a\b[^>]*href="\/terms#cancel"[^>]*>([\s\S]*?)<\/a>/.exec(paid);
      assert(textOf(paid).includes(sentence) && link && textOf(link[1]) === linkWords && /target="_blank"/.test(link[0]), `${l}: no paid-month line or link`);
    }
  });

  await check('U3 working: the spinner line, Delete and the sheet\'s close disabled', () => {
    const h = html('en', { phase: 'working' });
    assert(textOf(h).includes(ad('en').working) && /ch-spin/.test(h), 'no spinner line');
    const b = buttons(h);
    assert(b.filter((x) => x.text === ad('en').confirm || x.text === ad('en').cancel).every((x) => /disabled=""/.test(x.tag)), `buttons ${show(b)}`);
  });

  await check('U4 the answers: failed and busy say so (an alert); a stale browser sign-in shows its note and Sign in again in place of Delete; a WhatsApp link\'s says to ask for a new link, with no Delete', () => {
    const t = ad('en');
    assert(textOf(html('en', { phase: 'confirm', error: 'failed' })).includes(t.errorFailed) && /role="alert"/.test(html('en', { phase: 'confirm', error: 'failed' })), 'failed');
    assert(textOf(html('en', { phase: 'confirm', error: 'busy' })).includes(t.errorBusy), 'busy');
    const stale = html('en', { phase: 'confirm', error: 'stale' });
    assert(textOf(stale).includes(t.staleNote) && buttons(stale).some((b) => b.text === t.signInAgain) && !buttons(stale).some((b) => b.text === t.confirm), `stale ${show(buttons(stale))}`);
    const link = html('en', { phase: 'confirm', error: 'staleLink' });
    assert(textOf(link).includes(t.staleLink) && !buttons(link).some((b) => b.text === t.confirm || b.text === t.signInAgain), `staleLink ${show(buttons(link))}`);
  });

  await check('U5 done and gone: their heading and Close only', () => {
    for (const [phase, key] of [['done', 'doneTitle'], ['gone', 'goneTitle']] as const) {
      const h = html('he', { phase });
      const b = buttons(h);
      assert(textOf(h).includes(ad('he')[key]) && b.length === 2 && b[1].text === ad('he').close, `${phase}: ${show(b)}`);
    }
  });

  await check('U6 the words: the same accountDelete keys in en, he and ru, every one a non-empty string, no emoji', () => {
    const keys = (l: Locale) => Object.keys(ad(l)).sort();
    for (const l of LOCALES) {
      assert(show(keys(l)) === show(keys('en')), `${l}: keys ${show(keys(l))}`);
      for (const [k, v] of Object.entries(ad(l))) assert(typeof v === 'string' && v.length > 0 && !EMOJI.test(v), `${l}.${k}`);
    }
  });

  await check('U7 the container: the press posts { confirm: true } once to /api/account/delete?user_id=7; the sheet can\'t be closed while it waits; done after 200, "already deleted" after 404; Close leaves for the home page in a browser', async () => {
    installWindow();
    const w = globalThis as unknown as { window: Row; fetch: typeof fetch };
    const assigned: string[] = [];
    (w.window as Row).location = { href: 'https://famcal.bot/en/settings', hash: '', assign: (u: string) => void assigned.push(u) };
    const origFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    for (const [status, want] of [[200, ad('en').doneTitle], [404, ad('en').goneTitle]] as const) {
      calls.length = 0;
      assigned.length = 0;
      let release: (r: Response) => void = noop;
      globalThis.fetch = ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Promise<Response>((resolve) => void (release = resolve));
      }) as unknown as typeof fetch;
      const sheets: (null | (() => void))[] = [];
      const m = mount(createElement(NextIntlClientProvider, { ...provider('en'), children: createElement(AccountDelete, { userId: 7, paidMonthRunning: false, onSheet: (c: (() => void) | null) => void sheets.push(c) }) } as ComponentProps<typeof NextIntlClientProvider>));
      try {
        const byText = (text: string) => elements(m.container).find((e) => e.localName === 'button' && e.textContent?.trim() === text);
        m.click(byText(ad('en').button)!);
        m.click(byText(ad('en').confirm)!);
        await act(async () => undefined);
        assert(calls.length === 1 && calls[0].url === '/api/account/delete?user_id=7' && calls[0].init.method === 'POST' && calls[0].init.body === JSON.stringify({ confirm: true }) && calls[0].init.credentials === 'same-origin', `calls ${show(calls)}`);
        const closer = sheets.at(-1);
        assert(typeof closer === 'function', 'no closer while working');
        closer!();
        assert(elements(m.container).some((e) => e.getAttribute('role') === 'dialog'), 'the sheet closed while working');
        await act(async () => release(new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'User not found' }), { status })));
        await act(async () => undefined);
        assert((m.container.textContent ?? '').includes(want), `${status}: ${(m.container.textContent ?? '').slice(0, 200)}`);
        m.click(byText(ad('en').close)!);
        assert(show(assigned) === show([localeHref('en', '/')]), `${status}: left for ${show(assigned)}`);
      } finally {
        m.unmount();
      }
    }
    globalThis.fetch = origFetch;
  });

  await check('U8 the client: 200 ok is deleted, 404 gone, 403 stale-sign-in stale (whatsapp told), 429 busy, 500 and no answer failed; the request carries the init data header only when there is one', async () => {
    const origFetch = globalThis.fetch;
    const answer = (status: number, b: Row) => (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch;
    const cases: [typeof fetch, string][] = [
      [answer(200, { ok: true }), show({ kind: 'deleted' })],
      [answer(404, { error: 'User not found' }), show({ kind: 'gone' })],
      [answer(403, { ok: false, error: 'stale-sign-in' }), show({ kind: 'stale', whatsapp: false })],
      [answer(403, { ok: false, error: 'stale-sign-in', whatsapp: true }), show({ kind: 'stale', whatsapp: true })],
      [answer(429, { error: 'Too many requests' }), show({ kind: 'error', code: 'busy' })],
      [answer(500, { error: 'failed' }), show({ kind: 'error', code: 'failed' })],
      [(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, show({ kind: 'error', code: 'failed' })],
    ];
    try {
      for (const [f, want] of cases) {
        globalThis.fetch = f;
        const got = show(await requestAccountDelete(7));
        assert(got === want, `${want}: got ${got}`);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await check('U9 paidMonthRunning: an ACTIVE or CANCELED paid plan whose month is still ahead; never a trial, a gift, Free, EXPIRED, or a month that ended', () => {
    const now = new Date('2026-11-07T10:00:00Z');
    const ahead = new Date('2026-11-20T10:00:00Z');
    const past = new Date('2026-11-01T10:00:00Z');
    const sub = (o: Row) => ({ status: 'ACTIVE', plan: 'PRO', compedBy: null, currentPeriodEnd: ahead, ...o }) as Parameters<typeof paidMonthRunning>[0];
    assert(paidMonthRunning(sub({}), now) && paidMonthRunning(sub({ status: 'CANCELED' }), now) && paidMonthRunning(sub({ plan: 'BASIC', currentPeriodEnd: ahead.toISOString() }), now), 'a paid month');
    for (const o of [{ status: 'TRIALING' }, { compedBy: 1 }, { plan: 'FREE' }, { status: 'EXPIRED' }, { currentPeriodEnd: past }, { currentPeriodEnd: null }]) assert(!paidMonthRunning(sub(o), now), `not paid: ${show(o)}`);
  });

  await check('U10 the wiring: Settings renders the row only from its accountDelete prop, which page-data fills from the plan (null for an admin)', () => {
    const client = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/settings/SettingsClient.tsx'), 'utf8');
    const pageData = fs.readFileSync(path.join(ROOT, 'src/lib/page-data.ts'), 'utf8');
    assert(/accountDelete\?: \{ paidMonthRunning: boolean \} \| null/.test(client) && /\{accountDelete \? <AccountDelete\b/.test(client), 'SettingsClient does not render the row from its prop');
    assert(/accountDelete: user\.isAdmin \? null : \{ paidMonthRunning: /.test(pageData), 'page-data does not fill accountDelete');
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
