/**
 * The process's memory, one console line every 15 minutes, to find what fills the V8 heap in production (two
 * "JavaScript heap out of memory" crashes at the 256 MB cap, 2026-11-17 and 2026-11-19, after 30-37 h up).
 *
 *   installMemoryWatch   once per process: notes the heap's size right after each full garbage collection
 *   memoryLine           the line: the lowest such size since the last line (the live floor, which climbs when
 *                        something keeps memory), the heap's spaces, native memory, open handles by kind and the
 *                        entry counts of every Map, Set or array the process keeps on globalThis
 *
 * Numbers and code names only: never a key, a value, a place, a user or an address (CLAUDE.md's logging rules).
 * No database, Redis or network, so the scheduler's tick stays free when idle.
 */

import { PerformanceObserver, constants } from 'node:perf_hooks';
import v8 from 'node:v8';

type WatchState = { installed: boolean; floor: number; fullGcs: number; unreadable: Set<string> };

const shared = globalThis as { __famcalMemoryWatch?: WatchState };
const watch: WatchState = (shared.__famcalMemoryWatch ??= { installed: false, floor: Infinity, fullGcs: 0, unreadable: new Set() });

const MB = 1024 * 1024;
const mb = (bytes: number): string => (bytes / MB).toFixed(1);

/** The caches listed in a line: the largest, so the line stays one line. */
const MAX_CACHES = 15;

/** Starts noting the heap after each full collection. Safe to call more than once. */
export function installMemoryWatch(): void {
  if (watch.installed) return;
  watch.installed = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind;
        if (kind !== constants.NODE_PERFORMANCE_GC_MAJOR) continue;
        watch.fullGcs += 1;
        const used = v8.getHeapStatistics().used_heap_size;
        if (used < watch.floor) watch.floor = used;
      }
    });
    observer.observe({ entryTypes: ['gc'] });
  } catch (error) {
    console.error('[memory] could not watch garbage collections:', error);
  }
}

/** A Map's or Set's size, or an array's length; null for anything else. */
function countOf(value: unknown): number | null {
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  return null;
}

/**
 * Entry counts of what the process keeps on globalThis under a `__` name: the value itself when it is a Map, Set or
 * array, and one level into a plain object (its Maps, Sets and arrays as `name.field`). Largest first, empty ones left
 * out.
 */
export function globalCounts(root: object = globalThis): Array<[string, number]> {
  const counts: Array<[string, number]> = [];
  for (const name of Object.getOwnPropertyNames(root)) {
    if (!name.startsWith('__')) continue;
    let value: unknown;
    try {
      value = (root as Record<string, unknown>)[name];
    } catch (error) {
      // A getter that throws is not a cache: said once per name, then skipped.
      if (!watch.unreadable.has(name)) {
        watch.unreadable.add(name);
        console.warn(`[memory] globalThis.${name} could not be read:`, error);
      }
      continue;
    }
    const direct = countOf(value);
    if (direct !== null) {
      if (direct > 0) counts.push([name, direct]);
      continue;
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      for (const field of Object.keys(value)) {
        const inner = countOf((value as Record<string, unknown>)[field]);
        if (inner !== null && inner > 0) counts.push([`${name}.${field}`, inner]);
      }
    }
  }
  return counts.sort((a, b) => b[1] - a[1]);
}

/** Open handles by kind (timers, sockets, ...), largest first. */
function handleCounts(): string {
  const byKind = new Map<string, number>();
  for (const kind of process.getActiveResourcesInfo()) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  return [...byKind].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'none';
}

/** The line, and the live floor starts over for the next one. */
export function memoryLine(): string {
  const usage = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const spaces = new Map(v8.getHeapSpaceStatistics().map((s) => [s.space_name, s.space_used_size]));
  const space = (name: string): string => mb(spaces.get(name) ?? 0);
  const floor = watch.fullGcs > 0 ? `live floor ${mb(watch.floor)} MB after ${watch.fullGcs} full GCs` : 'no full GC';
  watch.floor = Infinity;
  watch.fullGcs = 0;
  const caches = globalCounts().slice(0, MAX_CACHES).map(([name, n]) => `${name} ${n}`).join(', ') || 'none';
  const up = (process.uptime() / 3600).toFixed(1);
  return (
    `[memory] up ${up} h · ${floor} · heap ${mb(heap.used_heap_size)} of ${mb(heap.heap_size_limit)} MB` +
    ` (old ${space('old_space')}, large ${space('large_object_space')}, code ${space('code_space')}, new ${space('new_space')})` +
    ` · external ${mb(usage.external)} MB, buffers ${mb(usage.arrayBuffers)} MB · rss ${mb(usage.rss)} MB` +
    ` · handles ${handleCounts()} · caches ${caches}`
  );
}

/** The scheduler's tick: logs the line, and logs (never throws) when it could not be made. */
export function logMemory(): void {
  try {
    console.log(memoryLine());
  } catch (error) {
    console.error('[memory] could not read the memory:', error);
  }
}
