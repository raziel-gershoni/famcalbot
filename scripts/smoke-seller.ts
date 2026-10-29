// Smoke test: the seller's details are all given (src/lib/seller.ts, SELLER).
//
// The Consumer Protection Law (s.14C(a)(1)) has a business that sells at a distance give its name, its ID or business
// number and its address, and s.14I has it take a cancellation by phone and by post. The Terms ("Who runs FamCal",
// "Cancelling and refunds"), the landing's "Cancel a payment" line, the plan screen and the confirmation after a
// payment all read SELLER, which marks a detail the owner hasn't given yet as null; the pages then show "to be added".
// This fails, naming each one, while any detail is null or empty: the seller's name in each language, the ID number,
// the postal address, the phone and the email.
//
// EXPECTED RED: until the owner sends the ID number, the postal address and the phone, this is the one smoke that
// fails (ci-smokes.sh runs it with the others). It turns green the moment the three values are filled in SELLER.
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

/** Every detail of the seller and its value, the name once per language. */
function details(seller: typeof SELLER): [string, unknown][] {
  return [
    ...(['en', 'he', 'ru'] as const).map((l): [string, unknown] => [`name.${l}`, seller.name?.[l]]),
    ['idNumber', seller.idNumber],
    ['postalAddress', seller.postalAddress],
    ['phone', seller.phone],
    ['email', seller.email],
  ];
}

/** The details that are missing: null, undefined, or only spaces. */
const missing = (seller: typeof SELLER) => details(seller).filter(([, value]) => typeof value !== 'string' || value.trim() === '').map(([name]) => name);

check('the matcher names a null, an empty and a blank detail, and passes a full set (so a clean result below means something)', () => {
  const full = { name: { en: 'A', he: 'א', ru: 'А' }, idNumber: '1', postalAddress: 'x', phone: '1', email: 'a@b.c' };
  const found = missing({ ...full, idNumber: null, postalAddress: '', phone: '  ', name: { ...full.name, ru: '' } });
  if (found.join(',') !== 'name.ru,idNumber,postalAddress,phone') throw new Error(`named ${found.join(',')}`);
  if (missing(full).length) throw new Error(`a full set misses ${missing(full).join(',')}`);
});

check('every seller detail is given in src/lib/seller.ts (the name in en, he and ru, the ID number, the postal address, the phone, the email)', () => {
  const found = missing(SELLER);
  if (found.length) throw new Error(`not given yet: ${found.join(', ')} (src/lib/seller.ts, SELLER)`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
