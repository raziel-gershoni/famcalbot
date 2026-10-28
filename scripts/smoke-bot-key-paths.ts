// Smoke test: every bot text the code reads is a key that exists in messages/en.json under `bot`.
//
// The bot reads its words with `const t = await getBotMessages(language)` and then `t.voice.expired`, `t.start.welcome`,
// and so on. `t` is typed loosely, so a path that is wrong type-checks, and the line after it ("|| 'English fallback'")
// quietly sends English to everyone. Two such paths were live: `t.start.nativeWelcome` (the keys are under
// `bot.onboarding`) and `t.subscription?.voiceEventsRequired` (the key was under the top-level `subscription`, which the
// bot's `subscription` is not). This walks every file under src/ that calls `getBotMessages(`, follows the variable it
// is stored in and the aliases of its parts (`const wa = t.whatsapp || {}`), and fails on a read whose path is not in
// the English `bot` messages.
//
// What it cannot follow is the allowlist at the top, each with its reason. Nothing is faked: no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-bot-key-paths.ts

import fs from 'node:fs';
import path from 'node:path';

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const ROOT = path.resolve(__dirname, '..');

/**
 * Reads the scan cannot judge, as "<file relative to src>: <path read>" with the reason. A path listed here that no
 * longer shows up fails the walk, so the list cannot go stale.
 */
const ALLOWED: Record<string, string> = {};

/** Files the scan does not read, with the reason. */
const SKIPPED_FILES: Record<string, string> = {
  'lib/bot-messages.ts': 'the loader itself: its `messages` is the whole imported file, not the bot messages',
};

type Tree = Record<string, unknown>;
const en = (JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')) as { bot: Tree }).bot;

/** Whether a dotted path exists in the English bot messages; a read that goes on past a text (".replace", ".length") is fine. */
function exists(dotted: string): boolean {
  let node: unknown = en;
  for (const key of dotted.split('.')) {
    if (typeof node === 'string' || Array.isArray(node)) return true;
    if (node === null || typeof node !== 'object' || !(key in (node as Tree))) return false;
    node = (node as Tree)[key];
  }
  return true;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The comments taken out (a "t.foo" in prose is not a read), keeping line breaks. */
function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const IDENT = '[A-Za-z_$][\\w$]*';
const CHAIN = '(?:\\??\\.[A-Za-z_$][\\w$]*)*';

/** "a.b?.c" to "a.b.c" */
const normalise = (chain: string) => chain.replace(/\?/g, '').replace(/^\./, '');

type Read = { file: string; line: number; path: string; via: string };

/** Every bot text path read in one source file: through the variable the messages are stored in, and through the aliases of their parts. */
function readsIn(file: string, code: string): Read[] {
  // name -> the path under `bot` it stands for ('' is the whole object)
  const roots = new Map<string, string>();

  // const t = await getBotMessages(..)   const m = cond ? await getBotMessages(..) : null   const t = (await getBotMessages(..)).googleSync.consent
  const direct = new RegExp(`(?:const|let)\\s+(${IDENT})\\s*=\\s*(?:[^;=]*?\\?\\s*)?(\\(\\s*)?await\\s+getBotMessages(?:ForTelegramUser)?\\(`, 'g');
  for (const m of code.matchAll(direct)) {
    const after = code.slice(m.index! + m[0].length);
    if (m[2]) {
      // (await getBotMessages(x)).a.b
      let depth = 1;
      let i = 0;
      for (; i < after.length && depth > 0; i++) {
        if (after[i] === '(') depth++;
        if (after[i] === ')') depth--;
      }
      const close = after.slice(i).match(new RegExp(`^\\s*\\)(${CHAIN})`));
      roots.set(m[1], close ? normalise(close[1]) : '');
    } else {
      roots.set(m[1], '');
    }
  }
  // const [subscription, bot] = await Promise.all([getSubscriptionMessages(..), getBotMessages(..)])
  const pair = code.match(new RegExp(`const\\s*\\[\\s*(${IDENT})\\s*,\\s*(${IDENT})\\s*\\]\\s*=\\s*await\\s+Promise\\.all\\(\\[\\s*getSubscriptionMessages\\([^)]*\\)\\s*,\\s*getBotMessages\\(`));
  if (pair) roots.set(pair[2], '');
  // function f(t: BotMessages, ...)   (f: BotMessages['weatherFallback']) =>   a parameter typed as the bot object or one part of it
  for (const m of code.matchAll(new RegExp(`[(,]\\s*(${IDENT})\\s*\\??\\s*:\\s*BotMessages(?:\\[\\s*'([\\w$]+)'\\s*\\])?(?![\\w$[])`, 'g'))) roots.set(m[1], m[2] ?? '');
  if (roots.size === 0) return [];

  // const wa = t.whatsapp || {}   const kd = t.kidNameDetection;   (aliases of a part, followed to a fixed point)
  for (let pass = 0; pass < 4; pass++) {
    for (const [name, base] of [...roots]) {
      const alias = new RegExp(`(?:const|let)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*${name.replace(/\$/g, '\\$')}(${CHAIN})\\s*(?:\\|\\||\\?\\?|;|\\n|\\)|as\\b)`, 'g');
      for (const m of code.matchAll(alias)) {
        const sub = normalise(m[2]);
        const full = [base, sub].filter(Boolean).join('.');
        if (!roots.has(m[1])) roots.set(m[1], full);
      }
    }
  }

  const reads: Read[] = [];
  for (const [name, base] of roots) {
    const escaped = name.replace(/\$/g, '\\$');
    const read = new RegExp(`(?<![\\w$./])${escaped}((?:\\??\\.[A-Za-z_$][\\w$]*)+)`, 'g');
    for (const m of code.matchAll(read)) {
      const sub = normalise(m[1]);
      const full = [base, sub].filter(Boolean).join('.');
      reads.push({ file, line: code.slice(0, m.index).split('\n').length, path: full, via: name });
    }
  }
  return reads;
}

function scan(): Read[] {
  const all: Read[] = [];
  for (const full of sourceFiles(path.join(ROOT, 'src'))) {
    const code = withoutComments(fs.readFileSync(full, 'utf8'));
    if (!code.includes('getBotMessages') && !/:\s*BotMessages\b/.test(code)) continue;
    const relative = path.relative(path.join(ROOT, 'src'), full);
    if (relative in SKIPPED_FILES) continue;
    all.push(...readsIn(relative, code));
  }
  return all;
}

check('the scan follows a variable, a parenthesised read, a pair and an alias, and finds a wrong path (so a clean walk below means something)', () => {
  const sample = [
    "const t = await getBotMessages(locale);",
    "const wa = t.whatsapp || {};",
    "const a = t.start.nativeWelcome;",
    "const b = wa.noSuchKey;",
    "const c = t.subscription?.voiceEventsRequired || 'x';",
    "const d = t.voice?.expired;",
    "const e = wa.cancelButton.replace('a', 'b');",
    "const f = t.plans?.[planKey]?.name;",
    "const g = (await getBotMessages(locale)).googleSync.nope;",
  ].join('\n');
  const found = readsIn('sample.ts', sample).map(r => r.path);
  assert(found.includes('start.nativeWelcome'), `missed a read through the variable: ${found.join(', ')}`);
  assert(found.includes('whatsapp.noSuchKey'), `missed a read through an alias: ${found.join(', ')}`);
  assert(found.includes('subscription.voiceEventsRequired'), `missed an optional-chained read: ${found.join(', ')}`);
  assert(found.includes('whatsapp.cancelButton.replace'), `missed a read followed by a method: ${found.join(', ')}`);
  assert(found.includes('plans'), `missed a read before a bracket: ${found.join(', ')}`);
  assert(exists('voice.expired') && exists('whatsapp.cancelButton.replace') && !exists('start.nativeWelcome') && !exists('whatsapp.noSuchKey') && !exists('subscription.noSuchThing'),
    'exists() does not tell a bot key from a missing one');
  const parenthesised = readsIn('sample.ts', "const t = (await getBotMessages(l)).googleSync;\nconst x = t.reconnect.title;\n").map(r => r.path);
  assert(parenthesised.includes('googleSync.reconnect.title'), `missed a read below a parenthesised call: ${parenthesised.join(', ')}`);
  const loader = readsIn('sample.ts', "const t = await getBotMessagesForTelegramUser(chatId);\nconst x = t.voice.nope;\n").map(r => r.path);
  assert(loader.includes('voice.nope'), `the Telegram-user loader is not followed: ${JSON.stringify(loader)}`);
  const params = readsIn('sample.ts', "function a(t: BotMessages, n: number) { return t.voice.nope1; }\nfunction b(f: BotMessages['weatherFallback']) { return f.nope2; }\n").map(r => r.path);
  assert(params.includes('voice.nope1') && params.includes('weatherFallback.nope2'), `a typed parameter is not followed: ${JSON.stringify(params)}`);
  const pair = readsIn('sample.ts', "const [subscription, bot] = await Promise.all([getSubscriptionMessages(l), getBotMessages(l)]);\nconst x = bot.start.nope; const y = subscription.textLimitReached;\n").map(r => r.path);
  assert(pair.includes('start.nope') && !pair.includes('textLimitReached'), `the pair is read wrong: ${pair.join(', ')}`);
});

check('every bot text path the code reads exists in messages/en.json', () => {
  const reads = scan();
  assert(reads.length > 300, `only ${reads.length} reads found; the scan is broken`);
  const missing = reads.filter(r => !exists(r.path) && !(`${r.file}: ${r.path}` in ALLOWED));
  assert(
    missing.length === 0,
    `${missing.length} read(s) of a bot key that does not exist (the code falls back to English, or shows nothing):\n${missing
      .map(r => `  src/${r.file}:${r.line}  ${r.via}.${r.path}`)
      .join('\n')}`
  );
  const seen = new Set(reads.map(r => `${r.file}: ${r.path}`));
  const stale = Object.keys(ALLOWED).filter(k => !seen.has(k));
  assert(stale.length === 0, `allowlist entries nothing reads any more: ${stale.join(', ')}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
