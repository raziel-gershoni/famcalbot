// The calendar home's data flow (spec §5): which range requests go out, and what each
// answer does to the store. CalendarHome (D6) creates one loader on mount and feeds it
// the latest store; the loader only fetches and dispatches. Client components only;
// no React in here, so the rules read in one place:
//
// - First load: one request per applicable source, in parallel, with no dates (the
//   server's [today, today+7)). Whichever answers first pins the facts and paints.
// - ensure(): every visible window (week 0 … weeks-1 of the Agenda, and the Month
//   windows the host wants now) whose days a source hasn't covered in this epoch gets
//   one request. That covers "Show next week" (one more week), a month coming near the
//   viewport, and a store drop (midnight, other facts: the epoch moves on and the days
//   are gone). A window is asked at most once per epoch this way.
// - refetchVisible(): every visible window again: a return to the foreground, a Retry,
//   or ⋯ → Refresh (fresh=1). The Agenda's weeks only while the Agenda is on screen,
//   and the wanted months. A request already in flight is not sent twice, except with
//   `renew`: the confirming read after a reminder action always goes out anew, since an
//   older request may have been asked before the action took. It resolves once every
//   request it sent has been answered and applied, or dropped (a queued month no longer
//   wanted): an edit waits on it to see whether its item is still there.
// - patchReminder(): a reminder's new state after an action. An answer whose request
//   started before the latest patch of a key leaves that key's reminder as patched (the
//   store's `hold`); a request started after it is taken as it is.
// - retryWindow(): one window again (the Month's Retry).
// - An answer with google.stale asks that window once more after about 3 s; if that is
//   stale too, the window waits for the next foreground or Refresh. A Google error
//   (not calendars_gone) gets one automatic retry after about 5 s.
// - Month windows (spec §5, Plan E Ruling 7) are a month's own days, [1st, 1st of the
//   next month) (R12). At most MONTH_INFLIGHT_MAX of them are in flight; every send for
//   one waits its turn (the first ask, a refetch, Retry, the stale and error follow-ups),
//   and the Agenda's weeks never do. When a slot frees, the queued months the host no
//   longer wants are dropped without being marked asked, so ensure() asks them again if
//   they come back; then the most wanted goes. A month's stale or error follow-up that
//   falls due once the month is no longer wanted is dropped too, slot or no slot.
// - Windows are keyed by both ends, `from..to`: on the 1st of a month the Agenda's week 0
//   and that month share a start, never a key.
// - Every request has a time limit (about 15 s, on the host's timer): one that never
//   settles reads as no answer, so it leaves the in-flight set (and frees its month slot)
//   and the next foreground or Retry asks again instead of being deduped behind it forever.
// - 401, 403, 404 → the host's no-credential card; 429 → busy, a 500 or no answer → error: a state row for the
//   window once the facts are pinned, else the host's busy or retry card. A failure
//   from before the last store drop changes nothing: the loader asks again anyway.

import { agendaWeekWindow } from './agenda';
import { daysInWindow, type CalendarStore, type StoreAction } from './store';
import { fetchRange, type RangeOutcome, type RangeWindow } from './home-client';
import type { ItemReminderDTO, SourceName } from './types';

/** A stale answer's one re-request (spec §5 Freshness). */
export const STALE_RETRY_MS = 3000;
/** A Google error's one automatic retry (spec §5 States). */
export const ERROR_RETRY_MS = 5000;
/** A range request's time limit: past it, the request is aborted and reads as no answer. */
export const RANGE_TIMEOUT_MS = 15_000;
/** Month windows in flight at once (spec §5); the Agenda's weeks don't count. */
export const MONTH_INFLIGHT_MAX = 2;

export interface LoaderHost {
  /** The page's own user_id, exactly as CalendarHomeProps carries it. */
  userId: number;
  /** The sources that apply before any answer (the user's calendar source). */
  sources: readonly SourceName[];
  /** The latest store and week count. */
  getStore(): CalendarStore;
  getWeeks(): number;
  dispatch(action: StoreAction): void;
  /** The home shows a no-credential card: nothing more is fetched. */
  isBlocked(): boolean;
  /** No answer yet and the first load failed: the host's busy or retry card is up. */
  firstLoadFailed(): boolean;
  /** An answer arrived (the first-load card goes). */
  onAnswer(): void;
  onFirstLoadFailed(kind: 'busy' | 'error'): void;
  onNoCredential(): void;
  setTimer(run: () => void, ms: number): () => void;
  /** Month windows wanted now (on screen or next to it), most wanted first; absent or [] = none. */
  getMonths?(): readonly RangeWindow[];
  /** Whether the Agenda is on screen: refetchVisible asks its weeks only then. Absent = true. */
  agendaShowing?(): boolean;
}

export interface HomeLoader {
  ensure(): void;
  /** Resolves when every request it sent has been answered and applied (or dropped); never rejects. */
  refetchVisible(o?: { fresh?: boolean; only?: SourceName; renew?: boolean }): Promise<void>;
  /** Patch the store with a reminder's state after an action, and remember it for the answers still on their way. */
  patchReminder(key: string, reminder: ItemReminderDTO): void;
  /** One window again, for each applicable source or only `only` (the Month's Retry). */
  retryWindow(window: RangeWindow, only?: SourceName): void;
  dispose(): void;
}

type Ask = { source: SourceName; window: RangeWindow | null; fresh?: boolean; followUp?: 'stale' | 'retry'; renew?: boolean };
/** A month send waiting for a slot: its in-flight key, the epoch it was asked in, and what to tell when it is done or dropped. */
type Queued = { key: string; ask: Ask; epoch: number; settle: () => void; settled: Promise<void> };

const SETTLED: Promise<void> = Promise.resolve();

/** Whether some day of the window has no answer (ok or failed) from `source` yet. */
function uncovered(store: CalendarStore, source: SourceName, window: RangeWindow): boolean {
  return daysInWindow(window.from, window.to).some((day) => {
    const c = store.days[day]?.coverage[source];
    return !c || (!c.ok && !c.failed);
  });
}

/** A window's key, both ends: `from..to`; 'default' for the no-dates request. */
function windowKey(window: RangeWindow | null): string {
  return window ? `${window.from}..${window.to}` : 'default';
}

/** A month's own days, [1st, 1st of the next month) (R12). An Agenda week (7 days) never is one. */
function isMonthWindow(window: RangeWindow | null): boolean {
  if (!window || !/^\d{4}-\d{2}-01$/.test(window.from)) return false;
  const [y, m] = window.from.split('-').map(Number);
  return window.to === new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export function createHomeLoader(host: LoaderHost): HomeLoader {
  /** `${epoch}|${source}|${windowKey}`: asked in that epoch. */
  const issued = new Set<string>();
  /** The same plus `|fresh` or `|plain`: on its way now. */
  const inflight = new Map<string, number>();
  /** Each in-flight key's latest request, settled once its answer is applied. */
  const running = new Map<string, Promise<void>>();
  /** Counts the patches; a request is stamped with the count when it starts. */
  let patchSeq = 0;
  /** Each patched reminder key's latest state, and the count of its patch. */
  const patched = new Map<string, { seq: number; reminder: ItemReminderDTO }>();
  /** Month sends waiting for a slot, in the order they were asked. */
  const queue: Queued[] = [];
  let monthsInFlight = 0;
  const timers = new Set<() => void>();
  let live = true;

  const later = (run: () => void, ms: number) => {
    const cancel = host.setTimer(() => {
      timers.delete(cancel);
      if (live) run();
    }, ms);
    timers.add(cancel);
  };

  const visibleWindows = (today: string): RangeWindow[] =>
    Array.from({ length: Math.max(1, Math.floor(host.getWeeks())) }, (_, week) => agendaWeekWindow(today, week));
  const wantedMonths = (): readonly RangeWindow[] => host.getMonths?.() ?? [];

  function handle(outcome: RangeOutcome, ask: Ask, epoch: number, where: string, startedAt: number) {
    const { source, window } = ask;
    switch (outcome.kind) {
      case 'ok': {
        const response = outcome.response;
        host.onAnswer();
        const hold = new Map<string, ItemReminderDTO>();
        for (const [key, p] of patched) if (p.seq > startedAt) hold.set(key, p.reminder);
        host.dispatch(hold.size > 0 ? { type: 'response', response, epoch, hold } : { type: 'response', response, epoch });
        const google = response.sources.google;
        const answered: RangeWindow = { from: response.from, to: response.to };
        // A follow-up is for this epoch's window only: after a drop the loader starts over
        // anyway. A month's goes only while the host still wants the month: after a fast
        // scroll the months passed are not asked again (each is a request off the rate limit).
        const again = (followUp: 'stale' | 'retry') => {
          if (host.getStore().epoch !== epoch) return;
          if (isMonthWindow(answered) && !wantedMonths().some((w) => windowKey(w) === windowKey(answered))) return;
          send({ source, window: answered, followUp });
        };
        if (source === 'google' && google?.status === 'ok' && google.stale && ask.followUp === undefined) {
          later(() => again('stale'), STALE_RETRY_MS);
        }
        if (source === 'google' && google?.status === 'error' && google.reason !== 'calendars_gone' && ask.followUp !== 'retry') {
          later(() => again('retry'), ERROR_RETRY_MS);
        }
        return;
      }
      case 'noCredential':
        host.onNoCredential();
        return;
      case 'busy':
      case 'error': {
        if (epoch !== host.getStore().epoch) return;
        // Sent before the last store drop: the loader asks the new epoch's windows anyway,
        // and a card or a state row now would only flash until they answer.
        const facts = host.getStore().facts;
        const failed = window ?? (facts ? agendaWeekWindow(facts.today, 0) : null);
        if (facts && failed) {
          host.dispatch({ type: 'windowFailed', from: failed.from, to: failed.to, sources: [source], kind: outcome.kind, epoch });
          return;
        }
        // No facts to hang a state row on: the host's card, and ensure() may ask again after Retry.
        issued.delete(`${epoch}|${source}|${where}`);
        host.onFirstLoadFailed(outcome.kind);
      }
    }
  }

  /**
   * The one place a request leaves; nothing leaves once the home is blocked. A month waits
   * for a slot. Settles when the request it sent, or the one already on its way or queued
   * for the same key, has been applied, or dropped; at once when nothing goes.
   */
  function send(ask: Ask): Promise<void> {
    if (!live || host.isBlocked()) return SETTLED;
    const epoch = host.getStore().epoch;
    const key = `${epoch}|${ask.source}|${windowKey(ask.window)}|${ask.fresh ? 'fresh' : 'plain'}`;
    if (inflight.has(key) && !ask.renew) return running.get(key) ?? SETTLED;
    if (isMonthWindow(ask.window)) {
      const waiting = queue.find((q) => q.key === key);
      if (waiting) return waiting.settled;
      if (monthsInFlight >= MONTH_INFLIGHT_MAX) {
        let settle = () => {};
        const settled = new Promise<void>((resolve) => (settle = resolve));
        queue.push({ key, ask, epoch, settle, settled });
        return settled;
      }
    }
    return start(ask, epoch, key);
  }

  function start(ask: Ask, epoch: number, key: string): Promise<void> {
    const where = windowKey(ask.window);
    const month = isMonthWindow(ask.window);
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
    const startedAt = patchSeq;
    issued.add(`${epoch}|${ask.source}|${where}`);
    if (month) monthsInFlight++;
    const done = fetchRange(host.userId, ask.source, ask.window, ask.fresh === true, { ms: RANGE_TIMEOUT_MS, setTimer: host.setTimer })
      .catch((): RangeOutcome => ({ kind: 'error', status: null }))
      .then((outcome) => {
        const left = (inflight.get(key) ?? 1) - 1;
        if (left > 0) inflight.set(key, left);
        else inflight.delete(key);
        if (running.get(key) === done) running.delete(key);
        if (month) monthsInFlight--;
        try {
          if (live) handle(outcome, ask, epoch, where, startedAt);
        } finally {
          if (month) nextMonth();
        }
      })
      .catch((err: unknown) => console.error('[calendar-home] A range answer could not be applied:', err));
    running.set(key, done);
    return done;
  }

  /** Take a month off the queue without sending it: whoever waited on it is told. */
  function drop(i: number) {
    const [q] = queue.splice(i, 1);
    q.settle();
  }

  /**
   * A month slot is free: drop the queued months the host no longer wants (or that were
   * asked before the last store drop), none of them marked asked; then send the most wanted.
   */
  function nextMonth() {
    while (live && monthsInFlight < MONTH_INFLIGHT_MAX && queue.length > 0) {
      if (host.isBlocked()) {
        while (queue.length > 0) drop(0);
        return;
      }
      const epoch = host.getStore().epoch;
      const wanted = wantedMonths().map(windowKey);
      const rank = (q: Queued) => wanted.indexOf(windowKey(q.ask.window));
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].epoch !== epoch || rank(queue[i]) < 0 || (inflight.has(queue[i].key) && !queue[i].ask.renew)) drop(i);
      }
      if (queue.length === 0) return;
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (rank(queue[i]) < rank(queue[best])) best = i;
      const [q] = queue.splice(best, 1);
      void start(q.ask, epoch, q.key).then(q.settle);
    }
  }

  return {
    ensure() {
      if (!live) return;
      const store = host.getStore();
      const facts = store.facts;
      if (!facts) {
        if (host.firstLoadFailed()) return;
        for (const source of host.sources) {
          if (!issued.has(`${store.epoch}|${source}|default`)) send({ source, window: null });
        }
        return;
      }
      visibleWindows(facts.today).forEach((window, week) => {
        for (const source of facts.sources) {
          const asked = issued.has(`${store.epoch}|${source}|${windowKey(window)}`) || (week === 0 && issued.has(`${store.epoch}|${source}|default`));
          if (!asked && uncovered(store, source, window)) send({ source, window });
        }
      });
      for (const window of wantedMonths()) {
        for (const source of facts.sources) {
          if (!issued.has(`${store.epoch}|${source}|${windowKey(window)}`) && uncovered(store, source, window)) send({ source, window });
        }
      }
    },

    refetchVisible({ fresh = false, only, renew = false }: { fresh?: boolean; only?: SourceName; renew?: boolean } = {}) {
      if (!live) return SETTLED;
      const facts = host.getStore().facts;
      const sources = (facts ? facts.sources : host.sources).filter((s) => only === undefined || s === only);
      const sent: Promise<void>[] = [];
      if (!facts) {
        for (const source of sources) sent.push(send({ source, window: null, fresh, renew }));
      } else {
        if (host.agendaShowing?.() !== false) {
          for (const window of visibleWindows(facts.today)) {
            for (const source of sources) sent.push(send({ source, window, fresh, renew }));
          }
        }
        for (const window of wantedMonths()) {
          for (const source of sources) sent.push(send({ source, window, fresh, renew }));
        }
      }
      return Promise.all(sent).then(() => undefined);
    },

    patchReminder(key, reminder) {
      if (!live) return;
      patched.set(key, { seq: ++patchSeq, reminder });
      host.dispatch({ type: 'patchReminder', key, reminder });
    },

    retryWindow(window: RangeWindow, only?: SourceName) {
      if (!live) return;
      const facts = host.getStore().facts;
      for (const source of (facts ? facts.sources : host.sources).filter((s) => only === undefined || s === only)) {
        send({ source, window });
      }
    },

    dispose() {
      live = false;
      while (queue.length > 0) drop(0);
      for (const cancel of timers) cancel();
      timers.clear();
    },
  };
}
