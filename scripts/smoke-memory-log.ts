// Smoke test for the memory line (src/services/memory-log.ts), the scheduler's 15-minute log of what the process holds
// (added after two "JavaScript heap out of memory" crashes in November 2026).
//
//   #1 globalCounts: Maps, Sets and arrays on `__` names, one level into plain objects, largest first, empty and
//      non-`__` names left out
//   #2 the line: counts and code names only; a cache's keys and values never appear
//   #3 the live floor: a full GC is noted, and the next line starts over ("no full GC")
//   #4 logMemory never throws: a failure is logged as "[memory] could not read the memory"
//   #5 package.json "start" keeps the 256 MB heap cap and Node 22's 16 MB semi-spaces (Node 24's 64 MB ones made every
//      collection a full one past about 130 MB kept)
//
// No network, no DB. Run: npx tsx scripts/smoke-memory-log.ts

import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import vm from 'vm';
import { globalCounts, installMemoryWatch, logMemory, memoryLine } from '../src/services/memory-log';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('#1 globalCounts');
  const root = {
    __a: new Map([[1, 1], [2, 2], [3, 3]]),
    __empty: new Set(),
    __obj: { x: new Map([['k', 1], ['j', 2]]), y: 5, z: [] as number[] },
    __list: [1, 2],
    plain: new Map([[1, 1], [2, 2], [3, 3], [4, 4]]),
    __number: 7,
  };
  const counts = globalCounts(root);
  check('Maps, arrays and one level into objects, largest first', JSON.stringify(counts) === JSON.stringify([['__a', 3], ['__obj.x', 2], ['__list', 2]]), JSON.stringify(counts));

  console.log('#2 the line holds counts, never keys or values');
  const g = globalThis as { __smokeMemoryCache?: Map<string, { name: string }> };
  g.__smokeMemoryCache = new Map([['secret-key-4711', { name: 'Shira Lea' }]]);
  installMemoryWatch();
  installMemoryWatch(); // twice is safe
  const line = memoryLine();
  check('starts with [memory] up', line.startsWith('[memory] up '), line.slice(0, 40));
  check('names the cache with its count', line.includes('__smokeMemoryCache 1'));
  check('no key', !line.includes('secret-key-4711'));
  check('no value', !line.includes('Shira'));
  check('heap, spaces, native memory and handles', ['heap ', ' of ', '(old ', 'large ', 'external ', 'buffers ', 'rss ', 'handles '].every((part) => line.includes(part)), line);
  delete g.__smokeMemoryCache;

  console.log('#3 the live floor');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  await new Promise((resolve) => setTimeout(resolve, 50)); // the GC observer's entries arrive asynchronously
  const afterGc = memoryLine();
  check('a full GC gives a live floor', /live floor \d+\.\d MB after \d+ full GCs/.test(afterGc), afterGc.slice(0, 120));
  const next = memoryLine();
  check('the next line starts over', next.includes('no full GC'), next.slice(0, 120));

  console.log('#4 logMemory never throws');
  const realUsage = process.memoryUsage;
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  (process as { memoryUsage: unknown }).memoryUsage = () => { throw new Error('boom'); };
  let threw = false;
  try {
    logMemory();
  } catch {
    threw = true;
  } finally {
    (process as { memoryUsage: unknown }).memoryUsage = realUsage;
    console.error = realError;
  }
  check('no throw', !threw);
  check('the failure is logged', errors.some((e) => e.startsWith('[memory] could not read the memory')), JSON.stringify(errors));

  console.log('#5 the start command sizes the young generation');
  // Node 24 gives a 256 MB old space a 192 MB young generation (64 MB semi-spaces; Node 22 gave 48 MB). Past about 130 MB
  // kept, every collection is then a full one, about 20 a second: 4.35 vCPU in production from 2026-11-20 until this flag.
  const start = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: { start: string } }).scripts.start;
  check('the heap cap', /--max-old-space-size=256\b/.test(start), start);
  check('16 MB semi-spaces (Node 22\'s size)', /--max-semi-space-size=16\b/.test(start), start);

  if (failures > 0) {
    console.error(`\nsmoke-memory-log: ${failures} failed`);
    process.exit(1);
  }
  console.log('\nsmoke-memory-log: all passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
