// Guard smoke: the code no longer knows the dead columns (step 1 of 2 of their removal; the
// DROP COLUMN migration, step 2, is prisma/migrations/20261029000000_drop_unused_columns, pinned at the end).
//
// The names below are columns the database may still hold, but nothing reads or writes them. A name that comes back
// into prisma/schema.prisma, src/, app/, components/, messages/ or a smoke fixture means someone
// built on a dead column again, or a fixture still carries a field the schema no longer has (the
// smokes' fixtures are loosely typed, so tsc does not catch that one). Text checks only: no
// database, no network.
//
// Run: npx tsx scripts/smoke-dead-columns.ts

import fs from 'fs';
import path from 'path';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const ROOT = path.resolve(__dirname, '..');

/** AdminSettings columns the code stopped knowing. */
const ADMIN_SETTINGS = ['defaultAiModel', 'geminiThinkingLevel', 'ttsModel', 'calendarHomeRollout'];
/** User columns the code stopped knowing. */
const USER = ['voicePreference', 'voiceStyle', 'locationForced', 'includeWeeklyInLookahead'];
/** The enum that went with calendarHomeRollout. */
const ENUM = 'CalendarHomeRollout';

/**
 * `ttsModel` is also the name of a local variable and a result field in the voice code (the TTS
 * model a voice note was made with), so outside the schema it only counts in a file that touches
 * AdminSettings. A column access with a field the schema lacks fails tsc in typed code, so this is
 * the net for the loosely typed fixtures.
 */
const LOCAL_NAMES = ['ttsModel'];
/** The names that count wherever they appear. */
const NAMES = [...ADMIN_SETTINGS, ...USER, ENUM].filter(n => !LOCAL_NAMES.includes(n));

/** Files that say a name on purpose: the smoke that asserts the rollout switch is gone. */
const ALLOWED: Record<string, string[]> = {
  'scripts/smoke-admin-panel-ssr.ts': ['calendarHomeRollout'],
};

/** Where the code and its fixtures live. */
const SCAN_DIRS = ['src', 'app', 'components', 'messages', 'scripts', 'i18n'];
const SCAN_FILES = ['proxy.ts', 'instrumentation.ts', 'instrumentation-client.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts', 'next.config.js'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'migrations']);
const SELF = 'scripts/smoke-dead-columns.ts';

/** Every source file under a directory, as repo-relative paths. */
function walk(dir: string, out: string[] = []): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(rel, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|json|md|sh|sql|prisma)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** The names a text holds as whole words. */
function namesIn(text: string, names: string[]): string[] {
  return names.filter(n => new RegExp(`(?<![A-Za-z0-9_$])${n}(?![A-Za-z0-9_$])`).test(text));
}

const files = [...SCAN_DIRS.flatMap(d => walk(d)), ...SCAN_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))].filter(f => f !== SELF);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const schema = read('prisma/schema.prisma');

/** The body of `model <name> { ... }` in schema.prisma. */
function modelBody(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match) throw new Error(`no model ${name}`);
  return match[1];
}

check('the matcher finds a whole word and nothing else (so a clean scan below means something)', () => {
  assert(namesIn("user.voiceStyle = 'calm'", USER).join() === 'voiceStyle', 'a member access');
  assert(namesIn("{ locationForced: false, x: 1 }", USER).join() === 'locationForced', 'an object key');
  assert(namesIn('"includeWeeklyInLookahead" boolean', USER).join() === 'includeWeeklyInLookahead', 'a quoted column');
  assert(namesIn('enum CalendarHomeRollout {', [ENUM]).join() === ENUM, 'the enum');
  assert(namesIn('voiceStyleOther voicePreferences preVoiceStyle', USER).length === 0, 'a longer identifier is not a hit');
});

check('the scan reaches the code, the fixtures and the schema (not an empty walk)', () => {
  assert(files.length > 300, `only ${files.length} files scanned`);
  for (const must of ['src/services/account-linking.ts', 'src/types.ts', 'app/api/settings/route.ts', 'scripts/smoke-account-merge.ts', 'scripts/smoke-admin-panel-ssr.ts']) {
    assert(files.includes(must), `${must} is not scanned`);
  }
});

check('prisma/schema.prisma: no dead column, and no enum CalendarHomeRollout', () => {
  assert(!/enum\s+CalendarHomeRollout\b/.test(schema), 'enum CalendarHomeRollout is back');
  const found = namesIn(schema, [...ADMIN_SETTINGS, ...USER, ENUM]);  // ttsModel too: the schema has no local variables
  assert(found.length === 0, `the schema names ${found.join(', ')}`);
});

check('the User and AdminSettings models do not hold the columns', () => {
  const user = namesIn(modelBody('User'), USER);
  const settings = namesIn(modelBody('AdminSettings'), ADMIN_SETTINGS);
  assert(user.length === 0, `User holds ${user.join(', ')}`);
  assert(settings.length === 0, `AdminSettings holds ${settings.join(', ')}`);
});

check('src/, app/, components/, messages/ and the smokes: no dead column outside the one smoke that asserts the rollout switch is gone', () => {
  const problems: string[] = [];
  for (const rel of files) {
    const text = read(rel);
    const allowed = ALLOWED[rel] ?? [];
    const found = namesIn(text, NAMES).filter(n => !allowed.includes(n));
    if (found.length > 0) problems.push(`${rel}: ${found.join(', ')}`);
  }
  assert(problems.length === 0, `${problems.length} files name a dead column:\n     ${problems.join('\n     ')}`);
});

check('ttsModel: no file that reads or writes AdminSettings names it (a local variable elsewhere is a different thing)', () => {
  const problems: string[] = [];
  for (const rel of files) {
    const text = read(rel);
    if (/adminSettings/i.test(text) && namesIn(text, LOCAL_NAMES).length > 0) problems.push(rel);
  }
  assert(problems.length === 0, `${problems.length} files touch AdminSettings and name ttsModel:\n     ${problems.join('\n     ')}`);
});

check('the allow-list is still needed (the smoke that asserts the rollout switch is gone still names it, and nothing else does)', () => {
  for (const [rel, names] of Object.entries(ALLOWED)) {
    assert(files.includes(rel), `${rel} is not scanned`);
    const found = namesIn(read(rel), names);
    assert(found.length === names.length, `${rel} no longer names ${names.join(', ')}: drop it from ALLOWED`);
  }
});

/** Step 2 of 2: the migration that drops the columns, once the build that stopped knowing them was live. */
const DROP_MIGRATION = 'prisma/migrations/20261029000000_drop_unused_columns/migration.sql';

check('the drop migration drops every dead column with IF EXISTS, and the enum only after its column', () => {
  const sql = read(DROP_MIGRATION);
  const statements = sql.split('\n').filter(line => line.trim() && !line.trim().startsWith('--'));
  const dropOf = (table: string, column: string) => `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}";`;
  for (const column of ADMIN_SETTINGS) assert(statements.includes(dropOf('AdminSettings', column)), `no drop of AdminSettings.${column}`);
  for (const column of USER) assert(statements.includes(dropOf('User', column)), `no drop of User.${column}`);
  const dropType = `DROP TYPE IF EXISTS "${ENUM}";`;
  assert(statements.includes(dropType), `no drop of the enum ${ENUM}`);
  assert(statements.indexOf(dropType) > statements.indexOf(dropOf('AdminSettings', 'calendarHomeRollout')), 'the enum is dropped before the column that uses it');
  assert(statements.length === ADMIN_SETTINGS.length + USER.length + 1, `the migration does something else too: ${statements.length} statements`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
