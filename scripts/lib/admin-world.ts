// A small admin back end for the admin panel's smokes (smoke-admin-data.ts, smoke-admin-render.ts): a fake fetch that records
// every request (URL, method, headers, JSON body) and answers it from `world.respond`, and the fixtures of the routes' answers.
// By default it answers like the real routes do, for a few people. A smoke replaces `world.respond` to script a scenario (a
// failing route, an answer that comes later). scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).
//
// Ids: VIEWER_TELEGRAM_ID is the page's ?user_id, a Telegram id. TARGET and OTHER are database ids (User.id). A person's
// Telegram id is 7000000 + their id, so no id can pass for another.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const VIEWER_TELEGRAM_ID = 5550001;
export const INIT_DATA = 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc';
export const TARGET = 7;
export const OTHER = 8;
export const NAMES: Record<number, string> = { [TARGET]: 'Noa', [OTHER]: 'Dan' };
export const PHONE: Record<number, string> = { [TARGET]: '+972501230007', [OTHER]: '+972501230008' };

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Row;
}
export const calls: Call[] = [];

export const ok = (body: Row = {}, status = 200) => new Response(JSON.stringify({ success: true, ...body }), { status, headers: { 'Content-Type': 'application/json' } });
export const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A row of GET user-overrides?list=all. */
export const listItem = (id: number, over: Row = {}): Row => ({
  id,
  telegramId: 7000000 + id,
  name: NAMES[id] ?? `Person ${id}`,
  suspendedAt: null,
  subscription: { plan: 'FREE', status: 'TRIALING', trialEndsAt: null, trialDaysRemaining: 9, currentPeriodEnd: null },
  usage: null,
  calendarsCount: 1,
  hasOverride: false,
  ...over,
});

/** The answer of GET user-overrides?user_id=. */
export const detail = (id: number, over: Row = {}): Row => ({
  ...listItem(id),
  whatsappPhone: PHONE[id] ?? null,
  messagingPlatform: 'telegram',
  createdAt: '2026-10-01T10:00:00.000Z',
  suspendedBy: null,
  suspendedReason: null,
  usage: { textSummariesUsed: 1, voiceSummariesUsed: 0, voiceEventsCreated: 0 },
  limits: { textSummaries: 10, voiceSummaries: 3, calendars: 2 },
  override: null,
  paidFeatures: { unlimitedSummaries: false, remindersEnabled: false, voiceEventsEnabled: false, unlimitedCalendars: false },
  registrationStatus: { hasOAuth: false, hasCalendars: false, hasLocation: true, applicableReminder: null, googleState: 'none' },
  setupReminders: { daysSinceCreated: 3, daysSinceStart: 3, wasReset: false, calendars: [], reconnect: [], location: [] },
  ...over,
});

/** A page of `total` rows named `<prefix>-<n>`, as the activity and feedback routes slice them. */
export function page(prefix: string, total: number, url: URL, key: 'activities' | 'feedbacks'): Row {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => {
    const n = offset + i;
    return key === 'activities'
      ? { id: `${prefix}-${n}`, userId: TARGET, userName: 'x', userTelegramId: null, action: url.searchParams.get('action') ?? 'login', metadata: null, createdAt: '2026-10-27T08:00:00.000Z' }
      : { id: `${prefix}-${n}`, userId: TARGET, userName: 'x', userTelegramId: null, text: `text ${n}`, source: 'telegram', createdAt: '2026-10-27T08:00:00.000Z' };
  });
  return { [key]: rows, pagination: { total, limit, offset, hasMore: offset + limit < total }, ...(key === 'activities' ? { actionStats: [{ action: 'login', count: total }] } : {}) };
}

/**
 * What POST /api/admin/user-overrides does to a person (app/api/admin/user-overrides/route.ts): with none of the five values
 * true there is no override at all (the route deletes the row, reason included, and answers `override: null`); otherwise the
 * row holds the values (`?? null`; the early flag is `=== true`), the reason (`?? null`) and the grant. Returns the person's
 * new `override`.
 */
export function overrideAfterPost(body: Row, grantedAt: string): Row | null {
  const anyOn = [body.unlimitedSummaries, body.remindersEnabled, body.voiceEventsEnabled, body.unlimitedCalendars, body.earlyAdopter].some((v) => v === true);
  if (!anyOn) return null;
  return {
    unlimitedSummaries: body.unlimitedSummaries ?? null,
    remindersEnabled: body.remindersEnabled ?? null,
    voiceEventsEnabled: body.voiceEventsEnabled ?? null,
    unlimitedCalendars: body.unlimitedCalendars ?? null,
    earlyAdopter: body.earlyAdopter === true,
    reason: body.reason ?? null,
    grantedAt,
    grantedBy: 9,
  };
}

/** The routes' answers for a few people; every POST and DELETE works. */
export const defaultRespond = (call: Call): Response => {
  const url = new URL(call.url, 'http://localhost');
  const route = url.pathname.replace('/api/admin/', '');
  if (call.method === 'GET') {
    if (route === 'settings') return ok({ remindersEnabled: true, earlyAdoptionMode: false });
    if (route === 'stats') return ok({ stats: { totalUsers: 3, usersWithOAuth: 1, usersWithCalendars: 1, needSetup: 1 } });
    if (route === 'user-overrides' && url.searchParams.get('list') === 'all') return ok({ users: [listItem(TARGET), listItem(OTHER)] });
    if (route === 'user-overrides') return ok({ user: detail(Number(url.searchParams.get('user_id'))) });
    if (route === 'user-activity') return ok(page(`a${url.searchParams.get('user_id') ?? 'all'}`, 45, url, 'activities'));
    if (route === 'feedback') return ok(page('f', 120, url, 'feedbacks'));
    if (route === 'users/blocklist') return ok({ blocklist: [{ id: 1, telegramId: 99, whatsappPhone: null, bannedBy: 9, bannedReason: null, createdAt: '2026-10-20T08:00:00.000Z' }] });
  }
  return ok({});
};

/** What answers the requests now. */
export const world: { respond: (call: Call) => Response | Promise<Response> } = { respond: defaultRespond };

/** Every fetch is recorded in `calls` and answered by `world.respond`. */
export function installFakeFetch(): void {
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return world.respond(call);
  }) as typeof fetch;
}

/** A promise settled from outside, to answer a request later than the one after it. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
