// Smoke test for the data behind web sign-in (spec 2026-11-02-web-sign-in §2.12, §2.13, §2.17; plan Task 1): the
// SignInIdentity table (one Google account and one email per person, each on one account only, deleted with the
// account), the three User columns (sessionsValidAfter, googleAccountKey with its index, googleCalendarSignIn on by
// default, existing accounts included), the hand-written migration that makes them on deploy (additions only and safe to
// run twice, so one push is enough), the generated client that knows them, and the two new app-key purposes.
//
// The merge's half (W's ways move to T, T's stay where both have one, the Google account key travels with the
// connection) and the account delete's cascade are checks #64-#67 of scripts/smoke-account-merge.ts, whose fake Prisma
// keeps the schema's unique keys and ON DELETE actions.
//
// Real: app-keys and the generated Prisma client's field lists. Text: prisma/schema.prisma, the migration, app-keys'
// purpose type and the hard delete's source. Faked: error capture (app-keys reports a missing secret through it).
// No network, no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-signin-data.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test value, used only when the fake env left it unset.
process.env.SESSION_SECRET ||= 'test-session-secret';

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
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

const MIGRATION = '20261102000000_web_sign_in';
const schema = read('prisma/schema.prisma');

/** The lines of `model <name> { ... }`, comments dropped and runs of spaces made one ('kind String'). */
function modelLines(name: string): string[] {
  const match = new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match) throw new Error(`no model ${name} in prisma/schema.prisma`);
  return match[1].split('\n').map((l) => l.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** The migration's SQL without its comment lines, runs of whitespace made one space. */
function migrationCode(): string {
  const file = path.join(ROOT, 'prisma/migrations', MIGRATION, 'migration.sql');
  if (!fs.existsSync(file)) throw new Error(`no prisma/migrations/${MIGRATION}/migration.sql`);
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');
}

/** app-keys reports a missing secret through error capture: a recorder in require's cache (it is loaded as CommonJS). */
function stubErrorCapture() {
  const Module = nodeRequire('module');
  const filename = path.join(ROOT, 'src/lib/error-capture.ts');
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports: { captureError: () => undefined, captureWarning: () => undefined, captureInfo: () => undefined } });
  Module._cache[filename] = mod;
}

async function main() {
  stubErrorCapture();

  await check('#1 schema: SignInIdentity holds kind, subject and the address to show, one per (kind, subject) and per (user, kind), deleted with its user', () => {
    const lines = modelLines('SignInIdentity');
    const want = [
      'id Int @id @default(autoincrement())',
      'userId Int',
      'user User @relation(fields: [userId], references: [id], onDelete: Cascade)',
      'kind String',
      'subject String',
      'address String',
      'createdAt DateTime @default(now())',
      'lastUsedAt DateTime?',
      '@@unique([kind, subject])',
      '@@unique([userId, kind])',
    ];
    const missing = want.filter((l) => !lines.includes(l));
    const extra = lines.filter((l) => !want.includes(l));
    assert(missing.length === 0 && extra.length === 0, `missing ${show(missing)}, extra ${show(extra)}`);
  });

  await check('#2 schema: User has sessionsValidAfter (nullable), googleAccountKey (nullable, indexed), googleCalendarSignIn (on by default) and its sign-in ways', () => {
    const lines = modelLines('User');
    const want = [
      'sessionsValidAfter DateTime?',
      'googleAccountKey String?',
      'googleCalendarSignIn Boolean @default(true)',
      'signInIdentities SignInIdentity[]',
      '@@index([googleAccountKey])',
    ];
    const missing = want.filter((l) => !lines.includes(l));
    assert(missing.length === 0, `User lacks ${show(missing)}`);
  });

  await check('#3 the generated client knows the table and the columns (prisma generate ran after the schema changed)', () => {
    const lists = Prisma as unknown as Record<string, Record<string, string> | undefined>;
    assert(lists.ModelName?.SignInIdentity === 'SignInIdentity', 'no SignInIdentity model in the client');
    const user = Object.values(lists.UserScalarFieldEnum ?? {});
    const missing = ['sessionsValidAfter', 'googleAccountKey', 'googleCalendarSignIn'].filter((f) => !user.includes(f));
    assert(missing.length === 0, `the client's User lacks ${show(missing)}`);
    const way = Object.values(lists.SignInIdentityScalarFieldEnum ?? {}).sort();
    assert(show(way) === show(['address', 'createdAt', 'id', 'kind', 'lastUsedAt', 'subject', 'userId']), `SignInIdentity fields ${show(way)}`);
  });

  await check('#4 the migration makes exactly what the schema declares, under Prisma\'s own names', () => {
    const sql = migrationCode();
    const want = [
      'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionsValidAfter" TIMESTAMP(3);',
      'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleAccountKey" TEXT;',
      'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleCalendarSignIn" BOOLEAN NOT NULL DEFAULT true;',
      'CREATE INDEX IF NOT EXISTS "User_googleAccountKey_idx" ON "User"("googleAccountKey");',
      'CREATE TABLE IF NOT EXISTS "SignInIdentity" (',
      '"id" SERIAL NOT NULL,',
      '"userId" INTEGER NOT NULL,',
      '"kind" TEXT NOT NULL,',
      '"subject" TEXT NOT NULL,',
      '"address" TEXT NOT NULL,',
      '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '"lastUsedAt" TIMESTAMP(3),',
      'CONSTRAINT "SignInIdentity_pkey" PRIMARY KEY ("id")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "SignInIdentity_kind_subject_key" ON "SignInIdentity"("kind", "subject");',
      'CREATE UNIQUE INDEX IF NOT EXISTS "SignInIdentity_userId_kind_key" ON "SignInIdentity"("userId", "kind");',
      'ALTER TABLE "SignInIdentity" ADD CONSTRAINT "SignInIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    ];
    const missing = want.filter((s) => !sql.includes(s));
    assert(missing.length === 0, `the migration lacks ${show(missing)}`);
  });

  await check('#5 the migration only adds, and a second run is a no-op: no drop, delete, update or rename; every add is IF NOT EXISTS; the key is added in a block that skips a duplicate', () => {
    const sql = migrationCode();
    assert(!/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i.test(sql.replace(/ON (DELETE|UPDATE) CASCADE/g, '')), 'the migration removes or rewrites something');
    const adds = sql.match(/ADD COLUMN(?! IF NOT EXISTS)/g) ?? [];
    const creates = sql.match(/CREATE (UNIQUE )?(INDEX|TABLE)(?! IF NOT EXISTS)/g) ?? [];
    assert(adds.length === 0 && creates.length === 0, `not idempotent: ${show([...adds, ...creates])}`);
    assert(/DO \$\$ BEGIN ALTER TABLE "SignInIdentity" ADD CONSTRAINT [^$]*EXCEPTION WHEN duplicate_object THEN null; END \$\$;/.test(sql), 'the foreign key is not in a duplicate-safe block');
  });

  await check('#6 the migration runs after every one that shipped before it (the newest at 2b38fc4c is 20261030000000_payments_backfill_again)', () => {
    const names = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    const mine = names.indexOf(MIGRATION);
    assert(mine >= 0 && mine > names.indexOf('20261030000000_payments_backfill_again'), `order ${show(names.slice(-3))}`);
  });

  await check('#7 app keys: \'signin\' and \'google-account\' are purposes, each its own HKDF key from SESSION_SECRET', async () => {
    const line = /export type AppKeyPurpose = ([^;]+);/.exec(read('src/lib/app-keys.ts'))?.[1] ?? '';
    const purposes = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert(show(purposes) === show(['session-cookie', 'image-link', 'signin', 'google-account']), `AppKeyPurpose ${show(purposes)}`);
    const { appKey } = await load('src/lib/app-keys.ts');
    const hkdf = (purpose: string) => Buffer.from(crypto.hkdfSync('sha256', process.env.SESSION_SECRET as string, '', `famcal/${purpose}/v1`, 32));
    for (const purpose of ['signin', 'google-account']) {
      const key = appKey(purpose) as Buffer | null;
      assert(key && key.equals(hkdf(purpose)), `${purpose}: not HKDF famcal/${purpose}/v1`);
    }
    assert(!(appKey('signin') as Buffer).equals(appKey('session-cookie') as Buffer), 'signin shares the session-cookie key');
    assert(!(appKey('google-account') as Buffer).equals(appKey('signin') as Buffer), 'google-account shares the signin key');
  });

  await check('#8 [guard] the account delete leaves the sign-in ways to the cascade: hardDeleteUser deletes no SignInIdentity itself', () => {
    const src = read('src/lib/user-moderation.ts');
    const body = src.slice(src.indexOf('export async function hardDeleteUser'), src.indexOf('export async function personalCacheKeys'));
    assert(body.length > 0 && !/signInIdentity\./.test(body), 'hardDeleteUser deletes sign-in ways by hand');
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
