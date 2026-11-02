// Smoke test for the fixes the web makes visible (web sign-in spec
// docs/superpowers/specs/2026-11-02-web-sign-in-design.md §2.14; plan Task 10).
//
// What it pins:
//   - Send to chat follows the session's sign-in method (resolveCommandTargetOrReason): a
//     'wa' session (the WhatsApp link, and any cookie from before web sign-in) answers on
//     WhatsApp; a Telegram, Google or email session answers on Telegram, also for an account
//     that has both chats; a WhatsApp-only account signed in another way gets 'wa_link_needed'
//     (WhatsApp refuses free replies after 24 hours); Telegram initData and the operator
//     answer on Telegram. The sheet names the chat the route used.
//   - "Open FamCal in Telegram" shows in a browser only to a WhatsApp-only account
//     (hasTelegram === false); an account with Telegram, or one nobody told, never sees it.
//   - The admin entry in the menu shows only inside Telegram.
//   - The Calendars screen's copy poll and the home's day check wait while the tab is hidden
//     and take up again on show (src/lib/visibility-timers.ts, a pure helper with its clock,
//     visibility and show-subscription injected).
//   - The wiring: the screens use the helper (no setInterval left), the no-access card links
//     to the sign-in page, the route returns the platform and the refusal reason.
//   - A dead cookie never loops (Review Focus RF4): the no-access card's Sign in is a plain link to
//     /signin with no user_id or redirect parameter, nothing in PageGate sends the browser to /signin by
//     itself, and the card is reached only from a 401, 403 or 404 answer. (The cookie's clearing and
//     "the next visit gets the card, not another round" are pinned by smoke-web-session #6, #7 and #8,
//     Task 2; "a 401 asks nothing more" by smoke-calendar-home-render #28.)
//   - The new strings exist in he, en and ru.
//
// Nothing is faked beyond the helper's injected deps: no DB, Redis or network.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/6b/run-smoke.sh smoke-web-fixes

import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

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

const show = (value: unknown) => JSON.stringify(value);
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const messagesOf = (locale: string): Row => JSON.parse(source(`messages/${locale}.json`));

/** A user row as the command target reads it. */
const account = (o: { telegramId?: number | null; whatsappPhone?: string | null; whatsappBsuid?: string | null }): Row => ({
  telegramId: null,
  whatsappPhone: null,
  whatsappBsuid: null,
  ...o,
});
const BOTH = account({ telegramId: 111111111, whatsappPhone: '972500000001' });
const TG_ONLY = account({ telegramId: 222222222 });
const WA_PHONE = account({ whatsappPhone: '972500000002' });
const WA_BSUID = account({ whatsappBsuid: 'IL.123' });
const NONE = account({});

const HOME = 'app/[locale]/(app)/dashboard';

async function main() {
  await check('#1 the chat follows the session: a wa session answers on WhatsApp; tg, google and email sessions on Telegram; a WhatsApp-only account signed in another way is told to use WhatsApp\'s link', async () => {
    const { resolveCommandTargetOrReason: resolve } = await load('src/lib/command-target.ts');
    const tg = (chatId: number) => ({ ok: true, target: { platform: 'telegram', chatId } });
    const wa = (chatId: string) => ({ ok: true, target: { platform: 'whatsapp', chatId } });
    const no = (reason: string) => ({ ok: false, reason });
    // [name, user, via, method, want]
    const table: [string, Row, string, string | null | undefined, Row][] = [
      ['wa link, both chats', BOTH, 'session', 'wa', wa('972500000001')],
      ['wa link, WhatsApp phone only', WA_PHONE, 'session', 'wa', wa('972500000002')],
      ['wa link, BSUID only', WA_BSUID, 'session', 'wa', wa('IL.123')],
      ['a cookie from before web sign-in (no method) counts as wa', WA_BSUID, 'session', undefined, wa('IL.123')],
      ['wa link, Telegram-only account', TG_ONLY, 'session', 'wa', tg(222222222)],
      ['tg session, both chats', BOTH, 'session', 'tg', tg(111111111)],
      ['google session, both chats', BOTH, 'session', 'google', tg(111111111)],
      ['email session, both chats', BOTH, 'session', 'email', tg(111111111)],
      ['google session, Telegram-only', TG_ONLY, 'session', 'google', tg(222222222)],
      ['google session, WhatsApp phone only', WA_PHONE, 'session', 'google', no('wa_link_needed')],
      ['email session, BSUID only', WA_BSUID, 'session', 'email', no('wa_link_needed')],
      ['tg session, WhatsApp-only', WA_PHONE, 'session', 'tg', no('wa_link_needed')],
      ['email session, no chat at all', NONE, 'session', 'email', no('no_channel')],
      ['wa session, no chat at all', NONE, 'session', 'wa', no('no_channel')],
      ['telegram initData, both chats', BOTH, 'telegram', null, tg(111111111)],
      ['telegram initData ignores a method', BOTH, 'telegram', 'wa', tg(111111111)],
      ['operator, Telegram account', TG_ONLY, 'server', null, tg(222222222)],
      ['operator, WhatsApp-only: as before, no chat', WA_PHONE, 'server', null, no('no_channel')],
    ];
    const wrong: string[] = [];
    for (const [name, user, via, method, want] of table) {
      const got = resolve(user, via, method);
      if (show(got) !== show(want)) wrong.push(`${name}: ${show(got)}, want ${show(want)}`);
    }
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#2 the sheet names the chat the route used, and the WhatsApp hint is a problem line', async () => {
    const { sendResultKey } = await load(`${HOME}/SendSheet.tsx`);
    const table: [Row, Row | null][] = [
      [{ outcome: 'closing' }, null],
      [{ outcome: 'sent', chat: 'whatsapp' }, { key: 'send.sentWhatsApp', problem: false }],
      [{ outcome: 'sent', chat: 'telegram' }, { key: 'send.sentTelegram', problem: false }],
      [{ outcome: 'sent', chat: 'unknown' }, { key: 'send.sent', problem: false }],
      [{ outcome: 'failed', status: 400, reason: 'wa_link_needed' }, { key: 'send.waLinkNeeded', problem: true }],
      [{ outcome: 'failed', status: 400 }, { key: 'send.failed', problem: true }],
      [{ outcome: 'failed', status: 401 }, { key: 'send.signedOut', problem: true }],
      [{ outcome: 'failed', status: null }, { key: 'send.offline', problem: true }],
      [{ outcome: 'busy' }, { key: 'send.busy', problem: true }],
    ];
    const wrong = table.filter(([result, want]) => show(sendResultKey(result)) !== show(want)).map(([result]) => show(result));
    assert(wrong.length === 0, `wrong lines for ${wrong.join(', ')}`);
  });

  await check('#3 Open FamCal in Telegram: only a WhatsApp-only account (hasTelegram false) in a browser', async () => {
    const { homeBanners } = await load(`${HOME}/HomeBanners.tsx`);
    const base = { googleState: 'none', googleConnected: false, reconnect: null };
    const ids = (facts: Row) => homeBanners({ ...base, ...facts });
    assert(show(ids({ inTelegram: false, hasTelegram: false })) === show(['openInTelegram']), `WhatsApp-only in a browser: ${show(ids({ inTelegram: false, hasTelegram: false }))}`);
    assert(show(ids({ inTelegram: false, hasTelegram: true })) === show([]), 'an account with Telegram in a browser: none');
    assert(show(ids({ inTelegram: false })) === show([]), 'unknown in a browser: none');
    assert(show(ids({ inTelegram: true, hasTelegram: false })) === show([]), 'inside Telegram: none');
    assert(show(ids({ inTelegram: true, hasTelegram: true })) === show([]), 'inside Telegram with Telegram: none');
    // The other banners keep their order around it
    assert(show(ids({ inTelegram: false, hasTelegram: false, trialDaysLeft: 3, hasLocation: false })) === show(['trial', 'location', 'openInTelegram']), 'order');
  });

  await check('#4 the admin entry shows only inside Telegram', async () => {
    const { menuEntries } = await load(`${HOME}/MenuSheet.tsx`);
    const ids = (o: Row) => menuEntries({ googleState: 'connected', locale: 'en', userId: 7, ...o }).map((e: Row) => e.id);
    assert(ids({ isAdmin: true, inTelegram: true }).includes('admin'), 'an admin inside Telegram has it');
    assert(!ids({ isAdmin: true, inTelegram: false }).includes('admin'), 'an admin in a browser does not');
    assert(!ids({ isAdmin: false, inTelegram: true }).includes('admin'), 'a non-admin never does');
    assert(show(ids({ isAdmin: true, inTelegram: false })) === show(ids({ isAdmin: false, inTelegram: true })), 'nothing else changes');
  });

  /** A count read through a call, so TypeScript does not narrow it after an assertion. */
  function counter() {
    let n = 0;
    return { bump: () => { n++; }, get: () => n };
  }

  /** A scripted clock, visibility and show-subscription for the helper. */
  function world() {
    let now = 0;
    let seq = 0;
    let hidden = false;
    const timers: { id: number; at: number; run: () => void }[] = [];
    const waiting: (() => void)[] = [];
    const deps = {
      isHidden: () => hidden,
      onceVisible: (cb: () => void) => {
        const fire = () => {
          const i = waiting.indexOf(fire);
          if (i >= 0) waiting.splice(i, 1);
          cb();
        };
        waiting.push(fire);
        return () => {
          const i = waiting.indexOf(fire);
          if (i >= 0) waiting.splice(i, 1);
        };
      },
      setTimer: (run: () => void, ms: number) => {
        const id = ++seq;
        timers.push({ id, at: now + ms, run });
        return () => {
          const i = timers.findIndex((t) => t.id === id);
          if (i >= 0) timers.splice(i, 1);
        };
      },
    };
    return {
      deps,
      /** How many timers and show-listeners are pending (a call, so a check never narrows it). */
      n: () => ({ timers: timers.length, waiting: waiting.length }),
      advance: (ms: number) => {
        const end = now + ms;
        for (;;) {
          timers.sort((a, b) => a.at - b.at || a.id - b.id);
          const next = timers[0];
          if (!next || next.at > end) break;
          timers.shift();
          now = next.at;
          next.run();
        }
        now = end;
      },
      hide: () => {
        hidden = true;
      },
      show: () => {
        hidden = false;
        waiting.slice().forEach((fire) => fire());
      },
    };
  }

  await check('#5 the poll runs while the tab shows, stops (no timer left, one show-listener) while it is hidden, and takes up again one interval after the tab shows', async () => {
    const { startVisiblePoll } = await load('src/lib/visibility-timers.ts');
    const w = world();
    const hits = counter();
    const stop = startVisiblePoll(() => hits.bump(), 10_000, w.deps);
    w.advance(35_000);
    assert(hits.get() === 3, `three polls while visible: ${hits.get()}`);
    w.hide();
    w.advance(10_000);
    assert(hits.get() === 3 && w.n().timers === 0 && w.n().waiting === 1, `hidden: ${show({ polls: hits.get(), ...w.n() })}`);
    w.advance(3_600_000);
    assert(hits.get() === 3 && w.n().timers === 0, `an hour hidden: ${show({ polls: hits.get(), ...w.n() })}`);
    w.show();
    assert(hits.get() === 3 && w.n().timers === 1 && w.n().waiting === 0, `shown: the page's own handler refreshes; the poll waits a full interval: ${show({ polls: hits.get(), ...w.n() })}`);
    w.advance(10_000);
    assert(hits.get() === 4, `then it polls again: ${hits.get()}`);
    stop();
    assert(w.n().timers === 0 && w.n().waiting === 0, 'stop clears the timer');
    w.advance(100_000);
    assert(hits.get() === 4, 'and nothing polls after it');
    // A stop while hidden takes the show-listener back too
    const w2 = world();
    const hits2 = counter();
    const stop2 = startVisiblePoll(() => hits2.bump(), 10_000, w2.deps);
    w2.hide();
    w2.advance(10_000);
    assert(w2.n().waiting === 1, 'waiting for the tab');
    stop2();
    assert(w2.n().waiting === 0, 'stop while hidden removes the listener');
    w2.show();
    w2.advance(100_000);
    assert(hits2.get() === 0 && w2.n().timers === 0, 'and a later show starts nothing');
  });

  await check('#6 afterShown goes now when the tab shows and on the next show when hidden; cancel takes it back; the browser deps never report hidden without a document', async () => {
    const { afterShown, DOM_VISIBILITY } = await load('src/lib/visibility-timers.ts');
    const w = world();
    const hits = counter();
    afterShown(() => hits.bump(), w.deps);
    assert(hits.get() === 1, 'visible: now');
    w.hide();
    const cancel = afterShown(() => hits.bump(), w.deps);
    assert(hits.get() === 1 && w.n().waiting === 1, 'hidden: waits');
    cancel();
    w.show();
    assert(hits.get() === 1, 'cancelled: never');
    afterShown(() => hits.bump(), w.deps);
    w.hide();
    afterShown(() => hits.bump(), w.deps);
    w.show();
    assert(hits.get() === 3, `the one that waited goes on show: ${hits.get()}`);
    assert((globalThis as Row).document === undefined, 'this smoke has no document');
    assert(DOM_VISIBILITY.isHidden() === false, 'no document: the tab is never hidden');
    const late = counter();
    DOM_VISIBILITY.onceVisible(() => late.bump())();
    assert(late.get() === 1, 'no document: onceVisible calls back at once');
  });

  await check('#7 the wiring: the Calendars poll and the home\'s day check use the helper; the no-access card, the route and the dashboard carry the new facts', async () => {
    const calendars = source('app/[locale]/(app)/calendars/CalendarsClient.tsx');
    assert(/startVisiblePoll\(/.test(calendars) && !/setInterval\(/.test(calendars), 'CalendarsClient: startVisiblePoll, no setInterval');
    const home = source(`${HOME}/CalendarHome.tsx`);
    assert(/DOM_VISIBILITY\.isHidden\(\)/.test(home) && /afterShown\(arm\)/.test(home), 'CalendarHome: the day check waits while hidden');
    assert(/hasTelegram=\{hasTelegram\}/.test(home), 'CalendarHome passes hasTelegram to the banners');
    assert(/isAdmin=\{user\.isAdmin\}\s*\n\s*inTelegram=\{inTelegram\}/.test(home), 'CalendarHome passes inTelegram to the menu');
    const gate = source('app/[locale]/(app)/PageGate.tsx');
    assert(/signInHref\(locale\)/.test(gate) && /hasTelegram: p\.hasTelegram/.test(gate), 'PageGate: the card links to sign-in, the home gets hasTelegram');
    const pageData = source('src/lib/page-data.ts');
    assert(/hasTelegram: user\.telegramId !== null/.test(pageData), 'page-data sends hasTelegram');
    const route = source('app/api/execute-command/route.ts');
    assert(/resolveCommandTargetOrReason\(user, via, method\)/.test(route) && /error: resolved\.reason/.test(route) && /^\s*platform,$/m.test(route), 'the route resolves by method, answers the reason and names the platform');
    assert(/auth\.via === 'session' \? auth\.session\.method : null/.test(route), 'the method is the session\'s');
  });

  await check('#8 the card\'s sign-in link is signInHref (the one /signin builder, src/site/signin.ts): the page\'s language, en has no prefix, an unknown language is en; this task adds no builder of its own', async () => {
    const { signInHref } = await load('src/site/signin.ts');
    const got = ['en', 'he', 'ru', 'xx'].map((l) => signInHref(l));
    assert(show(got) === show(['/signin', '/he/signin', '/ru/signin', '/signin']), show(got));
    assert(!fs.existsSync(path.join(ROOT, 'src/lib/signin-link.ts')), 'src/lib/signin-link.ts must not exist: signInHref is the only /signin path builder');
    // Client-safe (the client card imports it): its value imports are the path helper and the locale normaliser only; anything else is a type
    const imports = source('src/site/signin.ts').match(/^import .*$/gm) ?? [];
    const clientSafe = (line: string) => /^import type /.test(line) || /from '@\/src\/site\/zmanim\/links';$/.test(line) || /from '@\/src\/utils\/locale';$/.test(line);
    assert(imports.length > 0 && imports.every(clientSafe), `src/site/signin.ts imports more than localeHref, normalizeLocale and types: ${show(imports.filter((l) => !clientSafe(l)))}`);
  });

  await check('#9 the new strings are in he, en and ru, and read as written for the language', async () => {
    const wrong: string[] = [];
    for (const locale of ['en', 'he', 'ru']) {
      const m = messagesOf(locale);
      const sentTelegram = m.calendarHome?.send?.sentTelegram;
      const waLinkNeeded = m.calendarHome?.send?.waLinkNeeded;
      const signIn = m.pageGate?.signIn;
      for (const [key, value] of [['send.sentTelegram', sentTelegram], ['send.waLinkNeeded', waLinkNeeded], ['pageGate.signIn', signIn]] as const) {
        if (typeof value !== 'string' || !value.trim()) wrong.push(`${locale} has no ${key}`);
      }
      if (typeof waLinkNeeded === 'string' && (!/WhatsApp|וואטסאפ/.test(waLinkNeeded) || !/settings/.test(waLinkNeeded))) wrong.push(`${locale} waLinkNeeded: ${waLinkNeeded}`);
      for (const value of [sentTelegram, waLinkNeeded, signIn]) {
        // No slash or bracket gender forms in Hebrew or Russian
        if (locale !== 'en' && typeof value === 'string' && /[(\[][^)\]]*[)\]]|\S\/\S/.test(value)) wrong.push(`${locale} gender form: ${value}`);
      }
    }
    // Each is different per language (not copied across)
    const en = messagesOf('en');
    const he = messagesOf('he');
    const ru = messagesOf('ru');
    if (he.pageGate.signIn === en.pageGate.signIn || ru.pageGate.signIn === en.pageGate.signIn) wrong.push('pageGate.signIn is not translated');
    if (!/טלגרם/.test(he.calendarHome.send.sentTelegram) || !/Telegram/.test(ru.calendarHome.send.sentTelegram)) wrong.push('sentTelegram names Telegram in its own language');
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#10 a revoked, expired or signed-out cookie never loops between the card, /signin and /dashboard: the card\'s Sign in is a plain /signin link with no user_id or redirect parameter, and PageGate never sends the browser to /signin by itself', async () => {
    const { signInHref } = await load('src/site/signin.ts');
    for (const locale of ['en', 'he', 'ru']) {
      const href = signInHref(locale);
      assert(!/[?#]|user_id|next=|redirect/.test(href), `${locale}: the card\'s link carries state: ${href}`);
    }
    const gate = source('app/[locale]/(app)/PageGate.tsx');
    // Exactly one use: the card's action. A second one would be a redirect the gate makes on its own.
    assert((gate.match(/signInHref\(/g) ?? []).length === 1 && /\{ label: t\('signIn'\), primary: true, href: signInHref\(locale\) \}/.test(gate), 'PageGate uses signInHref once, as the card\'s Sign in action');
    assert(!/router\.(push|replace)\([^)]*signin/i.test(gate) && !/location\.(href|assign|replace)[^;\n]*signin/i.test(gate), 'PageGate never navigates to /signin by itself');
    // The card is the answer to a refusal and nothing else: it is shown for 401, 403 and 404, and the answer is not retried.
    assert(/res\.status === 401 \|\| res\.status === 403 \|\| res\.status === 404/.test(gate) && /kind: 'gate'/.test(gate), 'PageGate shows the card for 401, 403 and 404 only');
    // The in-Telegram card keeps closing the Mini App: no Sign in, so a Telegram session never reaches /signin from here.
    assert(/if \(inTelegram\) \{/.test(gate) && gate.indexOf('if (inTelegram) {') < gate.indexOf('signInHref(locale)'), 'NoCredentialCard branches on inTelegram before the browser card');
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
