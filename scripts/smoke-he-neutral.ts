// Smoke test: the Hebrew copy speaks to the person gender-neutrally.
//
// The owner's rule: Hebrew addresses the person in the plural imperative in a sentence ("נסו שוב", "שלחו") and in an
// infinitive or a noun on a button ("לפתוח הגדרות", "פתיחת הגדרות"); never in the masculine singular ("נסה שוב", "לחץ"),
// never "אתה", and never a slash form ("את/ה", "ספר/י"). The bot may still speak of itself in the masculine ("לא
// הצלחתי", "אני לא בטוח"). This walks every Hebrew string in messages/he.json and every Hebrew string written inline in
// the code, and fails on a masculine singular address or a slash form. What it leaves out is listed below with the
// reason, and so is each false hit it cannot tell from a real one (a noun that spells like an imperative).
//
// The matcher finds a word, so a verb that spells like a noun ("דבר" is also "thing") is cleared by the noun phrases
// listed in NOUN_PHRASES, or by an ALLOWED entry for its key.
//
// Nothing is faked: no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-he-neutral.ts

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

/** Top-level groups of messages/he.json not held to the rule, with the reason. */
const NOT_HELD: Record<string, string> = {
  landing: 'the public website build rewrites it',
  howItWorksPage: 'the public website build rewrites it',
  refreshToken: 'the refresh-token page, redesigned by W4 (the old Google screens), which rewrites its copy',
  oauth: 'the OAuth pages, redesigned by W4 (the old Google screens), which rewrites its copy',
};

/** Single keys not held to the rule, with the reason. */
const EXEMPT_KEYS: Record<string, string> = {
  'share.msgShort': 'a text the person sends a friend, not an address to the person',
  'share.msgMedium': 'a text the person sends a friend, not an address to the person',
  'share.msgParent': 'a text the person sends a friend, not an address to the person',
};

/** Source files whose Hebrew is not copy for the person, with the reason. */
const EXEMPT_FILES: Record<string, string> = {
  'services/voice/gemini-voice.ts': 'lists the Hebrew verbs a person may say, as input examples for the model',
};
/** Source folders whose Hebrew is not copy for the person. */
const EXEMPT_DIRS: Record<string, string> = {
  'prompts/': 'instructions to the model; the model writes the person-facing text from them',
};

/**
 * A hit the matcher cannot tell from an address to the person, as "<key or file:line>": reason. An entry nothing hits
 * any more fails the walk, so the list cannot go stale.
 */
const ALLOWED: Record<string, string> = {
  'bot.imageEvent.partsUnreadable': '"השאר" is the noun "the rest" ("עברתי על השאר", I went over the rest), not the imperative "leave"',
};

const H = '\\u05D0-\\u05EA';
/** Words that spell like a masculine imperative and are something else. */
const NOUN_PHRASES = /בית ספר|בתי ספר|דבר אחד|כל דבר|אותו דבר|עוד דבר|דבר ראשון|הדבר|דברים|חבר משפחה|חבר'ה|חברים/g;

/**
 * Masculine singular forms a message addresses the person with: the imperative of the verbs a bot message uses, and
 * "אתה", "תוכל", "תהנה", "תרצה" and the like. A leading ו ("ולחץ") is allowed; the forms with a plural ending
 * ("נסו", "לחצו") and the infinitive ("לנסות") do not match, they continue with another letter.
 */
const MASCULINE = new RegExp(
  `(?<![${H}])(?:ו)?(?:שדרג|לחץ|בחר|נסה|שלח|פתח|שתף|קרא|צפה|הזן|הקלד|הוסף|ערוך|מחק|כתוב|ספר|בדוק|הגדר|חבר|התחבר|וודא|סמן|דבר|הפעל|כבה|בטל|אשר|רענן|עדכן|צור|קבע|שמור|חזור|הורד|הענק|אמת|השאר|פנה|שים|תאשר|אתה|תוכל|תהנה|תרצה|תקבל|תראה|תמצא|תוסיף|תצטרך|תיהנה|תלחץ|תבחר|תשלח|ימחק)(?![${H}])`
);
/** A slash form: "את/ה", "ספר/י", "ילד/ה". */
const SLASH = new RegExp(`[${H}]/(?:י|ה|ת|ית|ים|ות)(?![${H}])`);

/** The first masculine or slash form in the text, or null. */
function hit(text: string): string | null {
  const plain = text.replace(NOUN_PHRASES, ' ');
  return SLASH.exec(plain)?.[0] ?? MASCULINE.exec(plain)?.[0] ?? null;
}

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

check('the matcher finds a masculine address and a slash form, and passes a neutral one (so a clean walk below means something)', () => {
  for (const bad of ['נסה שוב', 'לחץ כאן', 'את/ה', 'ספר/י לי', 'אנא התחבר מחדש', 'שים לב!', 'אתה עכשיו בתוכנית', 'תהנה מיום פנוי', 'ילד/ה שלך', 'ואז לחץ על הכפתור', 'ימחק: כל האירועים', 'פתח הגדרות']) {
    assert(hit(bad) !== null, `missed: ${bad}`);
  }
  for (const good of ['נסו שוב', 'לנסות שוב', 'בית ספר', 'עבור', 'אני לא בטוח', 'לחצו כאן', 'שימו לב', 'פתיחת הגדרות', 'לפתוח הגדרות', 'עוד דבר אחד קצר', 'יימחקו: כל האירועים', 'המשפחה שלך', 'קחו מטריה', 'מצטער, אירעה שגיאה', 'שנה', 'ראה', 'חברים']) {
    assert(hit(good) === null, `flagged: ${good} (${hit(good)})`);
  }
});

const he = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')) as Record<string, unknown>;
const seen = new Set<string>();

check('every Hebrew string in messages/he.json speaks to the person gender-neutrally', () => {
  const all = leaves(he);
  assert(all.length > 1000, `only ${all.length} strings read`);
  const bad: string[] = [];
  for (const [key, text] of all) {
    if (key.split('.')[0] in NOT_HELD || key in EXEMPT_KEYS) continue;
    const found = hit(text);
    if (!found) continue;
    if (key in ALLOWED) {
      seen.add(key);
      continue;
    }
    bad.push(`  ${key}: "${found}" in ${text.replace(/\n/g, '\\n')}`);
  }
  assert(bad.length === 0, `${bad.length} string(s) address the person in the masculine or with a slash:\n${bad.join('\n')}`);
});

check('every Hebrew string written inline in the code speaks to the person gender-neutrally', () => {
  const srcDir = path.join(ROOT, 'src');
  const bad: string[] = [];
  let hebrewLines = 0;
  for (const file of sourceFiles(srcDir)) {
    const relative = path.relative(srcDir, file);
    if (relative in EXEMPT_FILES || Object.keys(EXEMPT_DIRS).some(dir => relative.startsWith(dir))) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/[א-ת]/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
      hebrewLines++;
      const found = hit(line);
      if (!found) return;
      const id = `${relative}:${line.trim().slice(0, 60)}`;
      if (id in ALLOWED) {
        seen.add(id);
        return;
      }
      bad.push(`  src/${relative}:${i + 1}: "${found}" in ${line.trim().slice(0, 140)}`);
    });
  }
  assert(hebrewLines > 20, `only ${hebrewLines} inline Hebrew lines read; the scan is broken`);
  assert(bad.length === 0, `${bad.length} inline Hebrew line(s) address the person in the masculine or with a slash:\n${bad.join('\n')}`);
});

check('the allowlist holds no entry nothing hits any more', () => {
  const stale = Object.keys(ALLOWED).filter(k => !seen.has(k));
  assert(stale.length === 0, `stale allowlist entries: ${stale.join(', ')}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
