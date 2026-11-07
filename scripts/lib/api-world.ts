// The world the Jewish times API smokes run in (smoke-api-keys.ts, smoke-api-v1.ts): signin-world's in-memory Prisma and
// Redis, its error capture and its kept console lines, plus what these smokes count and break:
//   - every Redis command, in order (redisCalls); a command named in redisFails throws; redisBefore runs a probe just before
//     a command does (to see what the code had written by then);
//   - a call of the API key table named in prismaFails ('apiKey.findMany') rejects, as a database that is down does;
//   - the clock the code reads through Date.now(): setClock(ms) fixes it, advanceClock(ms) moves it on, setClock(null) is the
//     real one again;
//   - @hebcal/core resolved to its ESM build, as scripts/lib/site-harness.ts does (tsx compiles the smokes to CommonJS).
// resetApiWorld() is signin-world's resetWorld() plus all of the above, and forgets the process's key copy, the lookup's
// state and the rate counts (their globalThis slots). scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts).

import path from 'path';
import { createRequire } from 'module';
import { fakePrisma, fakeRedis, installSigninWorld, prismaCalls, resetWorld, ROOT, stubModule, type Row } from './signin-world';

const nodeRequire = createRequire(__filename);

export const redisCalls: string[] = [];
export const redisFails = new Set<string>();
export const redisBefore = new Map<string, () => void>();
export const prismaFails = new Set<string>();

const realNow = Date.now.bind(Date);
let fixedMs: number | null = null;
let offsetMs = 0;
Date.now = () => (fixedMs ?? realNow()) + offsetMs;

/** The clock fixed at `ms` (null: the real one), with nothing added. */
export function setClock(ms: number | null): void {
  fixedMs = ms;
  offsetMs = 0;
}

/** The clock moved on by `ms`. */
export function advanceClock(ms: number): void {
  offsetMs += ms;
}

const countingRedis: Row = new Proxy({} as Row, {
  get: (_target, name) => {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return async (...args: unknown[]) => {
      redisCalls.push(name);
      redisBefore.get(name)?.();
      if (redisFails.has(name)) throw new Error(`the smoke's Redis refused ${name}`);
      return fakeRedis[name](...args);
    };
  },
});

const keyTable: Row = new Proxy({} as Row, {
  get: (_target, method) => {
    if (typeof method !== 'string' || method === 'then') return undefined;
    return (...args: unknown[]) => {
      if (prismaFails.has(`apiKey.${method}`)) {
        prismaCalls.push(`apiKey.${method}`);
        return Promise.reject(new Error(`the smoke's database refused apiKey.${method}`));
      }
      return fakePrisma.apiKey[method](...args);
    };
  },
});
const breakablePrisma: Row = new Proxy({} as Row, {
  get: (_target, name) => (name === 'apiKey' ? keyTable : fakePrisma[name as string]),
});

let installed = false;

/** signin-world, then the counted Redis and the breakable table in its place. Call before loading the code under test. */
export async function installApiWorld(): Promise<void> {
  if (installed) return;
  installed = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Module: any = nodeRequire('module');
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };
  await installSigninWorld();
  stubModule('src/utils/redis.ts', { redis: countingRedis });
  stubModule('src/utils/prisma.ts', { prisma: breakablePrisma, withRetry: (fn: () => unknown) => fn() });
}

/** A fresh process: empty tables and Redis, nothing counted or broken, the real clock, no key copy and no rate counts. */
export function resetApiWorld(): void {
  resetWorld();
  redisCalls.length = 0;
  redisFails.clear();
  redisBefore.clear();
  prismaFails.clear();
  setClock(null);
  const shared = globalThis as Row;
  delete shared.__apiKeys;
  delete shared.__apiKeysLookup;
  const rate = shared.__apiV1Rate as Row | undefined;
  if (rate?.timer) clearTimeout(rate.timer);
  delete shared.__apiV1Rate;
}
