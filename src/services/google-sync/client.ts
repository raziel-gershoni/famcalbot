// The copy-to-Google worker's Google client and its per-run call budget (google-sync spec §4,
// Pace). The one place the worker, the Remove/Keep code and the hard delete get a Google
// client from, so the smokes fake Google here and nothing reaches the network.

import { calendar as googleCalendar, type calendar_v3 } from '@googleapis/calendar';
import { getGoogleAuth } from '../calendar';
import { googleAccountOf } from './account';

/** A user's Google, for the sync: the Calendar API and the account the token belongs to. */
export interface SyncGoogle {
  api: calendar_v3.Calendar;
  /** The token's account (its primary calendar's id, account.ts). Refreshes the access token first. */
  account: () => Promise<string>;
}

type SyncGoogleFactory = (refreshToken: string) => SyncGoogle;
const seam = globalThis as { __syncGoogleForTests?: SyncGoogleFactory | null };

/** Smoke scripts only: every syncGoogle call gets the fake Google this factory builds (null: the real one again). */
export function __useSyncGoogleForTests(factory: SyncGoogleFactory | null): void {
  seam.__syncGoogleForTests = factory;
}

/** The Calendar API on a refresh token (decrypted). No timeout of its own: Google's and the platform's apply. */
export function syncGoogle(refreshToken: string): SyncGoogle {
  if (seam.__syncGoogleForTests) return seam.__syncGoogleForTests(refreshToken);
  const auth = getGoogleAuth(refreshToken);
  return {
    api: googleCalendar({ version: 'v3', auth }),
    account: async () => {
      const { token } = await auth.getAccessToken();
      if (!token) throw new Error('Google gave no access token');
      return googleAccountOf(token);
    },
  };
}

/** How many Google calls a user's run may still make (spec §4: at most 100 per user per run). */
export interface CallBudget {
  left: number;
}

export const CALLS_PER_RUN = 100;

/** The budget ran out: the user's run ends here, and the rest waits for the next tick. */
export class BudgetSpent extends Error {
  constructor() {
    super('The run used its Google calls');
    this.name = 'BudgetSpent';
  }
}

/** One Google call, counted against the budget. Throws BudgetSpent, before calling, once it is used up. */
export async function counted<T>(budget: CallBudget, call: () => Promise<T>): Promise<T> {
  if (budget.left <= 0) throw new BudgetSpent();
  budget.left -= 1;
  return call();
}
