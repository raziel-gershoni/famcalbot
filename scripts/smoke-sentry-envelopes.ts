// Smoke test: the server sends Sentry error events and nothing else (the Privacy Policy says error reports;
// src/lib/sentry-errors-only.ts). smoke-sentry-scrub.ts reads the init options; this one runs them. The real
// sentry.server.config.ts runs on the real SDK, with a fake DSN, a release (as on Railway: the SDK's sessions need one)
// and a transport that records every envelope instead of sending it. A loopback server answers three requests; the
// last makes an outgoing request, puts a person on the scope and captures an error, as a route does. Then the SDK
// flushes, the process says it is about to exit (when the process session would end), and it flushes again. Every
// envelope item must be an error event: no transaction, no session, no session aggregate, no client report.
//
// No network beyond 127.0.0.1. Fails on the configs before 2026-10-31 (a process session and a request aggregate).
//
// Run: npx tsx scripts/smoke-sentry-envelopes.ts

import http from 'http';
import path from 'path';
import { createRequire } from 'module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

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

const show = (value: unknown) => JSON.stringify(value);

// ---- the real @sentry/nextjs, its init given a fake DSN, a release and a recording transport ----

/** Every envelope the SDK sent: [headers, [[itemHeader, payload], ...]]. */
const envelopes: Row[][] = [];
const transport = () => ({
  send: async (envelope: Row[]) => {
    envelopes.push(envelope);
    return { statusCode: 200 };
  },
  flush: async () => true,
});
const sentryEntry = nodeRequire.resolve('@sentry/nextjs');
const real = nodeRequire('@sentry/nextjs') as Row;
const Module = nodeRequire('module');
const wrapped = new Proxy(real, {
  get(target, prop) {
    if (prop === 'init') return (options: Row) => real.init({ ...options, dsn: 'https://public@o1.ingest.sentry.io/1', release: 'smoke-release', enabled: true, transport });
    return target[prop as string];
  },
});
const sentryStub = new Module(sentryEntry);
Object.assign(sentryStub, { filename: sentryEntry, loaded: true, exports: wrapped });
Module._cache[sentryEntry] = sentryStub;

async function main() {
  await import(path.join(ROOT, 'sentry.server.config.ts'));
  const client = real.getClient();

  await check('#1 the server config initialised the real SDK through the recording transport', async () => {
    assert(client, 'no Sentry client');
    const names = (client.getOptions().integrations as Row[]).map((i) => i.name);
    assert(names.includes('Http') && !names.includes('ProcessSession'), `integrations ${show(names)}`);
  });

  // Three requests, the last one failing as a route does: an outgoing request, the person on the scope, an error
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/fails')) {
      await fetch(`http://127.0.0.1:${(server.address() as Row).port}/inner`).then((r) => r.text());
      real.setUser({ id: '424242', username: 'someone' });
      real.captureException(new Error('smoke: a route failed'));
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as Row).port;
  const get = (route: string) => new Promise<void>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  await get('/fine?x=1');
  await get('/fine');
  await get('/fails?initData=zzz');
  server.close();
  await real.flush(3000);
  process.emit('beforeExit', 0);
  await real.flush(3000);

  await check('#2 only error events left the SDK, and the error did', async () => {
    const types = envelopes.flatMap((envelope) => (envelope[1] as Row[][]).map((item) => item[0].type as string));
    assert(types.includes('event'), `no error event recorded: ${show(types)}`);
    const others = types.filter((type) => type !== 'event');
    assert(others.length === 0, `envelope items other than error events: ${show(types)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
