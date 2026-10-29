// Smoke test for the calendars page's "Copy to Google" rows (google-sync spec §1 Where it
// lives, §5 Copy; plan Task S4; W4-1 moved the rows onto the form kit): app/[locale]/(app)/calendars/GoogleCopyRow.tsx
// and its client helpers (google-copy-client.ts), rendered through next-intl with the real
// messages in en, he and ru. It checks:
//  - each state's row: off, copying (with and without progress), copied, "N can't be copied",
//    Approve in Google, the consent wait, Needs reconnect, paused on the plan, gone with
//    "Create it again", another account with "Copy again", error;
//  - the switch: role="switch", aria-checked, its label naming the calendar, disabled while busy
//    (or while another request of the page runs) with the busy line and a spinner;
//  - the Remove / Keep question (spec §1's wording, now asked by the page in a sheet, not by the
//    row), and the non-owner line with the owner's name; the notes (one way, alerts, Hebrew dates);
//  - the copy in en, he and ru: plurals per language, numbers grouped per locale, no raw key,
//    no emoji;
//  - the markup is the form kit's: every control a ch-form-row (a 48 px row), no Tailwind class,
//    a status that needs the person in the danger colour, icons hidden from screen readers;
//  - the client helpers against a fake fetch: the request shapes (initData in the header,
//    never the URL), consent vs on, the error codes, what each status offers, and polling.
// No network, no DB, no Redis.
//
// Run: TZ=UTC npx tsx scripts/smoke-calendars-google-copy.ts (and TZ=Asia/Jerusalem)

import fs from 'fs';
import path from 'path';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { GoogleCopyRow, GoogleCopyNotes, NonOwnerCopyLine, isolate, type GoogleCopyRowProps } from '../app/[locale]/(app)/calendars/GoogleCopyRow';
import { consentWait, copyAction, deleteCalendarBody, loadCopies, needsPolling, recreateCopy, startCopy, stopCopy, waitExpired, waitHolds } from '../app/[locale]/(app)/calendars/google-copy-client';
import { OAUTH_STATE_TTL_MS } from '../src/lib/oauth-state';
import { FORM_CSS } from '../components/app-ui/form-kit';
import { lintCss } from './lib/css-lint';
import type { CopyRow } from '../src/services/google-sync/view';

type Row = Record<string, unknown>;
type Locale = 'en' | 'he' | 'ru';
const ROOT = path.resolve(__dirname, '..');
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;
const gc = (l: Locale) => messages[l].googleCopy as Record<string, Record<string, string> & string>;

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
  return renderToString(createElement(NextIntlClientProvider, provider, element));
}
/** The visible text, entities decoded, tags dropped. */
const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const baseRow = (o: Partial<CopyRow> = {}): CopyRow => ({ calendarId: 'cal-1', linkId: 'link-1', on: true, status: 'copied', copied: 0, total: 0, unsupported: 0, consentOpen: false, ...o });
const noop = () => undefined;
function props(o: Partial<GoogleCopyRowProps> = {}, row: Partial<CopyRow> = {}): GoogleCopyRowProps {
  return {
    calendarName: 'Home', row: baseRow(row), busy: null, waiting: false, error: null,
    onToggle: noop, onAction: noop, onOpenGoogle: noop, ...o,
  };
}
const rowHtml = (locale: Locale, o: Partial<GoogleCopyRowProps> = {}, row: Partial<CopyRow> = {}) => render(locale, createElement(GoogleCopyRow, props(o, row)));
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[0].slice(0, m[0].indexOf('>') + 1), text: textOf(m[1]) }));
const switchOf = (html: string) => buttons(html).find((b) => /role="switch"/.test(b.tag));

const EMOJI = /\p{Extended_Pictographic}/u;

async function main() {
  // ---- Each state's row ----

  await check('off: the calendar\'s name on a switch row that is off, labelled with the calendar, and no status line', async () => {
    for (const l of LOCALES) {
      const html = rowHtml(l, {}, { on: false, status: 'off', linkId: null });
      const sw = switchOf(html);
      assert(sw && /aria-checked="false"/.test(sw.tag), `${l}: switch ${show(sw)}`);
      assert(sw.tag.includes(`aria-label="${gc(l).switchLabel.replace('{name}', 'Home').replace(/"/g, '&quot;')}"`), `${l}: switch label ${sw.tag}`);
      assert(textOf(html) === 'Home', `${l}: text ${textOf(html)}`);
      assert(/<button[^>]*class="ch-form-row"/.test(html) && /<span class="ch-switch"/.test(html), `${l}: the kit's switch row: ${html.slice(0, 300)}`);
    }
  });

  await check('copying: "Copying…" until the backfill is counted, then "Copying… 340 of 1,200" with the numbers grouped per locale', async () => {
    assert(textOf(rowHtml('en', {}, { status: 'copying' })).includes('Copying…'), 'no copying line');
    assert(!/of/.test(textOf(rowHtml('en', {}, { status: 'copying' }))), 'a count with no total');
    const en = textOf(rowHtml('en', {}, { status: 'copying', copied: 340, total: 1200 }));
    assert(en.includes('Copying… 340 of 1,200'), `en ${en}`);
    const he = textOf(rowHtml('he', {}, { status: 'copying', copied: 340, total: 1200 }));
    assert(he.includes('מעתיקים… 340 מתוך 1,200'), `he ${he}`);
    const ru = textOf(rowHtml('ru', {}, { status: 'copying', copied: 340, total: 1200 }));
    assert(/Копируем… 340 из 1\s200/u.test(ru), `ru ${ru}`);
    assert(/aria-checked="true"/.test(switchOf(rowHtml('en', {}, { status: 'copying' }))!.tag), 'the switch is not on');
  });

  await check('copied, and "N can\'t be copied" with each language\'s plural forms', async () => {
    assert(textOf(rowHtml('en')).includes('Copied to Google'), 'no copied line');
    const want: Record<Locale, Array<[number, RegExp]>> = {
      en: [[1, /1 event can't be copied/], [3, /3 events can't be copied/]],
      he: [[1, /אירוע אחד לא ניתן להעתקה/], [2, /שני אירועים לא ניתנים להעתקה/], [5, /5 אירועים לא ניתנים להעתקה/]],
      ru: [[1, /1 событие не удаётся/], [3, /3 события не удаётся/], [5, /5 событий не удаётся/], [21, /21 событие не удаётся/]],
    };
    for (const l of LOCALES) {
      for (const [n, re] of want[l]) {
        const t = textOf(rowHtml(l, {}, { unsupported: n }));
        assert(re.test(t), `${l} ${n}: ${t}`);
      }
      assert(!/событ|event|אירוע/.test(textOf(rowHtml(l, {}, { unsupported: 0 }))), `${l}: a can't-be-copied line for 0`);
    }
  });

  await check('the states that need the user: each line and its one action button (Approve in Google, Reconnect Google, Create it again, Copy again); plan and error offer none', async () => {
    const cases: Array<[CopyRow['status'], string, string | null]> = [
      ['approve', 'approve', 'approve'],
      ['reconnect', 'reconnect', 'reconnect'],
      ['gone', 'gone', 'recreate'],
      ['otherAccount', 'otherAccount', 'copyAgain'],
      ['plan', 'plan', null],
      ['error', 'error', null],
    ];
    for (const l of LOCALES) {
      for (const [status, line, action] of cases) {
        const html = rowHtml(l, {}, { status });
        const t = textOf(html);
        assert(t.includes(gc(l).status[line]), `${l} ${status}: no line in ${t}`);
        const actions = buttons(html).filter((b) => !/role="switch"/.test(b.tag));
        if (action) assert(actions.length === 1 && actions[0].text === gc(l).actions[action], `${l} ${status}: actions ${show(actions)}`);
        else assert(actions.length === 0, `${l} ${status}: actions ${show(actions)}`);
      }
    }
    // The spec's own words (en)
    assert(textOf(rowHtml('en', {}, { status: 'plan' })).includes('Copying is paused on your plan.'), 'plan wording');
    assert(textOf(rowHtml('en', {}, { status: 'otherAccount' })).includes('This is a different Google account. Copy again from scratch?'), 'other account wording');
    assert(textOf(rowHtml('en', {}, { status: 'gone' })).includes('Create it again'), 'gone wording');
  });

  await check('the consent wait: "Approve in Google, then tap the link FamCal sends you." with an Open Google button, also on a copy that is off', async () => {
    for (const l of LOCALES) {
      for (const row of [{ on: false, status: 'off' as const }, { status: 'approve' as const }]) {
        const html = rowHtml(l, { waiting: true }, row);
        const t = textOf(html);
        assert(t.includes(gc(l).status.waiting), `${l} ${row.status}: ${t}`);
        const actions = buttons(html).filter((b) => !/role="switch"/.test(b.tag));
        assert(actions.length === 1 && actions[0].text === gc(l).actions.openGoogle, `${l} ${row.status}: ${show(actions)}`);
      }
    }
    assert(textOf(rowHtml('en', { waiting: true }, { on: false, status: 'off' })).includes('Approve in Google, then tap the link FamCal sends you.'), 'spec wording');
  });

  await check('busy: the switch is disabled with aria-busy, a spinner and the busy line instead of the status; no action button while busy', async () => {
    for (const l of LOCALES) {
      for (const busy of ['on', 'off', 'working'] as const) {
        const html = rowHtml(l, { busy }, { status: 'gone' });
        const sw = switchOf(html)!;
        assert(/\bdisabled=""/.test(sw.tag) && /aria-busy="true"/.test(sw.tag), `${l} ${busy}: switch ${sw.tag}`);
        const t = textOf(html);
        assert(t.includes(gc(l).busy[busy]) && !t.includes(gc(l).status.gone), `${l} ${busy}: ${t}`);
        assert(/ch-form-spinner/.test(html) && /ch-working/.test(html), `${l} ${busy}: no spinner`);
        assert(buttons(html).length === 1, `${l} ${busy}: buttons ${show(buttons(html))}`);
      }
    }
  });

  await check('the switch is named for the calendar and described by what the copy is doing: the status line, the wait for Google\'s consent, the busy line and "N can\'t be copied" (a switch\'s children are not read, so each line has an id and the switch points at the ones shown); a row with nothing to say has no description', async () => {
    const described = (html: string) => {
      const tag = switchOf(html)!.tag;
      const ids = (/aria-describedby="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean);
      return ids.map((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = new RegExp(`<span[^>]*\\bid="${escaped}"[^>]*>([\\s\\S]*?)</span>(?=<|$)`).exec(html);
        assert(hit, `aria-describedby="${id}" points at nothing in ${html}`);
        return textOf(hit[1]);
      }).join(' ');
    };
    for (const l of LOCALES) {
      const g = gc(l);
      assert(!/aria-describedby/.test(switchOf(rowHtml(l, {}, { on: false, status: 'off', linkId: null }))!.tag), `${l}: a description for a plain off row`);
      for (const status of ['copied', 'approve', 'reconnect', 'plan', 'gone', 'otherAccount', 'error'] as const) {
        const html = rowHtml(l, {}, { status });
        assert(described(html) === g.status[status], `${l} ${status}: described by ${show(described(html))}`);
        assert(/aria-label="/.test(switchOf(html)!.tag), `${l} ${status}: the label is gone`);
      }
      assert(described(rowHtml(l, {}, { status: 'copying', copied: 3, total: 9 })) === g.status.copyingCount.replace('{copied, number}', '3').replace('{total, number}', '9'), `${l}: copying with a count: ${described(rowHtml(l, {}, { status: 'copying', copied: 3, total: 9 }))}`);
      assert(described(rowHtml(l, { waiting: true }, { on: false, status: 'off' })) === g.status.waiting, `${l}: the wait`);
      assert(described(rowHtml(l, { busy: 'off' })) === g.busy.off, `${l}: busy: ${described(rowHtml(l, { busy: 'off' }))}`);
      const two = described(rowHtml(l, {}, { status: 'copied', unsupported: 2 }));
      assert(two.startsWith(g.status.copied) && two.length > g.status.copied.length, `${l}: status and the count: ${two}`);
    }
    // Two lines, two ids, none repeated
    const html = rowHtml('en', {}, { status: 'approve', unsupported: 2 });
    const ids = (/aria-describedby="([^"]*)"/.exec(switchOf(html)!.tag)?.[1] ?? '').split(/\s+/);
    assert(ids.length === 2 && new Set(ids).size === 2, `the ids: ${show(ids)}`);
  });

  await check('an error under the row: the code\'s message, in the language, as an alert', async () => {
    for (const l of LOCALES) {
      for (const code of ['failed', 'upgrade', 'notFound', 'openFailed'] as const) {
        const html = rowHtml(l, { error: code });
        assert(textOf(html).includes(gc(l).errors[code]) && /role="alert"/.test(html), `${l} ${code}: ${textOf(html)}`);
      }
    }
  });

  await check('the unlink question (asked by the page in a sheet, not by the row): spec §1\'s words with the copy calendar\'s name, Remove and Keep and Cancel in every language; a right-to-left name is isolated inside the sentence; the row itself no longer carries it', async () => {
    const question = (l: Locale, name: string) => gc(l).unlink.question.replace('{name}', isolate(name));
    assert(question('en', 'Home').replace(/[\u2068\u2069]/g, '') === 'Delete the calendar “FamCal · Home” from Google too, including anything you added to it?', `en ${question('en', 'Home')}`);
    for (const l of LOCALES) {
      for (const k of ['question', 'remove', 'keep', 'cancel']) assert(typeof gc(l).unlink[k] === 'string' && gc(l).unlink[k].length > 0, `${l}: unlink.${k}`);
      assert(question(l, 'בית').includes('⁨בית⁩'), `${l}: the name is not isolated`);
      // The row, in any state, asks nothing: no Remove, Keep or Cancel button and no question
      for (const status of ['off', 'copying', 'copied', 'approve', 'reconnect', 'plan', 'gone', 'otherAccount', 'error'] as const) {
        const html = rowHtml(l, {}, { status, on: status !== 'off' });
        assert(!buttons(html).some((b) => [gc(l).unlink.remove, gc(l).unlink.keep, gc(l).unlink.cancel].includes(b.text)), `${l} ${status}: a Remove / Keep / Cancel button in the row`);
        assert(!textOf(html).includes('FamCal · '), `${l} ${status}: the question in the row`);
      }
    }
    // A name in the row keeps its own direction
    assert(/<bdi dir="auto">בית<\/bdi>/.test(rowHtml('he', { calendarName: 'בית' })), 'the Hebrew name is not in a <bdi dir="auto">');
  });

  await check('locked: while another request of the page runs the switch and the action are disabled, and the row shows no busy line of its own', async () => {
    for (const l of LOCALES) {
      const html = rowHtml(l, { locked: true }, { status: 'gone' });
      assert(buttons(html).length === 2 && buttons(html).every((b) => /\bdisabled=""/.test(b.tag)), `${l}: ${show(buttons(html))}`);
      assert(!/ch-form-spinner|aria-busy/.test(html), `${l}: busy look on a locked row`);
    }
  });

  await check('the Hebrew-dates note stays true for copies not yet switched to one event per year: it says earlier copies switch on the next sync (en/he/ru)', async () => {
    const earlier = { en: /Copies made earlier switch to this on the next sync/, he: /עותקים שנוצרו קודם יעברו לצורה הזו בסנכרון הקרוב/, ru: /Копии, сделанные раньше, перейдут на этот вид при ближайшей синхронизации/ };
    for (const l of LOCALES) assert(earlier[l as 'en' | 'he' | 'ru'].test(gc(l).notes.hebrew), `${l}: ${gc(l).notes.hebrew}`);
  });

  await check('the non-owner line names the owner, and the notes say one way, alerts from FamCal and Hebrew dates', async () => {
    for (const l of LOCALES) {
      const t = textOf(render(l, createElement(NonOwnerCopyLine, { owner: 'Noa' })));
      assert(t === gc(l).nonOwnerAll.replace('{owner}', 'Noa'), `${l}: ${t}`);
      // It sits once under every calendar the partner shares, so it is plural: no "this one" (the singular key is gone)
      assert(gc(l).nonOwner === undefined, `${l}: the singular key is still there`);
      const notes = textOf(render(l, createElement(GoogleCopyNotes)));
      for (const k of ['oneWay', 'alerts', 'hebrew']) assert(notes.includes(gc(l).notes[k]), `${l}: no ${k} in ${notes}`);
    }
    assert(textOf(render('en', createElement(GoogleCopyNotes))).includes('Alerts come from FamCal, not from the Google copy.'), 'spec wording');
    assert(textOf(render('en', createElement(NonOwnerCopyLine, { owner: 'Noa' }))) === 'Only Noa can copy these to Google.', 'spec wording');
    assert(gc('he').nonOwnerAll === 'את היומנים האלה אפשר להעתיק ל־Google רק מהחשבון של {owner}.' && gc('ru').nonOwnerAll === 'Скопировать эти календари в Google может только {owner}.', 'he and ru wording');
  });

  // ---- Copy and CSS ----

  const everything = (l: Locale) => {
    const statuses: CopyRow['status'][] = ['off', 'copying', 'copied', 'approve', 'reconnect', 'plan', 'gone', 'otherAccount', 'error'];
    return [
      ...statuses.map((status) => rowHtml(l, {}, { status, on: status !== 'off', copied: 3, total: 9, unsupported: 2 })),
      rowHtml(l, { waiting: true }), rowHtml(l, { locked: true }), rowHtml(l, { busy: 'on' }), rowHtml(l, { error: 'failed' }),
      render(l, createElement(NonOwnerCopyLine, { owner: 'Noa' })), render(l, createElement(GoogleCopyNotes)),
    ].join('\n');
  };

  await check('copy: no raw key, no ICU leftovers, no emoji, in every language; Hebrew and Russian are their own text, not English', async () => {
    for (const l of LOCALES) {
      const t = textOf(everything(l));
      assert(!/googleCopy\.|\{|\}|\bundefined\b/.test(t), `${l}: raw text in ${t}`);
      assert(!EMOJI.test(t), `${l}: an emoji in ${t}`);
      if (l !== 'en') assert(!t.includes(gc('en').notes.oneWay) && !t.includes(gc('en').status.waiting), `${l}: English text in ${t}`);
    }
    // Hebrew: gender-neutral (no masculine-only second person); Russian: the formal вы
    const he = textOf(everything('he'));
    // ("את" alone is also the object marker, so only "אתה" is checked.)
    assert(!/(^|\s)(אתה|שלך|תאשר|תלחץ|לחץ|הקש)(?=[\s,.?]|$)/.test(he), `he: a gendered form in ${he}`);
    const ru = Object.values(gc('ru')).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v))).join(' ');
    assert(!/(^|\s)(ты|тебе|твой|твои|твоя|нажми|подтверди)(?=[\s,.?]|$)/iu.test(ru) && /вы|ваш/iu.test(ru), `ru: not formal: ${ru}`);
  });

  await check('the markup is the form kit\'s: every button a ch-form-row (the kit draws a 48 px row with a visible focus ring, and FORM_CSS passes the CSS lint), no Tailwind class, a status that needs the person in the danger colour and the others quiet, icons aria-hidden', async () => {
    const html = everything('en');
    for (const b of buttons(html)) assert(/class="ch-form-row(?: ch-action-row)?"/.test(b.tag), `a button that is not a kit row: ${b.tag}`);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
    const tailwind = classes.filter((c) => /^(?:hover:|group-hover:|-?(?:ml|mr|pl|pr|mt|mb|px|py|gap)-\d|min-h-|min-w-|bg-|text-(?:gray|rose|blue|white|xs|sm)|rounded|flex-1|shrink|animate-)/.test(c));
    assert(tailwind.length === 0, `Tailwind classes ${show([...new Set(tailwind)])}`);
    const needs = ['approve', 'reconnect', 'gone', 'otherAccount', 'error'] as const;
    for (const status of needs) assert(/class="ch-form-hint is-danger"/.test(rowHtml('en', {}, { status })), `${status}: not in the danger colour`);
    for (const status of ['copied', 'plan'] as const) assert(/class="ch-form-hint"/.test(rowHtml('en', {}, { status })) && !/is-danger/.test(rowHtml('en', {}, { status })), `${status}: should be quiet`);
    assert(!/is-danger/.test(rowHtml('en', { waiting: true }, { on: false, status: 'off' })), 'the wait line is quiet');
    const svgs = [...html.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
    assert(svgs.length > 0 && svgs.every((s) => /aria-hidden="true"/.test(s)), `icons ${show(svgs.filter((s) => !/aria-hidden="true"/.test(s)))}`);
    const problems = lintCss(FORM_CSS);
    assert(problems.length === 0, `FORM_CSS: ${show(problems)}`);
    assert(/button\.ch-form-row\s*\{[^}]*inline-size:\s*100%/.test(FORM_CSS) && /\.ch-form-row\s*\{[^}]*min-block-size:\s*48px/.test(FORM_CSS), 'the kit\'s row is not a 48 px target');
  });

  // ---- The client helpers ----

  type Call = { url: string; method: string; headers: Record<string, string>; body: Row | null };
  let calls: Call[] = [];
  let answer: (c: Call) => { status: number; body: unknown } | 'throw' = () => ({ status: 200, body: {} });
  (globalThis as Row).window = { Telegram: { WebApp: { initData: 'signed-init-data' } }, location: { hash: '' } };
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const c: Call = {
      url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(c);
    const a = answer(c);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await check('client: loadCopies GETs with the initData header (never in the URL) and returns the view; a failure throws', async () => {
    calls = [];
    answer = () => ({ status: 200, body: { shown: true, ownerName: 'Noa', rows: [baseRow()] } });
    const view = await loadCopies(77);
    assert(view.shown && view.rows.length === 1, `view ${show(view)}`);
    assert(calls[0].url === '/api/google-sync?user_id=77' && calls[0].method === 'GET', `call ${show(calls[0])}`);
    assert(calls[0].headers['x-telegram-init-data'] === 'signed-init-data' && !calls[0].url.includes('signed'), `headers ${show(calls[0])}`);
    answer = () => ({ status: 500, body: { error: 'failed' } });
    let threw = false;
    try { await loadCopies(77); } catch { threw = true; }
    assert(threw, 'a 500 did not throw');
  });

  await check('client: startCopy POSTs enable; on, consent with its URL, or an error code (upgrade, notFound, failed; a network failure is failed)', async () => {
    calls = [];
    answer = () => ({ status: 200, body: { status: 'created' } });
    assert(show(await startCopy(77, 'cal-1')) === show({ kind: 'on' }), 'on');
    assert(calls[0].method === 'POST' && show(calls[0].body) === show({ action: 'enable', nativeCalendarId: 'cal-1' }), `body ${show(calls[0])}`);
    assert(calls[0].headers['x-telegram-init-data'] === 'signed-init-data', 'no initData header');
    answer = () => ({ status: 200, body: { status: 'consent', oauthUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', serverTime: 1 } });
    assert(show(await startCopy(77, 'cal-1')) === show({ kind: 'consent', oauthUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }), 'consent');
    answer = () => ({ status: 200, body: { status: 'consent', oauthUrl: 'javascript:alert(1)' } });
    assert(show(await startCopy(77, 'cal-1')) === show({ kind: 'error', code: 'failed' }), 'a consent URL that is not Google\'s');
    for (const [status, error, code] of [[403, 'upgrade_required', 'upgrade'], [404, 'not_found', 'notFound'], [500, 'failed', 'failed'], [429, 'Too many', 'failed']] as const) {
      answer = () => ({ status, body: { error } });
      assert(show(await startCopy(77, 'cal-1')) === show({ kind: 'error', code }), `${status}`);
    }
    answer = () => 'throw';
    assert(show(await startCopy(77, 'cal-1')) === show({ kind: 'error', code: 'failed' }), 'network');
  });

  await check('client: stopCopy DELETEs with the choice; recreateCopy POSTs the link; the calendar delete carries googleCopy only when asked', async () => {
    calls = [];
    answer = () => ({ status: 200, body: { status: 'off' } });
    assert(show(await stopCopy(77, 'cal-1', 'remove')) === show({ kind: 'ok' }), 'stop');
    assert(calls[0].method === 'DELETE' && show(calls[0].body) === show({ nativeCalendarId: 'cal-1', googleCopy: 'remove' }), `stop ${show(calls[0])}`);
    answer = () => ({ status: 200, body: { status: 'recreated' } });
    assert(show(await recreateCopy(77, 'link-1')) === show({ kind: 'ok' }), 'recreate');
    assert(show(calls[1].body) === show({ action: 'recreate', linkId: 'link-1' }), `recreate ${show(calls[1])}`);
    answer = () => ({ status: 404, body: { error: 'not_found' } });
    assert(show(await stopCopy(77, 'cal-1', 'keep')) === show({ kind: 'error', code: 'notFound' }), 'stop 404');
    assert(show(deleteCalendarBody('keep', 'init')) === show({ initData: 'init', googleCopy: 'keep' }), 'delete keep');
    assert(show(deleteCalendarBody(null, 'init')) === show({ initData: 'init' }), 'delete with no copy');
  });

  await check('client: what each status offers, and polling while a copy is being made or a consent waits', async () => {
    const want: Record<CopyRow['status'], string | null> = {
      off: null, copying: null, copied: null, plan: null, error: null, approve: 'consent', reconnect: 'reconnect', gone: 'recreate', otherAccount: 'recreate',
    };
    for (const [status, action] of Object.entries(want)) assert(copyAction(status as CopyRow['status']) === action, `${status}: ${copyAction(status as CopyRow['status'])}`);
    assert(needsPolling([baseRow({ status: 'copying' })], 0) && needsPolling([baseRow()], 1) && !needsPolling([baseRow(), baseRow({ status: 'gone' })], 0), 'polling');
  });

  await check('client: a consent wait holds only while its consent can still be used: its state token\'s 10 minutes, the row unchanged since it began, and the server still holding the consent; a wait begun after the GET was sent is kept as is', () => {
    const t0 = 1_000_000;
    const off = baseRow({ on: false, status: 'off', linkId: null });
    // GETs are numbered in the order sent; the wait began after GET 3 was asked, so GET 4 is the first that knows its consent.
    const w = consentWait('https://accounts.google.com/x', off, t0, 3);
    assert(w.url === 'https://accounts.google.com/x' && w.startedAt === t0 && w.afterAsk === 3, `wait ${show(w)}`);
    const asked = 4;
    assert(waitHolds(w, { ...off, consentOpen: true }, asked, t0 + 2000), 'a live consent on an unchanged row');
    assert(!waitHolds(w, { ...off, consentOpen: false }, asked, t0 + 2000), 'the consent was used or expired on the server');
    assert(!waitHolds(w, baseRow({ status: 'approve', consentOpen: true }), asked, t0 + 2000), 'the row turned on in approve (a commit without the permission)');
    assert(!waitHolds(w, baseRow({ status: 'copying', consentOpen: true }), asked, t0 + 2000), 'the copy landed');
    assert(!waitHolds(w, undefined, asked, t0 + 2000), 'the calendar is gone');
    assert(!waitHolds(w, { ...off, consentOpen: true }, asked, t0 + OAUTH_STATE_TTL_MS), 'past the state\'s 10 minutes');
    assert(waitHolds(w, { ...off, consentOpen: false }, 3, t0), 'a GET sent before the wait began can\'t know its consent, even in the same millisecond');
    assert(!waitHolds(w, { ...off, consentOpen: false }, 4, t0), 'a GET sent after the wait began, even in the same millisecond, ends it once the consent is used');
    assert(!waitExpired(w, t0 + OAUTH_STATE_TTL_MS - 1) && waitExpired(w, t0 + OAUTH_STATE_TTL_MS), 'expiry');
    const stopped = consentWait('https://accounts.google.com/y', baseRow({ status: 'approve' }), t0, 3);
    assert(waitHolds(stopped, baseRow({ status: 'approve', consentOpen: true }), asked, t0 + 2000), 'a stopped copy\'s wait while its consent is live');
    assert(!waitHolds(stopped, baseRow({ status: 'approve', consentOpen: false }), asked, t0 + 2000), 'a stopped copy\'s consent used without the permission: the row is unchanged, but the consent is gone');
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
