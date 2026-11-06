'use client';

// One device's notifications on a screen (spec 2026-11-05-web-push §2.1, §2.4; plan 6c-2 Task 5): Settings' card
// "Notifications on this device" and the home's banner "Get reminders on this device" share it, as the Connect Telegram
// buttons share useTelegramConnect.
// - Every app open checks this browser (checkPushOnOpen, which never installs the worker): a subscription this account has
//   shows as on, another account's (a shared browser) is undone there. It runs for every account in a browser (with no
//   subscription it makes no request), never inside Telegram. The home always calls it; Settings only in its card.
// - The press turns on (turnOnPush runs in the tap itself: the browser's prompt needs the tap), turns off while on, or, when
//   turning on needs a sign-in from the last hour (the page's push.recentSignIn, or the route's stale answer), signs this
//   browser in again (signInAgain) and asks the browser nothing.
// - What came of a press is `line`, worded by pushLineKey (keys of settings); 'again' is the switch's own words.
// - onDevices follows the account's count of devices that are on (Settings' rows a notification can honour come back with one).
// Client-safe; never throws.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { signInAgain } from './sign-in-again';
import { isInTelegram } from './telegram-ui';
import { checkPushOnOpen, pushBlocked, pushSupport, turnOffPush, turnOnPush, type PushProps, type PushSupport } from './web-push-client';

/**
 * Where this device is: 'checking' until the open's check answers; 'busy' turning on, 'stopping' turning off; 'stale' when
 * turning on needs a sign-in from the last hour first, 'leaving' on the way to /signin.
 */
export type PushPhase = 'checking' | 'off' | 'busy' | 'on' | 'stopping' | 'stale' | 'leaving';
/** What came of a press ('denied' also of the open): worded by pushLineKey. 'again' is the switch's own words, not a line. */
export type PushLine = 'again' | 'dismissed' | 'denied' | 'refused' | 'failed' | 'offFailed' | 'signInFailed';

export interface PushDevice {
  /** null until the client has read it (the server's render and hydration). */
  support: PushSupport | null;
  phase: PushPhase;
  line: PushLine | null;
  /** The tap: turn on (in the tap itself), turn off, or sign in again. Nothing while a press runs or before the open's check. */
  press: () => void;
}

/** The Home Screen steps for iPhone and iPad, keys of settings: the card's and the banner's. */
export const IOS_STEPS = ['push.ios.step1', 'push.ios.step2', 'push.ios.step3'] as const;

/** A line's words (a key of settings) and whether it is a problem (an alert); null for none and for 'again'. */
export function pushLineKey(line: PushLine | null): { key: string; problem: boolean } | null {
  switch (line) {
    case 'dismissed':
      return { key: 'push.dismissed', problem: false };
    case 'denied':
      return { key: 'push.denied', problem: false };
    case 'refused':
      return { key: 'push.refused', problem: true };
    case 'failed':
      return { key: 'push.failed', problem: true };
    case 'offFailed':
      return { key: 'push.offFailed', problem: true };
    case 'signInFailed':
      return { key: 'signIn.failed', problem: true };
    default:
      return null;
  }
}

/** Nothing to subscribe to: the support is read once on the client. */
const subscribeNothing = () => () => {};
/** On the server and while hydrating: not read yet. */
const notRead = () => null;

export function usePushDevice(userId: number, push: PushProps | null | undefined, locale: string, onDevices?: (update: (count: number) => number) => void): PushDevice {
  const support = useSyncExternalStore<PushSupport | null>(subscribeNothing, pushSupport, notRead);
  const [phase, setPhase] = useState<PushPhase>('checking');
  const [line, setLine] = useState<PushLine | null>(null);
  const running = useRef(false);
  const recent = push?.recentSignIn === true;
  const key = push?.key ?? null;

  // The open's check: never inside Telegram, never where push can't work (no request without a subscription)
  useEffect(() => {
    if (support !== 'supported' || isInTelegram()) return;
    let live = true;
    void checkPushOnOpen(userId).then((state) => {
      if (!live) return;
      setPhase(state === 'on' ? 'on' : recent ? 'off' : 'stale');
      setLine(state === 'off' && pushBlocked() ? 'denied' : null);
    });
    return () => {
      live = false;
    };
  }, [support, userId, recent]);

  const press = () => {
    if (running.current || !key || support !== 'supported') return;
    if (phase === 'stale') {
      running.current = true;
      setPhase('leaving');
      setLine(null);
      void signInAgain(locale).then((left) => {
        // Leaving: the page is on its way to /signin and keeps its spinner; a failure lets it be pressed again
        if (left) return;
        running.current = false;
        setPhase('stale');
        setLine('signInFailed');
      });
      return;
    }
    if (phase === 'on') {
      running.current = true;
      setPhase('stopping');
      setLine(null);
      void turnOffPush(userId).then((off) => {
        running.current = false;
        if (!off) {
          setPhase('on');
          setLine('offFailed');
          return;
        }
        setPhase(recent ? 'off' : 'stale');
        onDevices?.((count) => Math.max(0, count - 1));
      });
      return;
    }
    if (phase !== 'off') return;
    running.current = true;
    setPhase('busy');
    setLine(null);
    // Synchronously in the tap: turnOnPush's first lines start the prompt and the install
    void turnOnPush(userId, key).then((result) => {
      running.current = false;
      if (result.ok) {
        setPhase('on');
        onDevices?.(() => result.count);
        return;
      }
      if (result.reason === 'stale') {
        setPhase('stale');
        return;
      }
      setPhase('off');
      setLine(result.reason);
    });
  };

  return { support, phase, line, press };
}
