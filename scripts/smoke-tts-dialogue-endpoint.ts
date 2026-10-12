// Auth and request validation of tts-service/api/dialogue.ts, in-process. No network:
// every case here is refused before any TTS call. The success path runs live in
// scripts/eval-voice-show.ts.
//
// Run: npx tsx scripts/smoke-tts-dialogue-endpoint.ts

type Captured = { status?: number; json?: { error?: string }; headers: Record<string, string> };

function fakeRes() {
  const out: Captured = { headers: {} };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(value: { error?: string }) { out.json = value; return res; },
    send() { return res; },
    setHeader(name: string, value: string) { out.headers[name] = value; return res; },
  };
  return { res, out };
}

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
  const { default: handler } = await import('../tts-service/api/dialogue');

  async function call(req: { method: string; headers?: Record<string, string>; body?: unknown }): Promise<Captured> {
    const { res, out } = fakeRes();
    await handler({ headers: {}, ...req } as never, res as never);
    return out;
  }

  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const auth = { authorization: 'Bearer test-key' };
  const voices = { A: 'voice_33yuo333h4y2', B: 'voice_zrrafp34tgt8' };
  const line = { host: 'A', text: 'שלום', style: 'excited sports commentator' };
  const post = (body: unknown) => call({ method: 'POST', headers: auth, body });
  const expect400 = async (body: unknown, pattern: RegExp) => {
    const out = await post(body);
    assert(out.status === 400, `status ${out.status}`);
    assert(pattern.test(out.json?.error ?? ''), `error "${out.json?.error}"`);
  };

  delete process.env.TTS_API_KEY;
  await check('401 when the service has no TTS_API_KEY', async () => {
    assert((await post({ voices, lines: [line] })).status === 401, 'not 401');
  });

  process.env.TTS_API_KEY = 'test-key';
  await check('405 for GET', async () => {
    assert((await call({ method: 'GET', headers: auth })).status === 405, 'not 405');
  });
  await check('401 for a wrong key', async () => {
    assert((await call({ method: 'POST', headers: { authorization: 'Bearer nope' }, body: { voices, lines: [line] } })).status === 401, 'not 401');
  });
  await check('400 without voices or with a bad voice id', async () => {
    await expect400({ lines: [line] }, /voices/);
    await expect400({ voices: { A: 'voice_ok1234', B: 'voice bad!' }, lines: [line] }, /voices/);
  });
  await check('400 for no lines and for 31 lines', async () => {
    await expect400({ voices, lines: [] }, /lines/);
    await expect400({ voices, lines: Array.from({ length: 31 }, () => line) }, /lines/);
  });
  await check('400 for a bad host, empty or overlong text, overlong style', async () => {
    await expect400({ voices, lines: [{ ...line, host: 'C' }] }, /line 1: host/);
    await expect400({ voices, lines: [line, { ...line, text: '  ' }] }, /line 2: text/);
    await expect400({ voices, lines: [{ ...line, text: 'א'.repeat(1001) }] }, /line 1: text/);
    await expect400({ voices, lines: [{ ...line, style: 's'.repeat(301) }] }, /line 1: style/);
  });

  await check('504 when the show runs out of time, with no further Gemini call', async () => {
    // Gemini is faked: each call times out and moves the clock on 49 s, so after one
    // call the service's own deadline (about 50 s) leaves no room for a retry.
    const realNow = Date.now;
    const realFetch = globalThis.fetch;
    let offset = 0;
    let calls = 0;
    Date.now = () => realNow() + offset;
    globalThis.fetch = (async () => {
      calls++;
      offset += 49_000;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as typeof fetch;
    try {
      const out = await post({ voices, lines: [line, { ...line, host: 'B' }] });
      assert(out.status === 504, `status ${out.status} ${JSON.stringify(out.json)}`);
      assert(calls <= 2, `Gemini calls ${calls}`);
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
