/**
 * The Telegram Mini App calls the calendar home makes (spec §7.1 Look, §7.6; the vertical
 * swipes follow Plan E Ruling 9). Every SDK call is gated with isVersionAtLeast and
 * wrapped in try/catch, so a 6.0 client, a plain browser (the SDK defines Telegram.WebApp
 * there too, at version 6.0) or a method that throws never breaks the page; in a browser
 * the in-page buttons do the same jobs.
 *
 * Client components only. Nothing here touches window at import, and while rendering on
 * the server the hooks make no call (the theme is 'light').
 */

import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { readInitData } from './read-init-data';

/** The Bot API version each call needs. */
const BACK_BUTTON = '6.1';
const COLOURS = '6.1';
const OPEN_LINK = '6.1';
const HAPTIC = '6.1';
const VERTICAL_SWIPES = '7.7';

/** Events newer than the first SDK (6.0). */
const EVENT_VERSION: Partial<Record<TelegramWebAppEventType, string>> = {
  backButtonClicked: '6.1',
  activated: '8.0',
  deactivated: '8.0',
  safeAreaChanged: '8.0',
  contentSafeAreaChanged: '8.0',
};

/** The SDK object once telegram-web-app.js has run, else null (server, script blocked). */
export function telegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/** Inside Telegram: the launch carried signed initData. The SDK object alone proves nothing. */
export function isInTelegram(): boolean {
  return readInitData() !== '';
}

/** Whether this client supports Bot API `version`. False with no SDK, or when the check throws. */
export function telegramSupports(version: string): boolean {
  const tg = telegramWebApp();
  if (!tg || typeof tg.isVersionAtLeast !== 'function') return false;
  try {
    return tg.isVersionAtLeast(version) === true;
  } catch {
    return false;
  }
}

/** Whether Telegram's own BackButton is there to use: inside Telegram, on a client that has it (Bot API 6.1). */
export function hasTelegramBackButton(): boolean {
  return isInTelegram() && telegramSupports(BACK_BUTTON);
}

/** Runs `call` when the client supports `version`. A throw is logged, never raised. True when it ran. */
function tgCall(version: string, what: string, call: (tg: TelegramWebApp) => void): boolean {
  const tg = telegramWebApp();
  if (!tg || !telegramSupports(version)) return false;
  try {
    call(tg);
    return true;
  } catch (err) {
    console.warn(`[telegram-ui] ${what} failed:`, err);
    return false;
  }
}

/**
 * Subscribes `handler` to a Telegram event when the client has that event (activated and
 * deactivated need Bot API 8.0). Returns the unsubscribe, a no-op when nothing subscribed.
 */
export function onTelegramEvent(event: TelegramWebAppEventType, handler: () => void): () => void {
  const version = EVENT_VERSION[event] ?? '6.0';
  if (!tgCall(version, `onEvent(${event})`, (tg) => tg.onEvent(event, handler))) return () => {};
  return () => {
    tgCall(version, `offEvent(${event})`, (tg) => tg.offEvent(event, handler));
  };
}

/** The handler useTelegramBackButton has on the button now, for releaseTelegramBackButton. */
let liveBackHandler: (() => void) | null = null;

/**
 * Telegram's BackButton (Bot API 6.1+) while `active`; a tap calls the latest `onBack`.
 * - On mount it hides the button: the client keeps it across reloads.
 * - While active: one handler (onClick), then show().
 * - Whenever it stops being needed (`active` turns false, or unmount): offClick(that
 *   handler), then hide(), each on its own so a throw in one still runs the other.
 * The SDK calls every registered handler and any hide() hides the one button, so one
 * component owns it per screen: AppScreen (components/app-ui/AppScreen.tsx) makes the single
 * call and decides what a tap does.
 */
export function useTelegramBackButton(active: boolean, onBack: () => void): void {
  const back = useEffectEvent(onBack);

  useEffect(() => {
    tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
  }, []);

  useEffect(() => {
    if (!active) return;
    const handler = () => back();
    tgCall(BACK_BUTTON, 'BackButton.show', (tg) => {
      tg.BackButton.onClick(handler);
      tg.BackButton.show();
    });
    liveBackHandler = handler;
    return () => {
      if (liveBackHandler === handler) liveBackHandler = null;
      tgCall(BACK_BUTTON, 'BackButton.offClick', (tg) => tg.BackButton.offClick(handler));
      tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
    };
  }, [active]);
}

/**
 * Lets the BackButton go at once, outside React: offClick(the live handler, if any), then
 * hide(). For a page reload (spec §5: a chunk-load error), which runs no
 * React cleanup while the client keeps the button across it (§7.6): otherwise the page
 * after the reload would show a back button that does nothing.
 */
export function releaseTelegramBackButton(): void {
  const handler = liveBackHandler;
  liveBackHandler = null;
  if (handler) tgCall(BACK_BUTTON, 'BackButton.offClick', (tg) => tg.BackButton.offClick(handler));
  tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
}

/** enableVerticalSwipes() or disableVerticalSwipes() on a 7.7+ client; a throw is logged. */
function setVerticalSwipes(enabled: boolean): void {
  if (enabled) tgCall(VERTICAL_SWIPES, 'enableVerticalSwipes', (tg) => tg.enableVerticalSwipes());
  else tgCall(VERTICAL_SWIPES, 'disableVerticalSwipes', (tg) => tg.disableVerticalSwipes());
}

/**
 * Telegram's swipe down to minimize or close (Bot API 7.7+; spec §7.6, Plan E Ruling 9):
 * off while `locked`, on otherwise. The home locks it while the Month shows browse, where
 * a drag down at the top would take the app away instead of scrolling the months.
 * - Each change of `locked` makes one call: disableVerticalSwipes() when it locks,
 *   enableVerticalSwipes() when it unlocks. A re-render with the same value makes none.
 * - On mount it makes the call for its `locked`, so an unlocked mount enables: a reload
 *   can leave swipes off.
 * - On unmount it enables.
 * - It only sets, never reads isVerticalSwipesEnabled, which is wrong after a reload.
 * One mounted component owns it at a time (the home's container, or the error card in its
 * place): another one's unmount would turn swipes back on under the first one's lock.
 */
export function useTelegramVerticalSwipes(locked: boolean): void {
  useEffect(() => {
    setVerticalSwipes(!locked);
  }, [locked]);

  useEffect(() => () => setVerticalSwipes(true), []);
}

/**
 * Lets Telegram's controls go at once, outside React, before a page reload (spec §5: a
 * chunk-load error): releaseTelegramBackButton(), then
 * enableVerticalSwipes(). A reload runs no React cleanup, and the client can keep both
 * across it, so the page after it could otherwise show a back button that does nothing,
 * or keep swipes off where nothing locks them.
 */
export function releaseTelegramControls(): void {
  releaseTelegramBackButton();
  setVerticalSwipes(true);
}

/**
 * Swipe-to-close back on, for the pages that never lock it: PageGate calls this at start,
 * because a reload keeps the client's setting and a page that locked it (the home's Month
 * browse) may be the one before it. The home locks again when it shows Month.
 */
export function enableTelegramVerticalSwipes(): void {
  setVerticalSwipes(true);
}

export type ColorScheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Telegram's colorScheme inside Telegram, else prefers-color-scheme. */
function colorSchemeNow(): ColorScheme {
  const tg = telegramWebApp();
  if (tg && isInTelegram()) return tg.colorScheme === 'dark' ? 'dark' : 'light';
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function subscribeColorScheme(onChange: () => void): () => void {
  if (telegramWebApp() && isInTelegram()) return onTelegramEvent('themeChanged', onChange);
  try {
    const query = window.matchMedia(DARK_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}

const serverColorScheme = (): ColorScheme => 'light';

/** Telegram's header and the area behind the page in one of the theme's colours (6.1+), each call on its own. */
export function applyTelegramColours(key: 'bg_color' | 'secondary_bg_color' = 'bg_color'): void {
  tgCall(COLOURS, `setHeaderColor('${key}')`, (tg) => tg.setHeaderColor(key));
  tgCall(COLOURS, `setBackgroundColor('${key}')`, (tg) => tg.setBackgroundColor(key));
}

/**
 * The home's look (spec §7.1). On mount, and again on every themeChanged, Telegram's
 * header and background take the theme's bg_color (no page sets a colour of its own
 * any more). A grouped screen (cards on a ground, Settings) takes secondary_bg_color in a
 * light theme, the ground its cards sit on, and bg_color in a dark one, where the ground
 * is the page's own; the scheme is read when the event fires. Returns the scheme to
 * render: Telegram's colorScheme, following themeChanged, inside Telegram;
 * prefers-color-scheme in a browser; 'light' on the server.
 */
export function useTelegramTheme(ground: 'plain' | 'grouped' = 'plain'): ColorScheme {
  useEffect(() => {
    // Its own handler: the SDK keys handlers by function, so a shared one would be
    // registered once and the first unmount would remove it for every other user.
    const apply = () => applyTelegramColours(ground === 'grouped' && colorSchemeNow() === 'light' ? 'secondary_bg_color' : 'bg_color');
    apply();
    return onTelegramEvent('themeChanged', apply);
  }, [ground]);
  return useSyncExternalStore(subscribeColorScheme, colorSchemeNow, serverColorScheme);
}

/**
 * Opens an http(s) link outside the Mini App (an event in Google Calendar): Telegram's
 * openLink on a 6.1+ client, else a new tab (a browser's SDK reports 6.0). Any other
 * link is refused. Returns whether it opened something.
 */
export function openExternalLink(url: string): boolean {
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    href = parsed.href;
  } catch {
    return false;
  }
  if (tgCall(OPEN_LINK, 'openLink', (tg) => tg.openLink(href))) return true;
  try {
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

/**
 * Telegram's own pop-up with one OK button; `onClose` runs once the person has dismissed it. True when it was shown.
 * False outside Telegram, or when the client throws (logged): the caller then says the same on its page.
 */
export function showTelegramAlert(message: string, onClose?: () => void): boolean {
  const tg = telegramWebApp();
  if (!tg || !isInTelegram()) return false;
  try {
    tg.showAlert(message, onClose);
    return true;
  } catch (err) {
    console.error('[telegram-ui] showAlert failed:', err);
    return false;
  }
}

/** The success tap after a reminder is marked done (Bot API 6.1+). Silent where the client has none. */
export function hapticSuccess(): void {
  tgCall(HAPTIC, 'HapticFeedback', (tg) => tg.HapticFeedback?.notificationOccurred('success'));
}

/** The tick when a day is tapped or a wheel settles (Bot API 6.1+). Silent where the client has none. */
export function hapticSelection(): void {
  tgCall(HAPTIC, 'HapticFeedback.selectionChanged', (tg) => tg.HapticFeedback?.selectionChanged());
}

/** The tap when an item is lifted to be dragged (Bot API 6.1+). Silent where the client has none. */
export function hapticImpact(): void {
  tgCall(HAPTIC, 'HapticFeedback.impactOccurred', (tg) => tg.HapticFeedback?.impactOccurred('medium'));
}

/** The tap for a drop that failed (Bot API 6.1+). Silent where the client has none. */
export function hapticError(): void {
  tgCall(HAPTIC, 'HapticFeedback', (tg) => tg.HapticFeedback?.notificationOccurred('error'));
}

/** The tap for something that can't be done: a lift of an item that can't move (Bot API 6.1+). Silent where the client has none. */
export function hapticWarning(): void {
  tgCall(HAPTIC, 'HapticFeedback', (tg) => tg.HapticFeedback?.notificationOccurred('warning'));
}
