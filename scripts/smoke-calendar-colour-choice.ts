// Smoke test for calendar colours (colour change, 2026-10-24): src/lib/calendar-colours.ts.
//
// - Google's classic calendar colours map to the colours Google's app shows; a hex that is
//   not in the table (a custom colour) passes through; mapping twice changes nothing more.
// - FamCal's palette has no duplicates and every pair is at least 15 apart (CIEDE2000, on
//   the line tones calendarTones draws) in the light and the dark look.
// - The auto-pick avoids the Google and partner colours on screen, breaks ties by palette
//   order, and a longer palette is picked from without other changes.
// - The display nudge separates a FamCal colour that collides with a Google one (and two
//   FamCal ones), never moves a Google colour, never changes its input, and gives the same
//   answer every time and for any input order.
// Pure: no network, no DB, no React.
//
//   npx tsx scripts/smoke-calendar-colour-choice.ts

import {
  CALENDAR_PALETTE,
  GOOGLE_COLOUR_TABLE,
  MIN_DELTA_E,
  displayColours,
  displayDistance,
  lookDistance,
  mapGoogleColour,
  pickCalendarColour,
  type VisibleCalendar,
} from '../src/lib/calendar-colours';

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

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const LOOKS = ['light', 'dark'] as const;

async function main() {
  await check('Google: known classic hexes map to the current colours (Cobalt, Peacock, Basil, Banana, Wisteria)', () => {
    assert(mapGoogleColour('#9fc6e7') === '#4285f4', `Cobalt: ${mapGoogleColour('#9fc6e7')}`);
    assert(mapGoogleColour('#9FE1E7') === '#039be5', 'Peacock, upper case in');
    assert(mapGoogleColour('#16a765') === '#0b8043', 'Basil');
    assert(mapGoogleColour('#fad165') === '#f6bf26', 'Banana');
    assert(mapGoogleColour('#b99aff') === '#b39ddb', 'Wisteria');
  });

  await check('Google: the table has the 24 colours, each to a different current colour, and mapping twice changes nothing', () => {
    const keys = Object.keys(GOOGLE_COLOUR_TABLE);
    assert(keys.length === 24, `${keys.length} entries`);
    assert(new Set(Object.values(GOOGLE_COLOUR_TABLE)).size === 24, 'two classics share a current colour');
    for (const k of keys) {
      const once = mapGoogleColour(k);
      assert(mapGoogleColour(once) === once, `${k} maps again: ${once} -> ${mapGoogleColour(once)}`);
    }
  });

  await check('Google: a hex that is not in the table passes through (lower-cased), and a non-hex is left alone', () => {
    assert(mapGoogleColour('#123ABC') === '#123abc', 'custom colour');
    assert(mapGoogleColour('#ff00ff') === '#ff00ff', 'custom colour, lower case');
    assert(mapGoogleColour('red') === 'red', 'a name');
    assert(mapGoogleColour(null) === null && mapGoogleColour(undefined) === null, 'null');
  });

  await check('palette: 8 colours, no duplicates, all #rrggbb', () => {
    const hexes = CALENDAR_PALETTE.map((c) => c.hex.toLowerCase());
    assert(hexes.length === 8, `${hexes.length} colours`);
    assert(new Set(hexes).size === hexes.length, 'duplicate colour');
    assert(new Set(CALENDAR_PALETTE.map((c) => c.name)).size === hexes.length, 'duplicate name');
    for (const h of hexes) assert(/^#[0-9a-f]{6}$/.test(h), `not a hex: ${h}`);
  });

  await check(`palette: every pair is at least ${MIN_DELTA_E} apart in the light and the dark look`, () => {
    for (const theme of LOOKS) {
      let worst = Infinity;
      let which = '';
      for (let i = 0; i < CALENDAR_PALETTE.length; i++) {
        for (let j = i + 1; j < CALENDAR_PALETTE.length; j++) {
          const d = lookDistance(CALENDAR_PALETTE[i].hex, CALENDAR_PALETTE[j].hex, theme);
          if (d < worst) {
            worst = d;
            which = `${CALENDAR_PALETTE[i].name}/${CALENDAR_PALETTE[j].name}`;
          }
        }
      }
      console.log(`  ${theme}: worst pair ${which} dE ${worst.toFixed(1)}`);
      assert(worst >= MIN_DELTA_E, `${theme}: ${which} is ${worst.toFixed(1)}`);
    }
  });

  // A family's screen: Google primary (Cobalt), spouse (Peacock), kids (Wisteria), holidays (Basil), birthdays (Banana), as Google's app shows them.
  const googleOnScreen = ['#9fc6e7', '#9fe1e7', '#b99aff', '#16a765', '#fad165'].map(mapGoogleColour);

  await check('auto-pick: an empty screen takes the first palette colour', () => {
    assert(pickCalendarColour([]) === CALENDAR_PALETTE[0].hex, pickCalendarColour([]));
  });

  await check('auto-pick: avoids the Google colours on screen (and takes the farthest one)', () => {
    const picked = pickCalendarColour(googleOnScreen);
    for (const g of googleOnScreen) assert(displayDistance(picked, g!) >= MIN_DELTA_E, `${picked} is ${displayDistance(picked, g!).toFixed(1)} from ${g}`);
    assert(picked !== '#039be5' && picked !== '#0b8043' && picked !== '#b39ddb', `picked a colour already shown: ${picked}`);
    for (const { hex } of CALENDAR_PALETTE) {
      const mine = Math.min(...googleOnScreen.map((g) => displayDistance(picked, g!)));
      const other = Math.min(...googleOnScreen.map((g) => displayDistance(hex, g!)));
      assert(mine >= other, `${hex} is farther (${other.toFixed(1)}) than the pick ${picked} (${mine.toFixed(1)})`);
    }
  });

  await check('auto-pick: avoids the partner\'s and the user\'s own FamCal colours too, and never repeats one while the palette has room', () => {
    const screen: string[] = [...googleOnScreen as string[]];
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = pickCalendarColour(screen);
      assert(!screen.includes(p), `picked ${p}, already on screen`);
      picks.push(p);
      screen.push(p); // the next calendar sees this one (a partner's or the user's own)
    }
    assert(new Set(picks).size === 3, picks.join(','));
    const withPartner = pickCalendarColour([...googleOnScreen as string[], '#f4511e']);
    assert(withPartner !== '#f4511e', 'picked the partner\'s colour');
  });

  await check('auto-pick: ties go to the earlier palette entry, and unusable colours count for nothing', () => {
    const two = CALENDAR_PALETTE.slice(0, 2);
    // Both colours are already on screen (distance 0 each): the first wins.
    assert(pickCalendarColour([two[0].hex, two[1].hex], two) === two[0].hex, 'tie');
    assert(pickCalendarColour([null, undefined, 'red', ''], two) === two[0].hex, 'unusable');
  });

  await check('auto-pick: a longer palette needs nothing but more entries', () => {
    const longer = [...CALENDAR_PALETTE, { name: 'Cherry Blossom', hex: '#d81b60' }, { name: 'Pumpkin', hex: '#ef6c00' }];
    assert(pickCalendarColour([], longer) === longer[0].hex, 'first of the longer list');
    const used = CALENDAR_PALETTE.map((c) => c.hex);
    const p = pickCalendarColour(used, longer);
    assert(longer.slice(8).some((c) => c.hex === p), `picked ${p} instead of a new entry`);
  });

  const cal = (id: string, color: string | null, native: boolean): VisibleCalendar => ({ id, color, native });

  await check('nudge: a FamCal colour equal to a Google colour is separated; the Google colour is untouched', () => {
    const input = [cal('g-cobalt', '#4285f4', false), cal('native:a', '#4285f4', true)];
    const out = displayColours(input);
    assert(out.get('g-cobalt') === '#4285f4', `Google moved: ${out.get('g-cobalt')}`);
    const shown = out.get('native:a')!;
    assert(shown !== '#4285f4', 'the FamCal colour did not move');
    assert(displayDistance(shown, '#4285f4') >= MIN_DELTA_E, `still ${displayDistance(shown, '#4285f4').toFixed(1)} apart`);
    for (const theme of LOOKS) console.log(`  ${theme}: #4285f4 vs ${shown} dE ${lookDistance(shown, '#4285f4', theme).toFixed(1)}`);
    assert(input[1].color === '#4285f4', 'the input was changed (the saved colour must not be)');
  });

  await check('nudge: the Peacock default against Google\'s Peacock (the colour the mapping makes identical) is separated', () => {
    const out = displayColours([cal('g', mapGoogleColour('#9fe1e7'), false), cal('native:b', '#039BE5', true)]);
    assert(out.get('g') === '#039be5', 'Google moved');
    assert(displayDistance(out.get('native:b')!, '#039be5') >= MIN_DELTA_E, 'not separated');
  });

  await check('nudge: colours that are already apart are left exactly as saved', () => {
    const input = [cal('g', '#4285f4', false), cal('native:a', '#f4511e', true), cal('native:b', '#0b8043', true)];
    const out = displayColours(input);
    for (const c of input) assert(out.get(c.id) === c.color, `${c.id}: ${c.color} -> ${out.get(c.id)}`);
  });

  await check('nudge: two FamCal calendars of the same colour are separated, one keeps its colour, and no Google colour moves', () => {
    const input = [cal('native:b', '#039be5', true), cal('native:a', '#039be5', true), cal('g', '#f4511e', false)];
    const out = displayColours(input);
    assert(out.get('native:a') === '#039be5', 'the first id moved');
    assert(out.get('native:b') !== '#039be5', 'the second did not move');
    assert(displayDistance(out.get('native:a')!, out.get('native:b')!) >= MIN_DELTA_E, 'the two are still alike');
    assert(displayDistance(out.get('native:b')!, '#f4511e') >= MIN_DELTA_E, 'the shifted one is alike to Google');
    assert(out.get('g') === '#f4511e', 'Google moved');
  });

  await check('nudge: a Google colour is never shifted, even when Google colours collide with each other', () => {
    const out = displayColours([cal('g1', '#4285f4', false), cal('g2', '#4285f4', false), cal('g3', '#4286f5', false)]);
    assert(out.get('g1') === '#4285f4' && out.get('g2') === '#4285f4' && out.get('g3') === '#4286f5', JSON.stringify([...out]));
  });

  await check('nudge: deterministic: the same answer every time and for any order of the input', () => {
    const base = [cal('g1', '#4285f4', false), cal('native:z', '#4285f4', true), cal('native:a', '#4285f4', true), cal('native:m', '#4a8af0', true), cal('g2', null, false)];
    const first = JSON.stringify([...displayColours(base)].sort());
    for (let i = 0; i < 5; i++) assert(JSON.stringify([...displayColours(base)].sort()) === first, 'a second run differs');
    assert(JSON.stringify([...displayColours([...base].reverse())].sort()) === first, 'reversed input differs');
    assert(JSON.stringify([...displayColours([base[2], base[4], base[0], base[3], base[1]])].sort()) === first, 'shuffled input differs');
  });

  await check('nudge: the shift is small (a minimal step), not a different colour', () => {
    const out = displayColours([cal('g', '#4285f4', false), cal('native:a', '#4285f4', true)]);
    const d = lookDistance('#4285f4', out.get('native:a')!, 'light');
    assert(d < 40, `moved ${d.toFixed(1)} away`);
  });

  await check('nudge: a calendar with no usable colour is passed over', () => {
    const out = displayColours([cal('native:a', null, true), cal('native:b', 'red', true), cal('g', '#4285f4', false)]);
    assert(!out.has('native:a') && !out.has('native:b') && out.get('g') === '#4285f4', JSON.stringify([...out]));
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
