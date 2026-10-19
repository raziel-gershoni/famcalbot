// The calendar home's reload-once guard (spec §5): a failed chunk load reloads the page
// once. A leaf with no imports, so PageGate's boundary around the home's chunk (D7) can
// use it without pulling the home's code into the chunk every page loads. Client
// components only; nothing here touches window at import.

/** The chunk-load guard's sessionStorage key, shared by PageGate's boundary and the home's own. */
export const CHUNK_RELOAD_KEY = 'famcal:calendarHome:chunkReload:v1';

/** A failed chunk load (a deploy replaced the files while the app was open). */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'ChunkLoadError' ||
    /Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(error.message)
  );
}

/** How long a reload-once guard holds: longer than the switch's 30 s memo. */
const RELOAD_GUARD_MS = 60_000;

/**
 * Reloads the page, unless this guard already reloaded it in the last minute. Returns
 * whether it reloaded. With no sessionStorage (blocked, private mode) it never reloads,
 * so it can never loop. `beforeReload` runs just before the reload, only when it happens:
 * a reload runs no React cleanup, so whatever must be let go first (Telegram's
 * BackButton, which the client keeps across reloads) goes there.
 */
export function reloadOnce(key: string, nowMs: number = Date.now(), beforeReload?: () => void): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(key));
    if (Number.isFinite(last) && last > 0 && nowMs - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(key, String(nowMs));
  } catch {
    return false;
  }
  try {
    beforeReload?.();
  } catch {
    // The reload matters more.
  }
  try {
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}
