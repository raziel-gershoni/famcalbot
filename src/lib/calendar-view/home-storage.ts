// The calendar home's memory on the device (spec §7.1 State, §7.4 Memory; Plan E Ruling 2):
// - the tab on screen, in sessionStorage, so a new session opens on the Agenda, the landing
//   tab (§7.3), while a reload inside a session keeps the tab;
// - the Month's upright split (collapsed or grown), in localStorage, kept per device (v2; release
//   1's v1 layout, browse or picked, is mapped to it once and removed);
// - the Connect Telegram banner's close (6c-1), in localStorage: closed on this device for this account.
// Both keys end with the page's own user_id as it is (a Telegram id or a DB id, never
// swapped for the other), so two accounts on one device keep their own. Every access is
// in try/catch: storage can be missing, blocked (private mode, a WebView's settings), full,
// or throw on the property read itself. A read then gives its default, and a write does
// nothing: the memory is a convenience.
//
// Pure, no React and no imports; nothing touches window at import, so the server render
// can import it (a read there gives the default).

/** The two tabs of the calendar home (spec §7.1). */
export type HomeTab = 'agenda' | 'month';

/** The sessionStorage key for the tab on screen. */
export function homeTabKey(userId: number): string {
  return 'famcal:homeTab:v1:' + userId;
}

/** The Month's layout on the one Month screen: the upright split collapsed, or the month grown over the list. */
export type MonthSplit = 'split' | 'grown';

/** The localStorage key for the Month's split (v2; v1's 'browse' | 'picked' is mapped once). */
export function monthSplitKey(userId: string): string {
  return 'famcal:monthLayout:v2:' + userId;
}

/** The localStorage key for the Connect Telegram banner's close. */
export function connectBannerKey(userId: number): string {
  return 'famcal:connectBanner:v1:' + userId;
}

type Area = 'sessionStorage' | 'localStorage';

/** The string under `key`, or null: no window, no storage, a throw, or nothing stored. */
function readKey(area: Area, key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const value: unknown = window[area].getItem(key);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Stores `value` under `key`; never throws. */
function writeKey(area: Area, key: string, value: string): void {
  try {
    if (typeof window === 'undefined') return;
    window[area].setItem(key, value);
  } catch {
    // Blocked or full: the tab or layout just isn't remembered.
  }
}

/** The tab this session last showed; 'agenda' with no window, a throw or an unknown value. */
export function readHomeTab(userId: number): HomeTab {
  return readKey('sessionStorage', homeTabKey(userId)) === 'month' ? 'month' : 'agenda';
}

/** Remembers the tab on screen for this session. Never throws. */
export function writeHomeTab(userId: number, tab: HomeTab): void {
  writeKey('sessionStorage', homeTabKey(userId), tab);
}

/** Removes `key`; never throws. */
function removeKey(area: Area, key: string): void {
  try {
    if (typeof window === 'undefined') return;
    window[area].removeItem(key);
  } catch (err) {
    console.warn('[home-storage] could not remove a key:', err);
  }
}

/**
 * The Month's split on this device: the v2 value when valid; else v1's 'browse' as
 * 'grown' and 'picked' as 'split', written to v2 with v1 removed (mapped once); else
 * 'split'. Storage that throws gives 'split'.
 */
export function readMonthSplit(userId: string): MonthSplit {
  const v2 = readKey('localStorage', monthSplitKey(userId));
  if (v2 === 'split' || v2 === 'grown') return v2;
  // Release 1's key for the Month's layout (All months or the tapped day), read once more and removed.
  const v1Key = 'famcal:monthLayout:v1:' + userId;
  const v1 = readKey('localStorage', v1Key);
  if (v1 !== 'browse' && v1 !== 'picked') return 'split';
  const split: MonthSplit = v1 === 'browse' ? 'grown' : 'split';
  writeMonthSplit(userId, split);
  removeKey('localStorage', v1Key);
  return split;
}

/** Remembers the Month's split on this device. Never throws. */
export function writeMonthSplit(userId: string, split: MonthSplit): void {
  writeKey('localStorage', monthSplitKey(userId), split);
}

/** Whether this device closed the Connect Telegram banner for this account; false with no window, a throw or nothing stored. */
export function readConnectBannerClosed(userId: number): boolean {
  return readKey('localStorage', connectBannerKey(userId)) === '1';
}

/** Remembers on this device that the Connect Telegram banner was closed for this account. Never throws. */
export function writeConnectBannerClosed(userId: number): void {
  writeKey('localStorage', connectBannerKey(userId), '1');
}
