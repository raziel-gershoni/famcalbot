// The calendar home's memory on the device (spec §7.1 State, §7.4 Memory; Plan E Ruling 2):
// - the tab on screen, in sessionStorage, so a new session opens on the Agenda, the landing
//   tab (§7.3), while a reload inside a session keeps the tab;
// - the Month's layout (browse or picked), in localStorage, kept per device.
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

/** The localStorage key for the Month's layout. */
export function monthLayoutKey(userId: number): string {
  return 'famcal:monthLayout:v1:' + userId;
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

/** The Month's last layout on this device; null when none is stored, it's unknown, or storage fails. */
export function readMonthLayout(userId: number): 'browse' | 'picked' | null {
  const value = readKey('localStorage', monthLayoutKey(userId));
  return value === 'browse' || value === 'picked' ? value : null;
}

/** Remembers the Month's layout on this device. Never throws. */
export function writeMonthLayout(userId: number, layout: 'browse' | 'picked'): void {
  writeKey('localStorage', monthLayoutKey(userId), layout);
}
