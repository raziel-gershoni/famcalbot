// saveMonthMode (src/lib/calendar-view/month-mode-client.ts): the body and header it sends, false on a refusal or a
// thrown fetch, and a log line that holds no user id. Fake fetch; no network.
//
// Run with the fake env runner: scripts/run-smoke.sh scripts/smoke-month-mode-client.ts <TZ>

import { saveMonthMode } from '../src/lib/calendar-view/month-mode-client';
import { INIT_DATA_HEADER } from '../src/lib/read-init-data';

const g = globalThis as unknown as Record<string, unknown>;
const logs: string[] = [];
console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
const out = (line: string) => process.stdout.write(line + '\n');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  out(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
  if (!ok) failures++;
}

async function main() {
  const calls: { url: string; init: RequestInit }[] = [];
  let next: () => Promise<unknown> = async () => ({ status: 200 });
  g.fetch = async (url: string, init: RequestInit) => { calls.push({ url, init }); return next(); };
  g.window = { Telegram: { WebApp: { initData: 'query_id=abc&hash=h' } } };

  const ok = await saveMonthMode(4242, 'hebrew');
  const c = calls[0];
  const body = JSON.parse(String(c?.init.body ?? '{}'));
  const headers = (c?.init.headers ?? {}) as Record<string, string>;
  check('a 200 is true', ok === true);
  check('POST to /api/settings?user_id=4242', c?.url === '/api/settings?user_id=4242' && c?.init.method === 'POST', c?.url);
  check('the body holds user_id and monthMode', body.user_id === 4242 && body.monthMode === 'hebrew', JSON.stringify(body));
  check('the init data goes in the body and the header', body.initData === 'query_id=abc&hash=h' && headers[INIT_DATA_HEADER] === 'query_id=abc&hash=h', JSON.stringify(headers));

  logs.length = 0;
  next = async () => ({ status: 429 });
  check('a 429 is false', (await saveMonthMode(4242, 'gregorian')) === false);
  check('and logs the status without the user id', logs.length === 1 && logs[0] === '[month mode] save failed: 429', JSON.stringify(logs));

  logs.length = 0;
  next = async () => { throw new TypeError('network down for 4242'); };
  check('a thrown fetch is false', (await saveMonthMode(4242, 'hebrew')) === false);
  check('and logs the error kind only', logs.length === 1 && logs[0] === '[month mode] save failed: TypeError', JSON.stringify(logs));

  out(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { out(String(e)); process.exit(1); });
