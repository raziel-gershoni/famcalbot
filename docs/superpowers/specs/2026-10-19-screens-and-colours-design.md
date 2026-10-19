# Calendar colours in the home, and every screen in the home's design

Status: approved by the owner on 2026-10-19 (the mockups, and §6's defaults). The scope survey and the owner's decisions from 2026-10-17 are summarised in §1. Mockups: https://claude.ai/artifact/KJQjWZ7MFRRCr3A4raAQos. H1's plan: `docs/superpowers/plans/2026-10-19-calendar-colours-H1.md`; §3 reads as built.

## 1. Decisions already made (owner, 2026-10-17/18)

- **Hybrid split.** Pure design work covers:
  - Settings, Subscription, Feedback and share-story;
  - PageGate's loader and gate cards, one shared "Missing parameter" card, and `app/[locale]/not-found.tsx`;
  - Partner (`/pair`) and Invite;
  - the admin panel, last and lean.

  Select calendars, refresh-token, the Google result pages and Calendars get the new design inside the later "Google as a connection" spec, which rebuilds those screens anyway.
- **Defaults:**
  - the public website is out;
  - each screen ships to everyone as it lands, then the rollout switch moves to `ALL` soon;
  - system font;
  - themed native selects;
  - Settings saves through an explicit Save in a sticky bottom bar;
  - no new green ("Current" is an accent chip);
  - refresh-token's MainButton is dropped.
- **Added 2026-10-18:** draw each calendar's own colour in the home (H1). "Everything is black, but Google calendars each have a colour."
- From F1 on, any feature that touches a screen uses the shared layer.

## 2. Order

1. **Mockup review** (this round).
2. **H1, calendar colours.** It touches only the home and the reader, so it can land first.
3. **F1, the shared design layer.** No visual change.
4. **W1:** Settings, Subscription, Feedback, share-story and the gate cards.
5. **W3:** Partner and Invite.
6. **A:** the admin panel.

Each is its own plan, drafted, verified on a scratch copy, reviewed and landed as Plans B–E were.

## 3. H1: calendar colours in the home

### 3.1 Data

- The DTO already carries `calendar.color` (`src/lib/calendar-view/types.ts`, `CalendarDTO.color`, `ItemDTO.calendar.color`).
  - FamCal calendars carry their own colour from `NativeCalendar`.
  - Google calendars carry the colour saved when the user chose them (`SelectCalendarsClient.tsx:179`, Google's `backgroundColor`, else `#4285f4`).
- **The gap:** assignments saved before that code have no colour, and a colour changed later in Google never reaches FamCal.
- **The fix:** every live read the range route makes (`'use'` / `'refresh'`: a miss, a stale entry's refresh, or a read with Redis down) also asks `calendarList.list` (fields `items(id,backgroundColor)`, `maxResults: 250`, `showHidden: true`), in parallel with the event lists.
  - Only the chosen calendars' colours are kept, and only `#rrggbb` (lower-cased).
  - They go into that read's cache entry (`colours`), so a hit joins the colours its read got, and they die with the entry (3–30 minutes, or a stamp). An entry without them (written before H1, or after the call failed) joins the saved colours. *(Ruling, H1: the entry instead of a per-user `gcal:colors:v1` key with a 6-hour TTL. There is no new key or TTL, a colour changed in Google shows within the entry's life rather than within 6 hours, and calendar ids reach no new place.)*
  - The calendar's ref takes the live colour, then the saved one, then `null`.
  - A failed or slow list call (it shares the read's deadline and abort signal) drops back to the saved colour and never fails the read. A failure is a console warning, not a Sentry event. A call still waiting holds the read to its deadline at most, as a list would.
  - Summary reads (`'bypass'`) are unchanged: they never ask, never touch Redis and have no use for colour.
- **Per-event `colorId` stays ignored** (spec 2026-10-16 §2.5).
- **Open, for the device check:** the API's `backgroundColor` uses Google's older palette, which can look paler than Google Calendar's own app. If the owner sees a mismatch on the phone, a follow-up maps the 24 calendar colorIds to Google's current palette.

### 3.2 Tones

`calendarTones(hex, theme)` is a pure function in `src/lib/calendar-view/colours.ts` with no imports. From a calendar colour it returns `{ fill, text, line }`:

- **light:**
    - `fill` is the colour mixed 28% into the ground (`#ffffff`);
  - `text` is the colour darkened until it reaches 4.5:1 on `fill` and on every light ground;
  - `line` is the colour darkened until it reaches 3:1 on every light ground.
- **dark:**
  - `fill` is the colour mixed 30% into the dark ground (`#15151d`);
  - `text` is the colour lightened until it reaches 4.5:1 on `fill` and on every dark ground;
  - `line` is the colour lightened until it reaches 3:1 on every dark ground.

Darkening and lightening move only the HSL lightness, so the hue and saturation stay: a pastel blue's text is a deep blue, not a grey. The grounds are the home's page, section, surface and card, and Telegram's common backgrounds (`#efeff4`; at night `#000000`, `#17212b`, `#212121`, `#232e3c`). The "Still open" card is the accent mixed 8% into the page, so each look also lists its bound under any accent: 8% black into white, and 8% white into each dark page. The floors hold inside Telegram too. Contrast is computed with WCAG relative luminance. The function is deterministic and memoised per (hex, theme). Bad input (not `#rrggbb`) returns `null`, and `null` means today's look: the accent for yours and orange for the partner's.

A coloured mark carries both looks' tones as inline custom properties (`calendarVars`: `--cal-{fill,text,line}-{l,d}`) and the class `has-cal`. The theme CSS picks the light or the dark set by the home's `data-theme`, so the theme never enters React and the server's render matches the client's.

### 3.3 Where colour is drawn

**Yours vs the partner's stays readable without colour.** Filled marks are yours, outlined marks are the partner's, and "from {name}" stays on the partner's rows.

| Place | Your item | Partner's item |
|---|---|---|
| Agenda row and picked list | a 4 px stripe at the row's start in `line` | the same stripe hollow (1.5 px `line` border), plus "from {name}" |
| Month chip | `fill` with `text` | the ground with a 1 px `line` border (today's width) and `text` |
| Multi-day bar | as a chip, joined across days (logical radii, so RTL mirrors; the chip keeps the grid's direction and only its title is isolated, in `<bdi>`) | as a chip, outlined |
| Picked dot | filled `line` | a `line` ring |
| Still-open card | the row's stripe | the row's stripe, hollow |
| Item sheet | the swatch as today, plus the calendar's name | the same |

- **Masked partner calendars** (`color: null`) keep today's partner tone.
- **Daily-repeating reminders** stay off the Month (R11).
- The 11 px text floor and 44 px targets are unchanged.

### 3.4 Tests

- **`smoke-calendar-colours`:**
  - `calendarTones` over Google's 24 calendar colours and FamCal's swatches, in both themes;
  - every `text`/`fill` pair is at least 4.5:1 and every `line`/ground pair at least 3:1;
  - bad input returns `null`.
- **Reader:**
  - the live colour wins over the saved one;
  - a failed list call keeps the saved colour;
  - `'bypass'` makes no list call;
  - the colour cache key and TTL.
- **Render:** a row, a chip, a bar, a dot and the still-open card carry the calendar's tones, and a `null` colour gives today's tones.
- **Device check:** colours next to Google Calendar's app, in light and dark.

## 4. F1: the shared design layer (no visual change)

- **Move the home's tokens and shared CSS** out of `app/[locale]/dashboard/home-theme.ts` and `home-shell.ts` into `components/app-ui/`, on a `.ch-app` root; the home becomes `ch-app ch-home`.
  - Every `--ch-*` and `ch-*` name is kept.
  - Every token is resolved in light and dark before and after the move, and the two must match.
  - The home smokes that import these files by path are updated in the same commit (render #14, #21, #22; tabs; month browse and picked).
- **AppScreen and ScreenHeader.**
  - AppScreen applies the theme, owns the single BackButton and handles safe areas.
  - ScreenHeader is a title with an optional back button: Telegram's BackButton in Telegram, a flipped in-page icon in a browser.
- **The form kit,** drawn as in the mockups:
  - section labels and grouped cards;
  - list rows with a value and chevron;
  - switch rows (the whole row is the target, `role="switch"`, an off track at 3:1);
  - day chips (44 px, `aria-pressed`, full-day labels);
  - a field and a sticky Save bar;
  - notice, badge, meter, state cards and empty states;
  - BottomSheet, moved as it is (with E's focus trap).

  Shared strings (Back, Close, Retry, Save, Saved) go in a `ui` namespace in en, he and ru.
- **PageGate and the error screens:**
  - PageGate gets a third look, `'app'`;
  - one "Missing parameter" card replaces the 7 copies, and the 4 page notices use the same card;
  - `app/[locale]/not-found.tsx` is built on that card.
- **Deletions:** LoadingButton is deleted, since nothing imports it.
- **`smoke-app-ui`:**
  - a CSS lint: 11 px and 44 px floors, logical properties, no `:hover`, no hex in screen CSS;
  - contrast in light, dark and real Telegram themes;
  - `renderToString` in en, he and ru;
  - BackButton and sheet focus checks on the fake DOM.
- **What stays:** the old `DashboardClient`, `TelegramLayout`, `Header`, `Section` and `CategoryIcon`, which the fallback home shares, until the `ALL` cleanup.

## 5. W1, W3 and A in brief

Each screen follows the same steps:
1. Write a render smoke first.
2. Move the screen onto AppScreen and the kit, dropping TelegramLayout, Header and styled-jsx.
3. Set its PageGate look to `'app'`.
4. Rewrite its copy in en, he and ru: natural, with gender-neutral Hebrew.
5. Update the smokes that pin it, in the same commit.

The screens:
- **Settings:** the mockup's grouped rows, switch rows, 44 px day chips and Save bar. Save stays on the page, with an inline "Saved" or error, and navigates only when the language changes.
- **Subscription:** the mockup's current-plan card with meters, and plan cards with Stars prices. The upgrade request and the prices stay exactly as they are.
- **Feedback, share-story and the gate cards:** these are small.
- **Partner and Invite:** headers, a copy-link field, a confirm sheet for unlink, and their about 120 strings moved into messages.
- **The admin panel:** split the file first with no visual change, then the shell and switches, then the lists.

## 6. Questions for the owner (with the default)

Answered on 2026-10-19: all four defaults.

1. **Colour rule:** filled for yours, outlined for the partner's, with the calendar's colour on both. (Default: yes, as in the mockups.)
2. **Agenda rows:** a colour stripe at the start, not a tinted row background. (Default: the stripe; a tinted background makes long lists heavy.)
3. **Settings:** a list row with a value and chevron opening a choice sheet, or themed native selects. (Default: native selects as decided; the mockup shows the rows that would open them.)
4. **Subscription:** a Basic card outlined, and Pro highlighted with a filled button. (Default: as shown.)
