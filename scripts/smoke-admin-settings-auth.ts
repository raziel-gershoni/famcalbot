// Smoke test: GET /api/admin/settings must refuse callers without valid admin initData.
// It used to return the admin settings to anyone.
//
// Run: npx tsx -r dotenv/config scripts/smoke-admin-settings-auth.ts

import { NextRequest } from 'next/server';
import { GET } from '../app/api/admin/settings/route';

async function main() {
  const results: { name: string; ok: boolean; reason?: string }[] = [];

  const noAuth = await GET(new NextRequest('http://localhost/api/admin/settings'));
  results.push({ name: 'no initData -> 401', ok: noAuth.status === 401, reason: `status ${noAuth.status}` });

  const forged = await GET(new NextRequest('http://localhost/api/admin/settings?initData=' + encodeURIComponent('user=%7B%22id%22%3A1%7D&hash=deadbeef')));
  results.push({ name: 'forged initData -> 401', ok: forged.status === 401, reason: `status ${forged.status}` });

  const body = await noAuth.json().catch(() => ({}));
  results.push({ name: 'no settings leaked', ok: !('ttsModel' in body) && !('defaultAiModel' in body), reason: JSON.stringify(body) });

  let failed = 0;
  for (const r of results) { console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`); if (!r.ok) failed++; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
