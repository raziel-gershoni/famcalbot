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

  // ---- Prisma 7: one factory, its pool, nothing connects before a query ----
  const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');
  const net = await import('node:net');
  const factory = await import('../src/utils/prisma-client');

  /** A TCP server on 127.0.0.1 that counts connections and closes each one at once. */
  async function droppingServer(): Promise<{ url: string; connections: () => number; close: () => void }> {
    let n = 0;
    const server = net.createServer(socket => { n++; socket.destroy(); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as { port: number };
    return { url: `postgresql://fake:fake@127.0.0.1:${port}/fake`, connections: () => n, close: () => server.close() };
  }

  function filesUnder(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs).flatMap(name => {
      const rel = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) return [];
      return statSync(path.join(ROOT, rel)).isDirectory() ? filesUnder(rel) : /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [rel] : [];
    });
  }
  const SOURCES = [...['src', 'app', 'components', 'prisma', 'scripts'].flatMap(filesUnder), 'instrumentation.ts', 'prisma.config.ts']
    .filter(f => f !== 'scripts/smoke-prisma-client.ts' && existsSync(path.join(ROOT, f)));

  await check('every database client is built by createPrismaClient (src/utils/prisma-client.ts), the app\'s and the seed\'s', async () => {
    const builds = new RegExp(['new Prisma', 'Client\\(|new Prisma', 'Pg\\('].join(''));
    const where = SOURCES.filter(f => builds.test(readFileSync(path.join(ROOT, f), 'utf8')));
    assert(show(where) === show(['src/utils/prisma-client.ts']), `built in ${show(where)}`);
    for (const f of ['src/utils/prisma.ts', 'prisma/seed.ts']) {
      assert(/createPrismaClient\(/.test(readFileSync(path.join(ROOT, f), 'utf8')), `${f} does not call createPrismaClient`);
    }
  });

  await check('the pool: at most 5 connections, idle ones close after 60 s, and no connect timeout of our own', async () => {
    assert(show(factory.PRISMA_POOL) === show({ max: 5, idleTimeoutMillis: 60_000 }), `PRISMA_POOL ${show(factory.PRISMA_POOL)}`);
    assert(!('connectionTimeoutMillis' in factory.PRISMA_POOL), 'a connect timeout was set');
  });

  await check('building a client opens no connection; its first query does', async () => {
    const server = await droppingServer();
    try {
      const client = factory.createPrismaClient(server.url, ['error']);
      await new Promise(r => setTimeout(r, 300));
      assert(server.connections() === 0, `${server.connections()} connections before any query`);
      let thrown: unknown = null;
      try { await client.user.findFirst({ select: { id: true } }); } catch (e) { thrown = e; }
      assert(server.connections() >= 1, 'the query never connected');
      assert(thrown !== null, 'a server that drops the connection answered a query');
    } finally { server.close(); }
  });

  await check('a pool failure is reported by its kind only: a warning for an idle connection, an error inside a transaction, never the message', async () => {
    const lines: { level: string; text: string }[] = [];
    const kept = { warn: console.warn, error: console.error };
    console.warn = (...a: unknown[]) => { lines.push({ level: 'warn', text: a.map(String).join(' ') }); };
    console.error = (...a: unknown[]) => { lines.push({ level: 'error', text: a.map(String).join(' ') }); };
    try {
      const secret = Object.assign(new Error('connect to postgresql://u:hunter2@db.example.test:5432/x failed'), { code: '57P01' });
      assert(factory.poolErrorKind(secret) === 'Error 57P01', `kind ${factory.poolErrorKind(secret)}`);
      factory.reportPoolError('idle', secret);
      factory.reportPoolError('transaction', secret);
    } finally { Object.assign(console, kept); }
    assert(lines.length === 2, `lines ${show(lines)}`);
    assert(lines[0].level === 'warn' && /\[prisma-pool\]/.test(lines[0].text) && /idle connection failed: Error 57P01/.test(lines[0].text), `idle ${show(lines[0])}`);
    assert(lines[1].level === 'error' && /transaction connection failed: Error 57P01/.test(lines[1].text), `transaction ${show(lines[1])}`);
    assert(!lines.some(l => /hunter2|db\.example|postgresql:/.test(l.text)), `a line holds the message: ${show(lines)}`);
  });

  await check('the generated client uses the small query compiler (owner decision 1)', async () => {
    assert(/^\s*compilerBuild\s*=\s*"small"/m.test(readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8')), 'schema.prisma has no compilerBuild = "small"');
    assert(existsSync(path.join(ROOT, 'node_modules/.prisma/client/query_compiler_small_bg.wasm-base64.js')), 'run prisma generate: no small compiler in node_modules/.prisma/client');
  });

  // Every raw query, and how each of its parameters gets a type: the adapter sends parameters untyped, so a bare ${x}
  // fails (42P18) or comes back as text (prisma7-trial.md §3 a5). A new raw query is added here with its reason.
  const RAW_SQL: Record<string, { count: number; why: string }> = {
    'src/cron/handlers.ts': { count: 1, why: 'SELECT 1: no parameter' },
    'src/services/web-signin/identities.ts': { count: 1, why: 'id = ${userId}: compared with the id column' },
    'src/services/google-sync/marks.ts': { count: 1, why: 'INSERT … VALUES: each parameter takes its column\'s type' },
    'src/services/native-reminders/claim.ts': { count: 1, why: 'every parameter cast: ::timestamptz, ::integer, ::text, or a column\'s' },
  };
  await check('every raw query is listed with how its parameters get a type, and none is Unsafe', async () => {
    const found: Record<string, number> = {};
    for (const f of SOURCES.filter(s => /^(src|app|components)\//.test(s) || s === 'instrumentation.ts')) {
      const text = readFileSync(path.join(ROOT, f), 'utf8');
      const n = (text.match(/\$(queryRaw|executeRaw)\b/g) ?? []).length;
      if (n) found[f] = n;
      assert(!/\$(queryRaw|executeRaw)Unsafe\b/.test(text), `${f} uses an Unsafe raw query`);
    }
    const listed = Object.fromEntries(Object.entries(RAW_SQL).map(([f, v]) => [f, v.count]));
    const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    assert(show(sorted(found)) === show(sorted(listed)), `found ${show(sorted(found))}, listed ${show(sorted(listed))}`);
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
