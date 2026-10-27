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
//
// Two doors lead into a module: require() (what the compiled `import x from` is), which Module._load serves, and import()
// (the code under test's `await import('./handlers')`). Node 26 serves import() of a CommonJS file through Module._load too,
// but Node 22 (CI's) compiles the file itself and takes nothing from Module._load, so a stand-in there needs the sync
// module hooks (module.registerHooks, which see import() and not require() with `import` in the conditions): they send an
// import() of a stubbed file to a generated CommonJS module that exports the very same stand-in object, with the real
// module's names listed for the ESM namespace (which Node reads from the source text).

type Stub = object | ((real: Record<string, unknown>) => object);
const stubs = new Map<string, Stub>();
const faked = new Map<string, object>();
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;

function resolvedKey(request: string, parent: unknown, isMain: boolean): string {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch (_error) {
    // A built-in or an unresolvable name is left to the real loader, which reports it.
  }
  return stubs.has(request) ? request : resolved;
}

/** The stand-in for a stubbed key, made once; a partial one is built over the real module, loaded the ordinary way. */
function standIn(key: string, load: () => unknown): object | undefined {
  const stub = stubs.get(key);
  if (!stub) return undefined;
  if (!faked.has(key)) faked.set(key, typeof stub === 'function' ? stub(load() as Record<string, unknown>) : stub);
  return faked.get(key);
}

const STUB_FILE = /^\/dst-stub\/(.+)\.cjs$/;

ModuleInternals._load = function (request, parent, isMain) {
  // Node 26 reloads the generated module below through here, by its made-up file name.
  const generated = STUB_FILE.exec(request);
  if (generated) {
    const stubbed = decodeURIComponent(generated[1]);
    return standIn(stubbed, () => realLoad.call(this, stubbed, undefined, false));
  }
  const key = resolvedKey(request, parent, isMain);
  const loadReal = () => realLoad.call(this, request, parent, isMain);
  return standIn(key, loadReal) ?? loadReal();
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(['default', 'delete', 'new', 'class', 'function', 'var', 'let', 'const', 'import', 'export', 'return', 'switch', 'typeof', 'void', 'with', 'yield', 'await', 'enum', 'null', 'true', 'false', 'this', 'super', 'in', 'of', 'if', 'else', 'for', 'while', 'do', 'try', 'catch', 'finally', 'throw', 'break', 'continue', 'case', 'debugger', 'extends', 'instanceof']);

type ResolveHook = (specifier: string, context: { conditions?: string[] }, next: (specifier: string, context: unknown) => { url: string }) => { url: string; shortCircuit?: boolean };
type LoadHook = (url: string, context: unknown, next: (url: string, context: unknown) => unknown) => unknown;
const registerHooks = (Module as unknown as { registerHooks?: (hooks: { resolve: ResolveHook; load: LoadHook }) => unknown }).registerHooks;
// Without the hooks a stand-in would silently miss every module the code loads with import(), so the smoke would test the real one.
if (!registerHooks) throw new Error(`dst-harness needs module.registerHooks (Node 22.15 or later); this is Node ${process.version}`);
const STUB_URL = 'file:///dst-stub/';
(globalThis as unknown as { __dstStub: (key: string) => object | undefined }).__dstStub = (key: string) => standIn(key, () => realLoad.call(Module, key, undefined, false));

if (registerHooks) {
  registerHooks({
    resolve: (specifier, context, next) => {
      const resolved = next(specifier, context);
      if (!context.conditions?.includes('import')) return resolved; // require() goes through Module._load
      const file = resolved.url.startsWith('file:') ? decodeURIComponent(new URL(resolved.url).pathname) : '';
      const key = stubs.has(specifier) ? specifier : file;
      if (!stubs.has(key)) return resolved;
      return { ...resolved, url: `${STUB_URL}${encodeURIComponent(key)}.cjs`, shortCircuit: true };
    },
    load: (url, context, next) => {
      if (!url.startsWith(STUB_URL)) return next(url, context);
      const key = decodeURIComponent(url.slice(STUB_URL.length, -'.cjs'.length));
      const stand = (globalThis as unknown as { __dstStub: (key: string) => object }).__dstStub(key);
      const names = Reflect.ownKeys(stand).filter((n): n is string => typeof n === 'string' && IDENTIFIER.test(n) && !RESERVED.has(n));
      const source = `module.exports = globalThis.__dstStub(${JSON.stringify(key)});\n0 && (module.exports = { ${names.join(', ')} });\n`;
      return { format: 'commonjs', source, shortCircuit: true };
    },
  });
}

/** Replaces modules, by package name or absolute file path; a function fakes part of the real module. Call before importing the code under test. */
export function stubModules(map: Record<string, Stub>): void {
  for (const [key, stub] of Object.entries(map)) {
    stubs.set(key, stub);
    faked.delete(key);
  }
}

/**
 * Part of a module faked, the rest read through to the real one. A proxy, not a copy: it reads the real module lazily, so it
 * survives import cycles. A name the real module lacks is listed too, so an import() sees it.
 */
export const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>): object =>
  new Proxy(real, {
    get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)),
    ownKeys: target => [...new Set([...Reflect.ownKeys(target), ...Object.keys(fakes)])],
    getOwnPropertyDescriptor: (target, key) =>
      Reflect.getOwnPropertyDescriptor(target, key) ??
      (typeof key === 'string' && key in fakes ? { value: fakes[key], writable: true, enumerable: true, configurable: true } : undefined),
  });

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
