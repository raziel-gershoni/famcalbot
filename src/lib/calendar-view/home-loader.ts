// The calendar home's data flow (spec §5): which range requests go out, and what each
// answer does to the store. CalendarHome (D6) creates one loader on mount and feeds it
// the latest store; the loader only fetches and dispatches. Client components only;
// no React in here, so the rules read in one place:
//
// - First load: one request per applicable source, in parallel, with no dates (the
//   server's [today, today+7)). Whichever answers first pins the facts and paints.
// - ensure(): every visible window (week 0 … weeks-1 of the Agenda) whose days a source
//   hasn't covered in this epoch gets one request. That covers "Show next week" (one
//   more week) and a store drop (midnight, other facts: the epoch moves on and the days
//   are gone). A window is asked at most once per epoch this way.
// - refetchVisible(): every visible window again: a return to the foreground, a Retry,
//   or ⋯ → Refresh (fresh=1). A request already in flight is not sent twice.
// - An answer with google.stale asks that window once more after about 3 s; if that is
//   stale too, the window waits for the next foreground or Refresh. A Google error
//   (not calendars_gone) gets one automatic retry after about 5 s.
// - Every request has a time limit (about 15 s, on the host's timer): one that never
//   settles reads as no answer, so it leaves the in-flight set and the next foreground
//   or Retry asks again instead of being deduped behind it forever.
// - 404 not_enabled → the host reloads once; 401, 403, any other 404 → the host's
//   no-credential card; 429 → busy, a 500 or no answer → error: a state row for the
//   window once the facts are pinned, else the host's busy or retry card.

import { agendaWeekWindow } from './agenda';
import { daysInWindow, type CalendarStore, type StoreAction } from './store';
import { fetchRange, type RangeOutcome, type RangeWindow } from './home-client';
import type { SourceName } from './types';

/** A stale answer's one re-request (spec §5 Freshness). */
export const STALE_RETRY_MS = 3000;
/** A Google error's one automatic retry (spec §5 States). */
export const ERROR_RETRY_MS = 5000;
/** A range request's time limit: past it, the request is aborted and reads as no answer. */
export const RANGE_TIMEOUT_MS = 15_000;

export interface LoaderHost {
  /** The page's own user_id, exactly as CalendarHomeProps carries it. */
  userId: number;
  /** The sources that apply before any answer (the user's calendar source). */
  sources: readonly SourceName[];
  /** The latest store and week count. */
  getStore(): CalendarStore;
  getWeeks(): number;
  dispatch(action: StoreAction): void;
  /** The home shows a no-credential card or the switch-off card: nothing more is fetched. */
  isBlocked(): boolean;
  /** No answer yet and the first load failed: the host's busy or retry card is up. */
  firstLoadFailed(): boolean;
  /** An answer arrived (the first-load card goes). */
  onAnswer(): void;
  onFirstLoadFailed(kind: 'busy' | 'error'): void;
  onNoCredential(): void;
  onNotEnabled(): void;
  setTimer(run: () => void, ms: number): () => void;
}

export interface HomeLoader {
  ensure(): void;
  refetchVisible(o?: { fresh?: boolean; only?: SourceName }): void;
  dispose(): void;
}

type Ask = { source: SourceName; window: RangeWindow | null; fresh?: boolean; followUp?: 'stale' | 'retry' };

/** Whether some day of the window has no answer (ok or failed) from `source` yet. */
function uncovered(store: CalendarStore, source: SourceName, window: RangeWindow): boolean {
  return daysInWindow(window.from, window.to).some((day) => {
    const c = store.days[day]?.coverage[source];
    return !c || (!c.ok && !c.failed);
  });
}

export function createHomeLoader(host: LoaderHost): HomeLoader {
  /** `${epoch}|${source}|${from or 'default'}`: asked by ensure() in that epoch. */
  const issued = new Set<string>();
  /** The same plus `|fresh` or `|plain`: on its way now. */
  const inflight = new Set<string>();
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

  function handle(outcome: RangeOutcome, ask: Ask, epoch: number, where: string) {
    const { source, window } = ask;
    switch (outcome.kind) {
      case 'ok': {
        const response = outcome.response;
        host.onAnswer();
        host.dispatch({ type: 'response', response, epoch });
        const google = response.sources.google;
        const answered: RangeWindow = { from: response.from, to: response.to };
        // A follow-up is for this epoch's window only: after a drop the loader starts over anyway.
        const again = (followUp: 'stale' | 'retry') => {
          if (host.getStore().epoch === epoch) send({ source, window: answered, followUp });
        };
        if (source === 'google' && google?.status === 'ok' && google.stale && ask.followUp === undefined) {
          later(() => again('stale'), STALE_RETRY_MS);
        }
        if (source === 'google' && google?.status === 'error' && google.reason !== 'calendars_gone' && ask.followUp !== 'retry') {
          later(() => again('retry'), ERROR_RETRY_MS);
        }
        return;
      }
      case 'notEnabled':
        host.onNotEnabled();
        return;
      case 'noCredential':
        host.onNoCredential();
        return;
      case 'busy':
      case 'error': {
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

  /** The one place a request leaves; nothing leaves once the home is blocked. */
  function send(ask: Ask) {
    if (!live || host.isBlocked()) return;
    const epoch = host.getStore().epoch;
    const where = ask.window ? ask.window.from : 'default';
    const key = `${epoch}|${ask.source}|${where}|${ask.fresh ? 'fresh' : 'plain'}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    issued.add(`${epoch}|${ask.source}|${where}`);
    void fetchRange(host.userId, ask.source, ask.window, ask.fresh === true, { ms: RANGE_TIMEOUT_MS, setTimer: host.setTimer })
      .catch((): RangeOutcome => ({ kind: 'error', status: null }))
      .then((outcome) => {
        inflight.delete(key);
        if (live) handle(outcome, ask, epoch, where);
      })
      .catch((err: unknown) => console.error('[calendar-home] A range answer could not be applied:', err));
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
          const asked = issued.has(`${store.epoch}|${source}|${window.from}`) || (week === 0 && issued.has(`${store.epoch}|${source}|default`));
          if (!asked && uncovered(store, source, window)) send({ source, window });
        }
      });
    },

    refetchVisible({ fresh = false, only }: { fresh?: boolean; only?: SourceName } = {}) {
      if (!live) return;
      const facts = host.getStore().facts;
      const sources = (facts ? facts.sources : host.sources).filter((s) => only === undefined || s === only);
      if (!facts) {
        for (const source of sources) send({ source, window: null, fresh });
        return;
      }
      for (const window of visibleWindows(facts.today)) {
        for (const source of sources) send({ source, window, fresh });
      }
    },

    dispose() {
      live = false;
      for (const cancel of timers) cancel();
      timers.clear();
    },
  };
}
