'use client';

// The Jewish times API's keys (GET api-keys; spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §2.1). `load` asks
// for the whole list; `create` makes a key and answers it once (the sheet shows it and forgets it; it is never logged or
// kept here); `revoke` revokes one by its id. Each reloads the list when it worked; one change runs at a time (`working`:
// 'create', or the id being revoked). `activeCount` is what the Overview shows once the list is in.

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminGet, adminPost, BUSY, outcomeOf, type AdminResult, type Outcome } from './admin-api';
import type { ApiKeyItem, ApiKeysAnswer, CreatedKeyAnswer } from './types';
import type { LoadStatus } from './use-users';

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [working, setWorking] = useState<'create' | number | null>(null);
  const latest = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    const result = await adminGet<ApiKeysAnswer>('api-keys');
    if (mine !== latest.current) return;
    if (result.ok) {
      setKeys(result.data.keys ?? []);
      setStatus('ready');
    } else {
      setStatus((s) => (s === 'ready' ? s : 'failed'));
    }
  }, []);

  const create = useCallback(
    async (appName: string, origins: string): Promise<AdminResult<CreatedKeyAnswer>> => {
      if (running.current) return BUSY;
      running.current = true;
      setWorking('create');
      try {
        const result = await adminPost<CreatedKeyAnswer>('api-keys', { action: 'create', appName, origins });
        if (result.ok) await load();
        return result;
      } finally {
        running.current = false;
        setWorking(null);
      }
    },
    [load],
  );

  const revoke = useCallback(
    async (item: ApiKeyItem): Promise<Outcome> => {
      if (running.current) return BUSY;
      running.current = true;
      setWorking(item.id);
      try {
        const outcome = outcomeOf(await adminPost('api-keys', { action: 'revoke', id: item.id }));
        if (outcome.ok) await load();
        return outcome;
      } finally {
        running.current = false;
        setWorking(null);
      }
    },
    [load],
  );

  const activeCount = status === 'ready' ? keys.filter((k) => k.revokedAt === null).length : null;
  return { keys, status, working, activeCount, load, create, revoke };
}
