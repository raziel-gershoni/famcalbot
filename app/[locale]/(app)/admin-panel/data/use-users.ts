'use client';

// The people list: every user (GET user-overrides?list=all, one answer with no paging), the filter and the search text the
// Users screen keeps while a profile is open, and `filtered`, what the screen shows. The hook lives in the panel's shell,
// above the screens, so coming back from a profile finds the search and the filter as they were.
//
// `load` may run at any time (a screen opening, an action's reload); a newer call makes an older answer stale. A list that
// is already there stays on screen while it loads again.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminGet, adminPost, type AdminResult } from './admin-api';
import type { FilterType, ResetAllAnswer, UserListAnswer, UserListItem } from './types';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** The people a filter and a search text leave: the search is a name or a Telegram id, in part, in any case. */
export function filterUsers(users: UserListItem[], filter: FilterType, search: string): UserListItem[] {
  const needle = search.trim().toLowerCase();
  return users.filter((user) => {
    if (needle && !user.name?.toLowerCase().includes(needle) && !user.telegramId?.toString().includes(needle)) return false;
    switch (filter) {
      case 'trial':
        return user.subscription?.status === 'TRIALING';
      case 'paid':
        return user.subscription?.status === 'ACTIVE' && user.subscription?.plan !== 'FREE';
      case 'free':
        return !user.subscription || (user.subscription.plan === 'FREE' && user.subscription.status !== 'TRIALING');
      case 'override':
        return user.hasOverride;
      default:
        return true;
    }
  });
}

/** Start the setup reminders of everyone still setting up over (POST reset-reminders { reset_all: true }); the answer says how many people. */
export const resetAllSetupReminders = (): Promise<AdminResult<ResetAllAnswer>> => adminPost<ResetAllAnswer>('reset-reminders', { reset_all: true });

export function useUsers() {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [filter, setFilter] = useState<FilterType>('all');
  const [search, setSearch] = useState('');
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    const result = await adminGet<UserListAnswer>('user-overrides', { list: 'all' });
    if (mine !== latest.current) return;
    if (result.ok) {
      setUsers(result.data.users ?? []);
      setStatus('ready');
    } else {
      setStatus((s) => (s === 'ready' ? s : 'failed'));
    }
  }, []);

  const filtered = useMemo(() => filterUsers(users, filter, search), [users, filter, search]);

  return { users, filtered, status, filter, setFilter, search, setSearch, load };
}
