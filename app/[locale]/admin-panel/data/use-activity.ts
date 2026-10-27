'use client';

// The activity log of everyone (GET user-activity), 20 rows a page. It asks for the first page once, when the screen that
// owns the hook mounts, and again when the action filter changes: the filter is the only thing the fetch effect watches.
// "Show more" appends the next page. Every first page makes an earlier answer stale (a filter picked while a page was on
// its way), and "Show more" ignores a tap while a request is running.
//
// The status starts as loading and `setFilter` sets it again, in the event, and the state changes in the answer's
// callback: the effect that asks for a page sets no state itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminGet, type AdminResult } from './admin-api';
import type { ActivityAnswer, ActivityItem, ActivityStats } from './types';
import type { LoadStatus } from './use-users';

export const ACTIVITY_PAGE_SIZE = 20;

export function useActivity() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [stats, setStats] = useState<ActivityStats[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  /** '' is every action. */
  const [filter, setFilterState] = useState('');
  const latest = useRef(0);
  const busy = useRef(false);
  const itemsRef = useRef<ActivityItem[]>([]);
  useEffect(
    () => () => {
      // Gone: a page that is still on its way lands nowhere
      latest.current++;
    },
    [],
  );

  const apply = useCallback((answer: ActivityAnswer, reset: boolean) => {
    const page = answer.activities ?? [];
    const known = new Set(reset ? [] : itemsRef.current.map((item) => item.id));
    itemsRef.current = reset ? page : [...itemsRef.current, ...page.filter((item) => !known.has(item.id))];
    setItems(itemsRef.current);
    if (reset) setStats(answer.actionStats ?? []);
    setHasMore(answer.pagination?.hasMore ?? false);
  }, []);

  /** An answer to a first page: applied unless a newer first page, or the screen going, has made it stale. */
  const finishFirst = useCallback(
    (mine: number, result: AdminResult<ActivityAnswer>) => {
      if (mine !== latest.current) return;
      busy.current = false;
      setLoadingMore(false);
      setMoreFailed(false);
      if (result.ok) {
        apply(result.data, true);
        setStatus('ready');
      } else {
        setStatus('failed');
      }
    },
    [apply],
  );

  /** Ask for the first page of an action's log (every action for ''). */
  const askFirst = useCallback(
    (action: string) => {
      const mine = ++latest.current;
      busy.current = true;
      return adminGet<ActivityAnswer>('user-activity', { limit: ACTIVITY_PAGE_SIZE, offset: 0, action: action || undefined }).then((result) => finishFirst(mine, result));
    },
    [finishFirst],
  );

  // The one fetch when the screen opens, and one per filter change
  useEffect(() => {
    void askFirst(filter);
  }, [filter, askFirst]);

  const setFilter = useCallback(
    (action: string) => {
      if (action === filter) return;
      setStatus('loading');
      setFilterState(action);
    },
    [filter],
  );

  const loadMore = useCallback(async () => {
    if (busy.current) return;
    const mine = latest.current;
    busy.current = true;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await adminGet<ActivityAnswer>('user-activity', { limit: ACTIVITY_PAGE_SIZE, offset: itemsRef.current.length, action: filter || undefined });
    if (mine !== latest.current) return;
    busy.current = false;
    setLoadingMore(false);
    if (result.ok) apply(result.data, false);
    else setMoreFailed(true);
  }, [filter, apply]);

  const retry = useCallback(() => {
    setStatus('loading');
    void askFirst(filter);
  }, [filter, askFirst]);

  return { items, stats, hasMore, status, loadingMore, moreFailed, filter, setFilter, loadMore, retry };
}
