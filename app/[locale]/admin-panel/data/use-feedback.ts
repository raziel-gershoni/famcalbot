'use client';

// What people sent through the feedback form (GET feedback), newest first, 50 a page. `load` asks for the first page (a
// screen opening, the Overview wanting the count); `loadMore` appends the next while the route says there is one. A newer
// first page makes an older answer stale, and `loadMore` ignores a tap while a request is running. A list already on
// screen stays while it loads again.

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminGet } from './admin-api';
import type { FeedbackAnswer, FeedbackItem } from './types';
import type { LoadStatus } from './use-users';

export const FEEDBACK_PAGE_SIZE = 50;

export function useFeedback() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const latest = useRef(0);
  const busy = useRef(false);
  const itemsRef = useRef<FeedbackItem[]>([]);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  const fetchPage = useCallback(async (reset: boolean) => {
    if (!reset && busy.current) return;
    const mine = reset ? ++latest.current : latest.current;
    busy.current = true;
    if (reset) setStatus((s) => (s === 'ready' ? s : 'loading'));
    else {
      setLoadingMore(true);
      setMoreFailed(false);
    }
    const offset = reset ? 0 : itemsRef.current.length;
    const result = await adminGet<FeedbackAnswer>('feedback', offset ? { limit: FEEDBACK_PAGE_SIZE, offset } : { limit: FEEDBACK_PAGE_SIZE });
    if (mine !== latest.current) return;
    busy.current = false;
    if (!result.ok) {
      if (reset) setStatus((s) => (s === 'ready' ? s : 'failed'));
      else {
        setLoadingMore(false);
        setMoreFailed(true);
      }
      return;
    }
    const page = result.data.feedbacks ?? [];
    const known = new Set(reset ? [] : itemsRef.current.map((item) => item.id));
    itemsRef.current = reset ? page : [...itemsRef.current, ...page.filter((item) => !known.has(item.id))];
    setItems(itemsRef.current);
    setTotal(result.data.pagination?.total ?? itemsRef.current.length);
    setHasMore(result.data.pagination?.hasMore ?? false);
    setStatus('ready');
    setLoadingMore(false);
  }, []);

  const load = useCallback(() => fetchPage(true), [fetchPage]);
  const loadMore = useCallback(() => fetchPage(false), [fetchPage]);

  return { items, total, hasMore, status, loadingMore, moreFailed, load, loadMore };
}
