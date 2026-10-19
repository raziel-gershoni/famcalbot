# H1: Calendar Colours in the Home — Implementation Plan

> Executed natively (the owner is near weekly usage limits), then reviewed by a multi-agent workflow over the whole diff. The code lives in the branch's commits; this plan records the shape, the rulings and the checks.

**Goal:** draw each calendar's own colour in the calendar home: Agenda rows, the "Still open" card, Month chips and multi-day bars, and picked's dots. Yours vs the partner's stays readable without colour.

**Architecture:**
- The reader's range-route reads ask Google's calendarList for the chosen calendars' live colours and keep them in the cache entry.
- A pure tone function turns each colour into contrast-safe fill, text and line tones for both looks.
- Each mark carries those tones as inline custom properties, plus the class `has-cal`; the theme CSS picks the light or dark set.

**Tech stack:** Next.js 16, React 19, @googleapis/calendar, Upstash Redis, tsx smoke scripts.

**Spec:** `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` §3.

## Global constraints

- Text reaches 4.5:1 on what it sits on, and marks reach 3:1 (spec §3.2).
- Filled marks are yours and outlined marks the partner's; the partner's rows keep "from {name}" (§3.3).
- `null` or a bad colour gives today's look.
- Masked partner calendars keep today's partner tone.
- Summary reads (`'bypass'`) never ask calendarList and never touch Redis.
- Per-event `colorId` stays ignored.
- No text under 11 px, no tap target under 44 px, logical properties only, no `:hover`.

## Files

| File | Change |
|---|---|
| `src/lib/calendar-view/colours.ts` (new) | `calendarTones(hex, theme)`, `calendarVars(hex)`, `contrast`, `toneGrounds` |
| `src/services/calendar-read/google.ts` | `listColours`; `colours` option and result; refs prefer the live colour; the entry keeps `colours` |
| `src/lib/calendar-view/month.ts` | `MonthSlot.color`; `dots: MonthDot[]`; `limitDots` generic |
| `app/[locale]/dashboard/ItemRow.tsx` | `calendarMark`, `CalendarStripe`; each row starts with its stripe |
| `app/[locale]/dashboard/StillOpenCard.tsx` | the card's rows get the stripe |
| `app/[locale]/dashboard/MonthBrowse.tsx` | chips and bars carry `has-cal` and the tones; the `has-cal` rules |
| `app/[locale]/dashboard/MonthPicked.tsx` | dots carry `has-cal` and the tones; the `has-cal` rules |
| `app/[locale]/dashboard/AgendaView.tsx` | `.ch-stripe` rules |
| `app/[locale]/dashboard/home-theme.ts` | `.has-cal` picks `--cal-{fill,text,line}` by `data-theme` |
| `scripts/smoke-calendar-colours.ts` (new) | the tones, the vars, the CSS |
| `scripts/smoke-calendar-read-google-cache.ts`, `-cancel.ts` | colours on the reader's reads |
| `scripts/smoke-calendar-month.ts`, `-month-browse.ts`, `-month-picked.ts`, `-home-render.ts` | the model's colours, and the marks in the markup |

## Tasks

### Task 1: The reader's live colours (spec §3.1)

**What changes:** `readGoogle` builds its live options with `colours: true` for `'use'` and `'refresh'`, including the read made when Redis is down. `readGoogleUncached` then starts `listColours` beside the event lists, under the same deadline and cancel:
- `listColours` makes one page of calendarList: 250 entries, hidden calendars included, ids and colours only, the lists' timeout and one retry.
- It keeps only the set's `#rrggbb` colours, lower-cased.
- A failure is a console warning and `undefined`.
- An answer after the deadline changes nothing.

The calendar refs take the live colour, then the saved one, then `null`, via `googleCalendarRef(a, goneIds, colours)`, `attachGoogleCalendars` and `readOf`.

`afterRead` writes `colours` into the entry, and `fromEntry` joins with them. `entryValue` drops colours it can't read without dropping the entry.

**Tests:** cache smoke, "colours:" ×6:
- the call's parameters;
- live beats saved, saved beats nothing;
- the set's colours only;
- a hit makes no call, and a stale refresh asks again and writes;
- failed or odd colours keep the saved ones, with no Sentry event;
- unreadable entry colours;
- a hanging call holds the read to the deadline at most;
- bypass never asks, and Redis down still asks.

The cancel smoke runs the real client: the calendarList request carries the signal and the lists' timeout, and one still waiting at the deadline is aborted.

### Task 2: The tones (spec §3.2)

**What changes:** `calendarTones` mixes the fill into the ground at 28% (light, `#ffffff`) or 30% (dark, `#15151d`). The text and the line move only their HSL lightness until they reach their floors on the fill and on every ground. The search stops at black or white, which always pass. Results are memoised and frozen.

`calendarVars` returns the six custom properties for both looks, one frozen object per colour.

**Tests:** `smoke-calendar-colours`:
1. the floors over Google's 24 colours, FamCal's and the fixtures' colours, and extremes;
2. the fill mix;
3. the hue is kept, and the tone moves the right way;
4. strong colours are kept as they are;
5. bad input, case and memoising;
6. the vars;
7. the CSS mapping, where only `has-cal` rules read `--cal-*`;
8. the floors over a 4,096-colour grid.

### Task 3: The marks (spec §3.3)

**What changes:**
- **Stripe:** `CalendarStripe` is a 4 px stripe, full height, at the row's start. It is solid for yours and hollow (`is-partner`, 1.5 px) for the partner's. Without a colour it uses `--ch-dot-mine` / `--ch-dot-partner`. ItemRow and the "Still open" rows render it.
- **Month model:** slots carry `color`; spacers carry `null`. `dots` are `{ mine, color }`.
- **Chips and bars:** with `has-cal`, yours are `--cal-fill` under `--cal-text`, and the partner's are `--ch-bg` with a `--cal-line` border and `--cal-text`. Bars keep their logical-radius joins.
- **Dots:** filled `--cal-line`, or a `--cal-line` ring.
- **Item sheet:** unchanged. It already shows the swatch and the calendar's name.

**Tests:**
- month model: every slot's colour is its item's calendar colour, spacers have none, and the dots follow;
- browse #26: chips and bars carry their calendar's vars, and masked or bad colours keep E4's look;
- picked #14: the same for dots;
- render #61: stripes on every row, solid, hollow or plain, and in the card.

The pinned-markup checks (browse #4, picked #5/#6/#9/#12, render #14) were updated to the new markup.

## Rulings

1. **The colours live in the cache entry, not in a per-user `gcal:colors:v1` key.**
   - *Why:* there is no new key or TTL, a colour change shows within the entry's life (≤ 30 minutes), not 6 hours, and they die with a stamp.
   - *If wrong:* a calendarList failure leaves the saved colours for one entry's life.
2. **Partner chips keep today's 1 px border, not 1.5 px.**
   - *Why:* 16 px chips with a 1.5 px border clip the 14 px line.
   - *If wrong:* a hair-thinner outline.
3. **Your all-day items and bars use the calendar's fill, like timed ones, as in the mockups.** Without a colour they keep E4's solid fill.
4. **A failed calendarList is a console warning, not Sentry.**
   - *Why:* a cosmetic miss would be an event per read.
   - *If wrong:* a systematic failure goes unseen until someone notices saved colours.
5. **The colour call is inside the read's `Promise.all`, bounded by the deadline,** as the spec says, rather than given a separate grace.
   - *If wrong:* a calendarList hang slows the home to its deadline. calendarList and events.list share Google's front end, so it is rare.
6. **The theme never enters React.** Both looks' tones go inline and CSS picks by `data-theme`, so server and client markup agree.

## Review focus

1. A Google colour the user changed: it appears after the entry goes stale (≤ 30 minutes), or at once with ⋯ → Refresh (`fresh=1`).
2. A Telegram theme whose background isn't in the grounds list: the floors hold for the listed grounds only. The device check compares light and dark against Google Calendar's app.
3. RTL: bars join with logical radii, and the stripe sits at the inline start.
4. A partner's item on a masked calendar (`color: null`): the stripe is hollow orange, and chips and dots keep E4's look.
5. A user with more than 250 calendarList entries: a chosen calendar past the first page keeps its saved colour.

## Verification

- All smokes under UTC and Asia/Jerusalem; the colour, Month, render and cache smokes also under Pacific/Kiritimati.
- `tsc --noEmit`, lint, and i18n parity (no new strings).
- A fresh-clone build on Node 22.
