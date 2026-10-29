// Smoke test: GET /api/refresh-token (Google's redirect target after consent) forwards to
// /oauth-callback on the app's public URL. On Railway, request.url is Next's own listen
// address (http://localhost:8080/...), so a redirect built from it sent phones to localhost.
// A return with no code (Google's deny) goes to the callback's card too, never a JSON answer.
//
// Run: npx tsx -r dotenv/config scripts/smoke-oauth-return-url.ts

import { NextRequest } from 'next/server';
import { GET } from '../app/api/refresh-token/route';

async function main() {
  const results: { name: string; ok: boolean; reason?: string }[] = [];
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';

  const back = await GET(new NextRequest('http://localhost:8080/api/refresh-token?code=4/0AbC-dEf_9&state=st4te'));
  const location = back.headers.get('location') ?? '';
  results.push({ name: 'consent return -> redirect', ok: back.status === 307, reason: `status ${back.status}` });
  results.push({
    name: 'redirect stays on the public URL, not localhost:8080',
    ok: location === 'https://app.example.test/oauth-callback?code=4/0AbC-dEf_9&state=st4te',
    reason: location,
  });

  // No code (Google's deny, or anything else): the callback's card, on the public URL, never JSON
  const quiet = console.warn;
  console.warn = () => undefined;
  const noCode = await GET(new NextRequest('http://localhost:8080/api/refresh-token?state=st4te'));
  const denied = await GET(new NextRequest('http://localhost:8080/api/refresh-token?error=access_denied&state=st4te'));
  console.warn = quiet;
  results.push({
    name: 'no code -> the callback with missing_code and the state',
    ok: noCode.status === 307 && noCode.headers.get('location') === 'https://app.example.test/oauth-callback?error=missing_code&state=st4te',
    reason: `${noCode.status} ${noCode.headers.get('location')}`,
  });
  results.push({
    name: "Google's deny -> the callback with Google's error and the state",
    ok: denied.status === 307 && denied.headers.get('location') === 'https://app.example.test/oauth-callback?error=access_denied&state=st4te',
    reason: `${denied.status} ${denied.headers.get('location')}`,
  });

  let failed = 0;
  for (const r of results) { console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`); if (!r.ok) failed++; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
