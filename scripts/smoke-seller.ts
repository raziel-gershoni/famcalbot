// Smoke test: the seller's details in src/lib/seller.ts (SELLER) are well formed.
//
// The Consumer Protection Law (s.14C(a)(1)) has a business that sells at a distance give its name, its ID or business
// number and its address, and s.14I has it take a cancellation by phone and by post. The Terms ("Who runs FamCal",
// "Cancelling and refunds"), the landing's "Cancel a payment" line, the plan screen and the confirmation after a
// payment all read SELLER. The owner publishes before giving the ID number, the address and the phone (2026-10-30), so
// each of those is null until given (the website shows "to be added", the bot leaves it out), never an empty string.
// The name in each language and the email are always given. This fails, naming each, on a missing name or email, or on
// an ID number, address or phone that is set but blank.
//
// Nothing is faked: no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-seller.ts

import { SELLER } from '../src/lib/seller';

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

/** What's wrong with the seller's details: a name or the email missing, or a detail that's set but blank. */
function problems(seller: typeof SELLER): string[] {
  const given = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  return [
    ...(['en', 'he', 'ru'] as const).filter((l) => !given(seller.name?.[l])).map((l) => `name.${l} missing`),
    ...(given(seller.email) ? [] : ['email missing']),
    ...(['idNumber', 'postalAddress', 'phone'] as const).filter((k) => seller[k] !== null && !given(seller[k])).map((k) => `${k} blank (null until given)`),
  ];
}

check('the matcher names a missing name or email and a blank detail, and passes both a full set and one waiting for details (so a clean result below means something)', () => {
  const full = { name: { en: 'A', he: 'א', ru: 'А' }, idNumber: '1', postalAddress: 'x', phone: '1', email: 'a@b.c' };
  const found = problems({ ...full, idNumber: '', phone: '  ', email: '', name: { ...full.name, ru: '' } });
  if (found.join(',') !== 'name.ru missing,email missing,idNumber blank (null until given),phone blank (null until given)') throw new Error(`named ${found.join(',')}`);
  if (problems(full).length) throw new Error(`a full set has ${problems(full).join(',')}`);
  const waiting = problems({ ...full, idNumber: null, postalAddress: null, phone: null });
  if (waiting.length) throw new Error(`a set waiting for details has ${waiting.join(',')}`);
});

check('the seller in src/lib/seller.ts has the name in en, he and ru and the email, and the ID number, the postal address and the phone are each given or null', () => {
  const found = problems(SELLER);
  if (found.length) throw new Error(`${found.join(', ')} (src/lib/seller.ts, SELLER)`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
