// Smoke test for the database client as the app builds it (src/utils/prisma.ts) and the one retry for a database that
// could not be reached (src/utils/db-retry.ts). It runs the real generated client against the fake DATABASE_URL, a refused
// port on 127.0.0.1, so the CI proves on its own Node that the client loads and fails the way withRetry reads.
// No database and no network beyond 127.0.0.1.
//   bash scripts/ci-smokes.sh   (or one smoke with its fake env, see the plan or CLAUDE.md)

import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const results: { name: string; ok: boolean; reason?: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

/** An error by its kind only (class, code, Prisma 5's errorCode, the adapter's cause kind): never the message, which names the host. */
function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const e = error as { code?: unknown; errorCode?: unknown; meta?: { driverAdapterError?: { cause?: { kind?: unknown } } } };
  return [error.constructor?.name ?? error.name, e.code, e.errorCode, e.meta?.driverAdapterError?.cause?.kind]
    .filter(v => typeof v === 'string').join(' ');
}

/** Calls `fn` through the real withRetry (no wait between attempts) and returns how many times it ran and what was thrown. */
async function callsOf(fn: () => Promise<unknown>): Promise<{ calls: number; thrown: unknown }> {
  const { withRetry } = await import('../src/utils/db-retry');
  let calls = 0;
  let thrown: unknown = null;
  try {
    await withRetry(() => { calls++; return fn(); }, 2, 1);
  } catch (e) { thrown = e; }
  return { calls, thrown };
}

// A check that never settles would let Node drain its event loop and exit 0 in silence: that must read as a failure.
let reported = false;
process.on('exit', () => {
  if (!reported) {
    console.error('FAIL  the smoke ended before its checks did (a promise that never settled)');
    process.exitCode = 1;
  }
});

async function main() {
  // The real client queries whatever DATABASE_URL names: refuse anything but the fake refused port.
  if (process.env.DATABASE_URL !== 'postgresql://fake:fake@127.0.0.1:1/fake') {
    console.error('refusing to run: DATABASE_URL is not the fake refused port of scripts/ci-smokes.sh');
    process.exit(1);
  }
  const { prisma } = await import('../src/utils/prisma');
  // Prisma 7: PrismaClientKnownRequestError P1001. Prisma 5.22: PrismaClientInitializationError, errorCode P1001 on $connect
  // (node24-trial.md §5); a query's implicit connect is read by its words too, in case it carries no errorCode.
  const isP1001 = (e: unknown) => /\bP1001\b/.test(kindOf(e))
    || (e instanceof Error && e.constructor?.name === 'PrismaClientInitializationError' && /Can't reach database server/.test(e.message));

  await check(`the real client loads on Node ${process.version}: a query on a refused port fails as Prisma's "can't reach" (P1001)`, async () => {
    let thrown: unknown = null;
    try { await prisma.user.findFirst({ select: { id: true } }); } catch (e) { thrown = e; }
    assert(isP1001(thrown), `thrown ${kindOf(thrown)}`);
  });

  await check('withRetry retries a query that could not reach the database: 3 calls, then the P1001 reaches the caller', async () => {
    const { calls, thrown } = await callsOf(() => prisma.user.findFirst({ select: { id: true } }));
    assert(calls === 3 && isP1001(thrown), `calls ${show(calls)}, thrown ${kindOf(thrown)}`);
  });

  reported = true;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (root ${ROOT})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(kindOf(err));
  process.exit(1);
});
