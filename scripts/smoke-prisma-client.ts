// Smoke test for the database client as the app builds it (src/utils/prisma.ts) and the one retry for a database that
// could not be reached (src/utils/db-retry.ts). It runs the real generated client against the fake DATABASE_URL, a refused
// port on 127.0.0.1, so the CI proves on its own Node that the client loads and fails the way withRetry reads.
// No database and no network beyond 127.0.0.1.
//   bash scripts/ci-smokes.sh   (or one smoke: env <the FAKES list of scripts/ci-smokes.sh> TZ=Asia/Jerusalem npx tsx scripts/smoke-prisma-client.ts)

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
  const warn = console.warn; // withRetry's own "retrying" line is not this smoke's output
  console.warn = () => {};
  try {
    await withRetry(() => { calls++; return fn(); }, 2, 1);
  } catch (e) { thrown = e; }
  finally { console.warn = warn; }
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

  // The app's singleton logs its failed queries (NODE_ENV=development); those two checks fail on purpose, so their log lines are held back.
  const loud = { log: console.log, warn: console.warn, error: console.error };
  const hush = () => { console.log = console.warn = console.error = () => {}; };
  const unhush = () => Object.assign(console, loud);
  hush();

  await check(`the real client loads on Node ${process.version}: a query on a refused port fails as Prisma's "can't reach" (P1001)`, async () => {
    let thrown: unknown = null;
    try { await prisma.user.findFirst({ select: { id: true } }); } catch (e) { thrown = e; }
    assert(isP1001(thrown), `thrown ${kindOf(thrown)}`);
  });

  await check('withRetry retries a query that could not reach the database: 3 calls, then the P1001 reaches the caller', async () => {
    const { calls, thrown } = await callsOf(() => prisma.user.findFirst({ select: { id: true } }));
    assert(calls === 3 && isP1001(thrown), `calls ${show(calls)}, thrown ${kindOf(thrown)}`);
  });

  unhush();

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
      const client = factory.createPrismaClient(server.url, []);
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


  // ---- withRetry on Prisma 7's errors (prisma7-trial.md §5.1, "with patch" column) ----
  const { Prisma } = await import('@prisma/client');
  const known = (message: string, code: string, kind?: string) =>
    new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'smoke', ...(kind ? { meta: { driverAdapterError: { cause: { kind } } } } : {}) });
  const refused = factory.createPrismaClient('postgresql://fake:fake@127.0.0.1:1/fake', []);
  const reachKind = (e: unknown) => (e as { meta?: { driverAdapterError?: { cause?: { kind?: unknown } } } }).meta?.driverAdapterError?.cause?.kind;

  await check('refused port, model query: P1001 (DatabaseNotReachable), retried: 3 calls', async () => {
    const { calls, thrown } = await callsOf(() => refused.user.findFirst({ select: { id: true } }));
    assert(thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === 'P1001' && reachKind(thrown) === 'DatabaseNotReachable', `thrown ${kindOf(thrown)}`);
    assert(calls === 3, `calls ${calls}`);
  });

  await check('refused port, raw query: P2010 with DatabaseNotReachable, retried: 3 calls', async () => {
    const { calls, thrown } = await callsOf(() => refused.$queryRaw`SELECT 1`);
    assert(thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === 'P2010' && reachKind(thrown) === 'DatabaseNotReachable', `thrown ${kindOf(thrown)}`);
    assert(calls === 3, `calls ${calls}`);
  });

  await check('refused port, transaction start: P1001, retried: 3 calls', async () => {
    const { calls, thrown } = await callsOf(() => refused.$transaction(async tx => tx.user.count()));
    assert(thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === 'P1001', `thrown ${kindOf(thrown)}`);
    assert(calls === 3, `calls ${calls}`);
  });

  await check('a server that accepts and never answers: the transaction cannot start in 2 s (P2028 "Unable to start a transaction"), retried: 3 calls', async () => {
    const held: import('node:net').Socket[] = [];
    const server = net.createServer(socket => { held.push(socket); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as { port: number };
    const silent = factory.createPrismaClient(`postgresql://fake:fake@127.0.0.1:${port}/fake`, []);
    const { calls, thrown } = await callsOf(() => silent.$transaction(async tx => tx.user.count()));
    assert(thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === 'P2028' && /Unable to start a transaction/.test(thrown.message), `thrown ${kindOf(thrown)}`);
    assert(calls === 3, `calls ${calls}`);
    server.unref(); // its pending connects never settle; never $disconnect this client (it would wait for them)
  });

  await check('localhost, refused on every address it resolves to: retried in the shape that is really seen (P1001, or a KnownRequestError carrying Node\'s ECONNREFUSED)', async () => {
    const local = factory.createPrismaClient('postgresql://fake:fake@localhost:1/fake', []);
    const { calls, thrown } = await callsOf(() => local.user.findFirst({ select: { id: true } }));
    assert(calls === 3, `calls ${calls}, thrown ${kindOf(thrown)}`);
  });

  await check('Prisma\'s wrapped Node codes: ECONNREFUSED and ETIMEDOUT (only a connect gives them) are retried, 3 calls; EHOSTUNREACH and ENETUNREACH (a statement already sent can give them) are not, 1 call', async () => {
    const wrapped = { ECONNREFUSED: 3, ETIMEDOUT: 3, EHOSTUNREACH: 1, ENETUNREACH: 1 };
    const ran: Record<string, number> = {};
    for (const code of Object.keys(wrapped)) ran[code] = (await callsOf(async () => { throw known(`connect ${code} 127.0.0.1:1`, code); })).calls;
    assert(show(ran) === show(wrapped), `calls ${show(ran)}, wanted ${show(wrapped)}`);
  });

  await check('a bare connect AggregateError is retried for each of the four Node codes (a connect only); one with another code is not', async () => {
    const aggregate = (code: string) => Object.assign(new AggregateError([new Error('a'), new Error('b')], 'connect failed'), { code });
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
      const a = await callsOf(async () => { throw aggregate(code); });
      assert(a.calls === 3, `${code} calls ${a.calls}`);
    }
    const b = await callsOf(async () => { throw aggregate('EPROTO'); });
    assert(b.calls === 1, `EPROTO calls ${b.calls}`);
  });

  await check('a server that drops the connection: P1017 ConnectionClosed reaches the caller once (a cut statement may have run)', async () => {
    const server = await droppingServer();
    try {
      const dropped = factory.createPrismaClient(server.url, []);
      const { calls, thrown } = await callsOf(() => dropped.user.findFirst({ select: { id: true } }));
      // Prisma 7.10.1 maps pg's cut connection to P1017 ConnectionClosed; a cut running statement may have run, so it is never retried.
      assert(thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === 'P1017' && reachKind(thrown) === 'ConnectionClosed', `thrown ${kindOf(thrown)}`);
      assert(calls === 1, `calls ${calls}`);
    } finally { server.close(); }
  });

  await check('not retried, 1 call each: a refused password, a raw query error, a closed transaction, a duplicate, a server FATAL, a lost transaction connection, and the Prisma 5 startup error', async () => {
    const cases: [string, unknown][] = [
      ['P1000', known('Authentication failed against the database server', 'P1000', 'AuthenticationFailed')],
      ['P2010 other', known('Raw query failed. Code: `23505`.', 'P2010', 'UniqueConstraintViolation')],
      ['P2010 no kind', known('Raw query failed. Code: `N/A`.', 'P2010')],
      ['P2028 closed', known('Transaction API error: Transaction already closed: A commit cannot be executed on a committed transaction.', 'P2028')],
      ['P2028 expired', known('Transaction API error: A query cannot be executed on an expired transaction.', 'P2028')],
      ['P2002', known('Unique constraint failed on the constraint: `User_telegramId_key`', 'P2002')],
      ['P2039', known('Database error. Code: `57P01`.', 'P2039')],
      ['plain', new Error('Client has encountered a connection error and is not queryable')],
      ['init', new Prisma.PrismaClientInitializationError("Can't reach database server", 'smoke', 'P1001')],
    ];
    const ran: Record<string, number> = {};
    for (const [name, error] of cases) ran[name] = (await callsOf(async () => { throw error; })).calls;
    assert(Object.values(ran).every(n => n === 1), `calls ${show(ran)}`);
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
