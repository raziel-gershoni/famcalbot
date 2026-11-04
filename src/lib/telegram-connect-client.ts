// Connect Telegram from the browser (spec 2026-11-03-web-sign-up §2.9, §3.6, §4; plan 6c-1 Task 9): the one client helper the
// home's banner, Settings (the note card and Sign in on the web) and Plans share. A press asks POST
// /api/telegram-connect?user_id=<id> (Task 6's route: the session cookie, a sign-in within the hour, 5 links an hour) for a
// one-time bot link and opens it in this tab: on a phone Telegram's app takes it, on a computer t.me's page offers to open it.
// A sign-in over an hour old answers 'stale-sign-in' (or a 401 when the session is gone): the button then says "Sign in again
// to connect Telegram", and its press signs this browser out and opens /signin (signInAgain), so the next sign-in is fresh.
// The link is a credential for 10 minutes: no log line holds it or its token; a failure logs the status and a known error code.
//
// Client-safe. Strings: telegramConnect.* (each screen words them; this file names the keys only).

import { useRef, useState } from 'react';
import { readJsonBody } from '@/src/lib/read-json';
import { signInAgain } from '@/src/lib/sign-in-again';

const TAG = '[telegram-connect]';
/** The route's refusals (Task 6): the only error codes a log line may name. */
const KNOWN_ERRORS: readonly string[] = ['has-chat', 'stale-sign-in', 'limit', 'unavailable'];

export type ConnectResult = 'opened' | 'stale-sign-in' | 'limit' | 'failed';

/** Asks for the one-time link and opens it in this tab; what came of it. Never throws. */
export async function openTelegramConnect(userId: number): Promise<ConnectResult> {
  let res: Response;
  try {
    res = await fetch(`/api/telegram-connect?user_id=${userId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (error) {
    console.error(`${TAG} the request got no answer: ${error instanceof Error ? error.name : typeof error}`);
    return 'failed';
  }
  const body = await readJsonBody(res, TAG);
  const url = body?.url;
  if (res.ok && typeof url === 'string') {
    if (!url.startsWith('https://t.me/')) {
      console.error(`${TAG} the answer (${res.status}) is not a Telegram link`);
      return 'failed';
    }
    try {
      window.location.href = url;
      return 'opened';
    } catch (error) {
      console.error(`${TAG} the link could not be opened: ${error instanceof Error ? error.name : typeof error}`);
      return 'failed';
    }
  }
  const code = typeof body?.error === 'string' && KNOWN_ERRORS.includes(body.error) ? body.error : null;
  console.warn(`${TAG} answered ${res.status} (${code ?? 'no known code'})`);
  if (code === 'stale-sign-in' || res.status === 401) return 'stale-sign-in';
  if (code === 'limit' || res.status === 429) return 'limit';
  return 'failed';
}

/** Where a Connect Telegram button is. 'leaving' is the sign-out on the way to /signin after a stale sign-in. */
export type ConnectPhase = 'idle' | 'busy' | 'leaving' | 'opened' | 'stale' | 'limit' | 'failed';

/** The button's words for a phase, a key of telegramConnect. */
export function connectButtonKey(phase: ConnectPhase): 'action' | 'opening' | 'signInAgain' {
  if (phase === 'busy') return 'opening';
  if (phase === 'stale' || phase === 'leaving') return 'signInAgain';
  return 'action';
}

/** The line under the button (a key of telegramConnect) and whether it is a problem (an alert); null when there is none. */
export function connectLineKey(phase: ConnectPhase): { key: 'opened' | 'limit' | 'failed'; problem: boolean } | null {
  if (phase === 'opened') return { key: 'opened', problem: false };
  if (phase === 'limit') return { key: 'limit', problem: true };
  if (phase === 'failed') return { key: 'failed', problem: true };
  return null;
}

const PHASE_OF: Record<ConnectResult, ConnectPhase> = { opened: 'opened', 'stale-sign-in': 'stale', limit: 'limit', failed: 'failed' };

/**
 * One Connect Telegram button: its phase and its press. A press asks for the link, or after a stale sign-in signs in again.
 * One request at a time: a second press while one runs, or after the page started leaving for /signin, does nothing.
 */
export function useTelegramConnect(userId: number, locale: string): { phase: ConnectPhase; press: () => void } {
  const [phase, setPhase] = useState<ConnectPhase>('idle');
  const running = useRef(false);
  const press = () => {
    if (running.current) return;
    running.current = true;
    if (phase === 'stale') {
      setPhase('leaving');
      void signInAgain(locale).then((left) => {
        // Leaving: the page is on its way to /signin and the button keeps its spinner; a failure lets it be pressed again.
        if (left) return;
        running.current = false;
        setPhase('failed');
      });
      return;
    }
    setPhase('busy');
    void openTelegramConnect(userId).then((result) => {
      running.current = false;
      setPhase(PHASE_OF[result]);
    });
  };
  return { phase, press };
}
