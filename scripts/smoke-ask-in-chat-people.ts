// Smoke test for whose lines a guest answer has (src/services/ask-in-chat/people.ts; spec
// docs/superpowers/specs/2026-11-08-ask-in-chat-people-design.md §3, the owner's decisions 1, 2, 3 and 5):
//   - peopleOf: the caller's own calendars (primary, yours), the partner's (every FamCal calendar the partner owns, and
//     a spouse-labelled one), each kid by the person on their calendar, the family (no label); a partner's kids calendar
//     is the kids'; a calendar with several labels counts for each; birthdays and Google holidays are no one's; the order
//     is the caller, the partner, the kids in calendar order, the family;
//   - the names: the caller's first name, the partner's first name from the pairing else the spouse calendar's person,
//     a kid's person (the English name in an English or Russian answer when set); none is null; kids' calendars naming
//     the same person (niqqud and case aside) share a line, and so do those naming no one;
//   - with no calendar anyone's, the caller alone, with none;
//   - foldName and askedLines: each group, everyone, a person by any of their names (case, niqqud, ё, a first name of a
//     full one, a Hebrew prefix letter), the caller by their own name; a group with no line and a name no line answers
//     are no one in particular, and the log never holds a name.
// Pure: no network, no database.
//
//   npx tsx scripts/smoke-ask-in-chat-people.ts

import type { CalendarAssignment, CalendarLabel } from '../src/types';
import { askedLines, foldName, peopleOf, type Person } from '../src/services/ask-in-chat/people';

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
const show = (v: unknown) => JSON.stringify(v);
const same = (got: unknown, want: unknown, label: string) => assert(show(got) === show(want), `${label}:\n  got  ${show(got)}\n  want ${show(want)}`);

const cal = (calendarId: string, labels: CalendarLabel[], extra: Partial<CalendarAssignment> = {}): CalendarAssignment => ({
  calendarId, labels, name: calendarId, color: '#000', ...extra,
});

// Raziel's list, labelled from his side as getCalendarsWithOwners hands it over: FamCal rows first, then Google's.
const CALENDARS: CalendarAssignment[] = [
  cal('native:dana-main', ['spouse'], { personName: 'דנה', personEnglishName: 'Dana' }), // Dana's own (her primary)
  cal('native:raz-main', ['primary', 'yours']),
  cal('native:raz-kids', ['kids'], { personName: 'מָאיָה', personEnglishName: 'Maya' }),
  cal('native:dana-kids', ['kids'], { personName: 'נועה' }), // Dana labelled it kids
  cal('native:dana-about-raz', ['yours']), // Dana's calendar she labelled spouse (about the caller): the caller's line (controller ruling, labelsFromViewerSide)
  cal('native:dana-plain', []), // Dana's, no label: hers
  cal('native:dana-bdays', ['birthdays']),
  cal('native:home', []), // Raziel's own, no label: the family's
  cal('work@example.com', ['yours']),
  cal('maya@group.calendar.google.com', ['kids'], { personName: 'מאיה', personEnglishName: 'Maya' }), // the same kid
  cal('school@group.calendar.google.com', ['kids']), // a kids calendar naming no one
  cal('en.jewish#holiday@group.v.calendar.google.com', []),
  cal('bdays@group.calendar.google.com', ['birthdays']),
];
const PARTNER_OWNED = new Set(['native:dana-main', 'native:dana-kids', 'native:dana-about-raz', 'native:dana-plain', 'native:dana-bdays']);
const RAZ = { name: 'Raziel Gershoni', englishName: 'Raziel' };
const DANA = { name: 'דנה לוי', englishName: 'Dana' };

const rows = (people: Person[]) => people.map(p => [p.key, p.name, p.calendarIds]);
const he = peopleOf({ assignments: CALENDARS, partnerOwned: PARTNER_OWNED, me: RAZ, partner: DANA, locale: 'he' });
const en = peopleOf({ assignments: CALENDARS, partnerOwned: PARTNER_OWNED, me: RAZ, partner: DANA, locale: 'en' });

check('peopleOf: the caller, the partner (what she owns but her kids calendar and the one about the caller), each kid, the family; birthdays and holidays no one\'s', () => {
  same(rows(he), [
    ['me', 'Raziel', ['native:raz-main', 'native:dana-about-raz', 'work@example.com']],
    ['partner', 'דנה', ['native:dana-main', 'native:dana-plain']],
    ['kid:מאיה', 'מָאיָה', ['native:raz-kids', 'maya@group.calendar.google.com']],
    ['kid:נועה', 'נועה', ['native:dana-kids']],
    ['kid:', null, ['school@group.calendar.google.com']],
    ['family', null, ['native:home']],
  ], 'he');
});

check('peopleOf: an English or Russian answer names a kid by the English name when it is set, and keeps one line per kid', () => {
  same(rows(en).slice(2, 5), [
    ['kid:maya', 'Maya', ['native:raz-kids', 'maya@group.calendar.google.com']],
    ['kid:נועה', 'נועה', ['native:dana-kids']],
    ['kid:', null, ['school@group.calendar.google.com']],
  ], 'en kids');
  same(peopleOf({ assignments: CALENDARS, partnerOwned: PARTNER_OWNED, me: RAZ, partner: DANA, locale: 'ru' })[2].name, 'Maya', 'ru');
});

check('peopleOf: a calendar with several labels counts for each; a partner\'s calendar labelled kids and spouse is both', () => {
  const people = peopleOf({
    assignments: [cal('mine@example.com', ['yours', 'kids'], { personName: 'Leo' }), cal('native:p', ['spouse', 'kids'], { personName: 'Mia' })],
    partnerOwned: new Set(['native:p']), me: RAZ, partner: DANA, locale: 'en',
  });
  same(rows(people), [
    ['me', 'Raziel', ['mine@example.com']],
    ['partner', 'דנה', ['native:p']],
    ['kid:leo', 'Leo', ['mine@example.com']],
    ['kid:mia', 'Mia', ['native:p']],
  ], 'several labels');
});

check('peopleOf: with no pairing, a spouse calendar\'s person names the partner (the English one in English); with neither, null', () => {
  const google = [cal('me@example.com', ['primary', 'yours']), cal('noa@example.com', ['spouse'], { personName: 'נועה', personEnglishName: 'Noa' })];
  same(peopleOf({ assignments: google, partnerOwned: new Set(), me: RAZ, partner: null, locale: 'he' })[1].name, 'נועה', 'he');
  same(peopleOf({ assignments: google, partnerOwned: new Set(), me: RAZ, partner: null, locale: 'en' })[1].name, 'Noa', 'en');
  same(peopleOf({ assignments: [cal('x@example.com', ['spouse'])], partnerOwned: new Set(), me: { name: '' }, partner: null, locale: 'en' })[0].name, null, 'no name');
});

check('peopleOf: with no calendar anyone\'s, the caller alone with none; a caller with no name is null', () => {
  same(rows(peopleOf({ assignments: [], partnerOwned: new Set(), me: RAZ, partner: null, locale: 'en' })), [['me', 'Raziel', []]], 'none');
  same(rows(peopleOf({ assignments: [cal('b@x', ['birthdays'])], partnerOwned: new Set(), me: { name: '  ' }, partner: null, locale: 'en' })), [['me', null, []]], 'only birthdays');
});

check('foldName: niqqud, case, ё, apostrophes and geresh, and spaces don\'t matter', () => {
  same(foldName('  מָאיָה '), 'מאיה', 'niqqud');
  same(foldName('MAYA  Cohen'), 'maya cohen', 'case and spaces');
  same(foldName('Алёна'), 'алена', 'ё');
  same(foldName('ג׳וני'), 'גוני', 'geresh');
  same(foldName("D'Angelo"), 'dangelo', 'apostrophe');
});

check('askedLines: each group, everyone, and no one in particular', () => {
  same(askedLines(null, he), { keys: null, log: 'none' }, 'nobody');
  same([...askedLines({ kind: 'me' }, he).keys!], ['me'], 'me');
  same([...askedLines({ kind: 'partner' }, he).keys!], ['partner'], 'partner');
  same([...askedLines({ kind: 'kids' }, he).keys!], ['kid:מאיה', 'kid:נועה', 'kid:'], 'kids');
  same([...askedLines({ kind: 'family' }, he).keys!], ['family'], 'family');
  same([...askedLines({ kind: 'everyone' }, he).keys!], he.map(p => p.key), 'everyone');
  same(askedLines({ kind: 'kids' }, he).log, 'kids', 'log');
});

check('askedLines: a person by any of their names; the caller by their own; the partner by the pairing\'s or the calendar\'s', () => {
  const one = (name: string) => [...(askedLines({ kind: 'person', name }, he).keys ?? [])];
  for (const name of ['מאיה', 'מָאיָה', 'Maya', 'MAYA', 'Maya Cohen', 'למאיה']) same(one(name), ['kid:מאיה'], name);
  same(one('נועה'), ['kid:נועה'], 'a partner\'s kid');
  same(one('Dana'), ['partner'], 'the partner in English');
  same(one('דנה'), ['partner'], 'the partner in Hebrew');
  same(one('Raziel'), ['me'], 'the caller');
  same(askedLines({ kind: 'person', name: 'Maya' }, he).log, 'person', 'log');
});

check('askedLines: a group with no line and a name no line answers are no one in particular, and the log holds no name', () => {
  const alone = peopleOf({ assignments: [cal('me@example.com', ['yours'])], partnerOwned: new Set(), me: RAZ, partner: null, locale: 'en' });
  same(askedLines({ kind: 'kids' }, alone), { keys: null, log: 'kids-none' }, 'no kids');
  same(askedLines({ kind: 'partner' }, alone), { keys: null, log: 'partner-none' }, 'no partner');
  same(askedLines({ kind: 'person', name: 'SECRET-NAME' }, he), { keys: null, log: 'person-none' }, 'unknown');
});

check('review focus: a calendar person written over two lines or with extra spaces heads its line on one line', () => {
  const people = peopleOf({ assignments: [cal('k@x', ['kids'], { personName: '  Maya\n Cohen ' })], partnerOwned: new Set(), me: RAZ, partner: null, locale: 'he' });
  same(people[0].name, 'Maya Cohen', 'tidy');
  same([...askedLines({ kind: 'person', name: 'maya' }, people).keys!], ['kid:maya cohen'], 'its first word matches');
});

check('review focus: a partner\'s calendar labelled kids and birthdays is no one\'s', () => {
  const people = peopleOf({ assignments: [cal('me@x', ['yours']), cal('native:p', ['kids', 'birthdays'], { personName: 'Mia' })], partnerOwned: new Set(['native:p']), me: RAZ, partner: DANA, locale: 'en' });
  same(rows(people), [['me', 'Raziel', ['me@x']]], 'birthdays win');
});

check('review focus: a name two people share gives both lines; "me" asked with no calendar of the caller\'s is no one in particular', () => {
  const people = peopleOf({ assignments: [cal('native:p', []), cal('k@x', ['kids'], { personName: 'Noa' })], partnerOwned: new Set(['native:p']), me: RAZ, partner: { name: 'Noa' }, locale: 'en' });
  same([...askedLines({ kind: 'person', name: 'Noa' }, people).keys!], ['partner', 'kid:noa'], 'both');
  same(askedLines({ kind: 'me' }, people), { keys: null, log: 'me-none' }, 'no caller line');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
