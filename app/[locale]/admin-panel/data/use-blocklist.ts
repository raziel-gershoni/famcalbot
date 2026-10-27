'use client';

// The blocklist: Telegram ids and WhatsApp numbers that cannot register again (GET users/blocklist; it survives a delete of
// the person). `load` asks for the whole list. `unban` takes one entry off (POST users/blocklist, action unban, with the
// entry's own identifiers), reloads the list when it worked, and answers an Outcome the screen words; one unban runs at
// a time (`unbanning` is its entry's id).

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminGet, adminPost, BUSY, outcomeOf, type Outcome } from './admin-api';
import type { BlocklistAnswer, BlocklistEntry } from './types';
import type { LoadStatus } from './use-users';

export function useBlocklist() {
  const [entries, setEntries] = useState<BlocklistEntry[]>([]);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [unbanning, setUnbanning] = useState<number | null>(null);
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
    const result = await adminGet<BlocklistAnswer>('users/blocklist');
    if (mine !== latest.current) return;
    if (result.ok) {
      setEntries(result.data.blocklist ?? []);
      setStatus('ready');
    } else {
      setStatus((s) => (s === 'ready' ? s : 'failed'));
    }
  }, []);

  const unban = useCallback(
    async (entry: BlocklistEntry): Promise<Outcome> => {
      if (running.current) return BUSY;
      running.current = true;
      setUnbanning(entry.id);
      try {
        const outcome = outcomeOf(await adminPost('users/blocklist', { action: 'unban', telegramId: entry.telegramId, whatsappPhone: entry.whatsappPhone }));
        if (outcome.ok) await load();
        return outcome;
      } finally {
        running.current = false;
        setUnbanning(null);
      }
    },
    [load],
  );

  return { entries, status, unbanning, load, unban };
}
