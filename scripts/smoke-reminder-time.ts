// Smoke test for the per-user reminder time (src/lib/reminder-time.ts): the validator the
// settings route and the picker share, the one helper that reads a user's time, and the
// three message keys the Settings picker needs. No network, no DB.

import { readFileSync } from 'node:fs';
import { DEFAULT_REMINDER_TIME, isValidReminderTime, reminderTimeOf } from '../src/lib/reminder-time';

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

check('isValidReminderTime: HH:mm on a 15-minute step, 00:00 to 23:45, nothing else', () => {
  for (const ok of ['00:00', '09:00', '07:15', '12:30', '23:45']) assert(isValidReminderTime(ok), `${ok} refused`);
  for (const bad of ['', '9:00', '09:10', '24:00', '23:60', '09:00:00', ' 09:00', 'ab:cd', null, undefined, 900, {}]) {
    assert(!isValidReminderTime(bad), `${JSON.stringify(bad)} accepted`);
  }
});

check('reminderTimeOf: the user\'s own time, else 09:00 (null, unset, unreadable, no user)', () => {
  assert(DEFAULT_REMINDER_TIME === '09:00', 'default');
  assert(reminderTimeOf({ reminderTime: '07:30' }) === '07:30', 'own');
  for (const u of [{ reminderTime: null }, {}, { reminderTime: '09:07' }, null, undefined]) {
    assert(reminderTimeOf(u) === '09:00', `${JSON.stringify(u)}`);
  }
});

check('the Settings picker\'s copy exists in en, he and ru', () => {
  for (const l of ['en', 'he', 'ru']) {
    const settings = (JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')) as { settings: Record<string, string> }).settings;
    assert(!!settings.reminderTime && !!settings.reminderTimeHelp, `${l} missing`);
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
process.exit(failed.length ? 1 : 0);
