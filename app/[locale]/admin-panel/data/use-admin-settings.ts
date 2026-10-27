'use client';

// The five global switches (AdminSettings). `setFlag` flips the switch at once and posts `{ <flag>: value, initData }`; if
// the post fails, the switch goes back to what it was and the caller says so (the outcome). A switch that is saving
// ignores a second call (`saving[flag]` is true, and the screen disables the row).

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminPost, BUSY, outcomeOf, type Outcome } from './admin-api';
import { ADMIN_FLAGS, type AdminFlag, type AdminFlags } from './types';

const NONE_SAVING = Object.fromEntries(ADMIN_FLAGS.map((flag) => [flag, false])) as AdminFlags;

export function useAdminSettings(initial: AdminFlags) {
  const [flags, setFlags] = useState<AdminFlags>(initial);
  const [saving, setSaving] = useState<AdminFlags>(NONE_SAVING);
  // The ref is what holds a second tap back: state shows the first one's saving only after a render.
  const running = useRef(new Set<AdminFlag>());
  const current = useRef(flags);
  useEffect(() => {
    current.current = flags;
  });

  const setFlag = useCallback(async (flag: AdminFlag, value: boolean): Promise<Outcome> => {
    if (running.current.has(flag)) return BUSY;
    running.current.add(flag);
    const previous = current.current[flag];
    setFlags((f) => ({ ...f, [flag]: value }));
    setSaving((s) => ({ ...s, [flag]: true }));
    try {
      const outcome = outcomeOf(await adminPost('settings', { [flag]: value }));
      if (!outcome.ok) setFlags((f) => ({ ...f, [flag]: previous }));
      return outcome;
    } finally {
      running.current.delete(flag);
      setSaving((s) => ({ ...s, [flag]: false }));
    }
  }, []);

  return { flags, saving, setFlag };
}
