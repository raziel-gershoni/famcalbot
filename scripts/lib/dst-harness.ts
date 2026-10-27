// The pieces scripts/smoke-dst.ts is made of: its checks, a clock a check can set, module
// stand-ins, recording stand-ins for Prisma and Redis, and an independent reader of a zone's
// clock (so the expected values never come from the code under test). scripts/lib/ is not a
// smoke (ci-smokes.sh runs scripts/smoke-*.ts only).

import Module from 'node:module';

// ---- Checks ----

export type Result = { name: string; ok: boolean; reason?: string };
export const results: Result[] = [];

export async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export const show = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

export function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- The clock: argument-less new Date() and Date.now() read it while it is set ----

let clockMs: number | null = null;
export const RealDate = Date;

class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clockMs ?? RealDate.now());
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now(): number {
    return clockMs ?? RealDate.now();
  }
  // A Date made before the clock was installed is still a Date.
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof RealDate;
  }
}

/** Replaces the global Date with one that reads setClock's value; the real time again after setClock(null). */
export function installClock(): void {
  globalThis.Date = ClockDate as unknown as DateConstructor;
}

export function setClock(at: string | number | Date | null): void {
  clockMs = at === null ? null : new RealDate(at).getTime();
}

// ---- Module stand-ins ----

type Stub = object | ((real: Record<string, unknown>) => object);
const stubs = new Map<string, Stub>();
const faked = new Map<string, object>();
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch (_error) {
    // A built-in or an unresolvable name is left to the real loader, which reports it.
  }
  const key = stubs.has(request) ? request : resolved;
  const stub = stubs.get(key);
  if (!stub) return realLoad.call(this, request, parent, isMain);
  if (typeof stub !== 'function') return stub;
  if (!faked.has(key)) faked.set(key, stub(realLoad.call(this, request, parent, isMain) as Record<string, unknown>));
  return faked.get(key);
};

/** Replaces modules, by package name or absolute file path; a function fakes part of the real module. Call before importing the code under test. */
export function stubModules(map: Record<string, Stub>): void {
  for (const [key, stub] of Object.entries(map)) {
    stubs.set(key, stub);
    faked.delete(key);
  }
}

/** Part of a module faked, the rest read through to the real one. */
export const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>): object =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

// ---- Recording stand-ins ----

export type Call = { path: string; args: unknown[] };

/**
 * An object whose every method, at any depth, records its call and answers `answer(path)`:
 * prisma.user.findMany(...) is recorded as path 'user.findMany'. The default answer is
 * [] for findMany, 0 for count, null for anything else.
 */
export function recorder(calls: Call[], answer: (path: string) => unknown = defaultAnswer): object {
  const at = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_t, key) => (typeof key === 'string' && key !== 'then' ? at(path ? `${path}.${key}` : key) : undefined),
      apply: async (_t, _self, args) => {
        calls.push({ path, args });
        return answer(path);
      },
    });
  return at('') as object;
}

function defaultAnswer(path: string): unknown {
  const method = path.split('.').pop();
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  return null;
}

/** Every Date found in a recorded argument, depth first. */
export function datesIn(value: unknown): Date[] {
  if (value instanceof RealDate) return [value];
  if (Array.isArray(value)) return value.flatMap(datesIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(datesIn);
  return [];
}

// ---- An independent reader of a zone's clock ----

const readers = new Map<string, Intl.DateTimeFormat>();

/** The zone's clock at `ms`, as a UTC-field timestamp (the local reading carried in UTC). Written apart from the code under test. */
export function localReading(ms: number, zone: string): number {
  let fmt = readers.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    readers.set(zone, fmt);
  }
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return RealDate.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

/** 'yyyy-MM-dd HH:mm' on the zone's clock at `instant` (a Date or an ISO string). */
export function wallOf(instant: Date | string, zone: string): string {
  return new RealDate(localReading(new RealDate(instant).getTime(), zone)).toISOString().slice(0, 16).replace('T', ' ');
}

/** The instant for an ISO string with a Z. */
export const iso = (value: string): Date => new RealDate(value);

/**
 * What wallTimeToInstant must give, found by scanning instead of by the algorithm: the first
 * quarter hour whose reading in `zone` is `wall` (read as UTC fields), else, for a time the clocks skip,
 * the wall time plus the jump. Offsets and jumps here are whole quarter hours.
 */
export function scannedInstant(wall: string, zone: string): number {
  const QUARTER = 15 * 60_000;
  const target = RealDate.parse(`${wall}:00Z`);
  const from = target - 26 * 3_600_000;
  for (let t = from; t <= target + 26 * 3_600_000; t += QUARTER) {
    if (localReading(t, zone) === target) return t;
  }
  for (let t = from + QUARTER; t <= target + 26 * 3_600_000; t += QUARTER) {
    const before = localReading(t - QUARTER, zone) - (t - QUARTER);
    const after = localReading(t, zone) - t;
    // The first jump forward that steps over the wall time.
    if (after > before && localReading(t - QUARTER, zone) < target && localReading(t, zone) > target) return target - before;
  }
  throw new Error(`no instant or jump found for ${wall} in ${zone}`);
}
