# Dependencies: the in-range batch Implementation Plan

> **For agentic workers:** one implementer per task, in order, on one branch; one final whole-branch review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take every update the current version ranges allow (batch B of the 2026-11-10 dependency evaluation), plus lucide-react 1.71 and @types/node 22, with the fixes each one needs, so `npm ci`, tsc, lint, all smokes and `next build` stay green on Node 22.

**Architecture:** No behaviour change for anyone, except the two Hebrew wordings the owner chose (decision 3). Each task moves one group of packages with `npm install <pkg>@<version>` (never a blind `npm update`, never `npm audit fix`: it downgrades the gaxios behind every Calendar call), fixes what that group breaks, and commits.

**Tech Stack:** npm (lockfile v3), Next 16.4.6 (batch A, already on main), TypeScript 5.9, ESLint 9, tsx smokes (`scripts/smoke-*.ts`, run by `scripts/ci-smokes.sh` with fake env only).

**Spec:** the owner-approved dependency evaluation of 2026-11-10 (decisions 1-8, "approved"; kept outside the repo with its research reports and trial logs, paths given to each implementer).

## Global Constraints

- Never run `npm run build` (it migrates the production database); use `npx tsc --noEmit`, `npm run lint`, `bash scripts/ci-smokes.sh` and `npx next build`.
- Never read or print any `.env*` value; grep with `--exclude='.env*'`. Smokes run with fake env only (`bash scripts/ci-smokes.sh` fakes every name; for a single smoke: `env $(sed -nE "s/^  '([A-Z_]+=[^']*)'$/\1/p" scripts/ci-smokes.sh) TZ=Asia/Jerusalem npx tsx scripts/smoke-x.ts`).
- Run every npm command on Node 22: `npx -y node@22 $(command -v npm) …`. Never `npm audit fix`, never `npm update` without a package list.
- Stay inside each package's current major unless this plan names the major (lucide-react 1.x, @types/node 22).
- Keep the exact pins exact (`openid-client`, `web-push` 3.6.7, `@types/web-push` 3.6.4, `@dnd-kit/core`, `@ncdai/react-wheel-picker`, `@openmeteo/file-reader`); keep `overrides` as they are unless a task says otherwise.
- The repo's CLAUDE.md rules hold: one retry policy for Google (`src/services/google-retry.ts`), node-cron without its `timezone` option, `wallTimeToInstant` for wall times, no console line with a place, a name, a token or an email.
- One code path: when several smokes repeat the same loader, move it into one helper in `scripts/lib/`.
- Commit per task, message in the repo's style (`fix(deps): …` / `chore(deps): …`), ending with the session trailer lines.

## Review Focus

1. Hebrew day and month names in Russian and Hebrew on the calendar home, month view and summaries: two `@hebcal/hdate` copies silently switch Russian months to English.
2. The Google smokes must test the client the app really loads (calendar → googleapis-common → google-auth-library → gaxios), not whatever copy npm hoists to the top.
3. A react-hooks lint fix that changes when a screen renders or redirects (Telegram dashboard redirect, refresh-token page, calendars, calendar home) is a behaviour change; none is allowed.
4. Redis: @upstash/redis 1.40 stops decoding base64 answers by default and 1.38 splits mixed read/write auto-pipelines; every read of a stored value must come back the same.
5. Sentry: still errors only (no traces, no sessions, no client reports) after the type fix.

---

### Task 1: Hebrew calendar trio (@hebcal/core, @hebcal/hdate, @hebcal/locales together)

**Files:** package.json, package-lock.json, `scripts/smoke-hebrew-date.ts` (pin check ~473-490), `messages/he.json` (`yomKippur`, `erevYomKippur`, every double-parasha `…Brief` with an ASCII `-`), `src/services/hebrew-holidays.ts:186` (`parashaBrief`), `scripts/smoke-hebrew-holidays.ts:124`, `scripts/smoke-parasha.ts`, `scripts/smoke-holidays-by-place.ts` (its Hebrew hash), and any other smoke the move breaks.

- [ ] `npm install @hebcal/core@^6.16.0 @hebcal/hdate@^0.23.1 @hebcal/locales@^6.5.3` in one command; confirm one copy: `npm ls @hebcal/hdate` shows no nested copy.
- [ ] Owner's decision 3: follow hebcal's wording. `he.json`: "יום כפור" → "יום כיפור", "ערב יום כפור" → "ערב יום כיפור"; double-parasha Hebrew briefs join with the maqaf `־` (U+05BE), e.g. "בהר־בחקתי". `parashaBrief` joins the parts with `־` in Hebrew only (English and Russian keep `-`). Look for every other Hebrew string the app writes for a double parasha (the summaries' prompts, the voice show, the zmanim pages, the API) and make them agree; the voice-show golden (`scripts/fixtures/voice-show-golden.json`) must not change unless a holiday name is in it.
- [ ] `smoke-hebrew-date`: the pin check reads `^0.23.1` and the 0.23.x regex; keep its one-copy checks.
- [ ] Re-pin the hashes and expectations that move only because of the two wordings; check each diff is only those wordings (no time, no date, no other text moves).
- [ ] Run: `smoke-hebrew-date`, `smoke-hebrew-holidays`, `smoke-holidays-by-place`, `smoke-parasha`, `smoke-next-holiday`, `smoke-calendar-month-browse`, `smoke-calendar-month-picked`, `smoke-summary-prompt-parity`, `smoke-zmanim-public-view`, every `smoke-zman*`, `smoke-pause`; then tsc and lint.
- [ ] Commit.

### Task 2: Google smokes, node-cron, Upstash, Sentry

**Files:** package.json, package-lock.json, a new `scripts/lib/google-client-modules.ts` (name as fits), the six Google smokes (`smoke-calendar-move`, `smoke-calendar-read-google-cancel`, `smoke-calendar-read-google`, `smoke-google-map`, `smoke-google-retry`, `smoke-google-write`), `scripts/smoke-dst.ts:101`, `sentry.server.config.ts:14`, Redis readers if needed.

- [ ] `@googleapis/calendar` to the latest 9.x and `@google/genai` to the latest 1.x (1.52.x). Check with `npm ls gaxios google-auth-library googleapis-common` that the calendar's chain keeps gaxios 6.7.x (no downgrade to 6.3.0).
- [ ] The smokes load google-auth-library and gaxios the way the app does: from googleapis-common's own resolution (calendar → googleapis-common → google-auth-library → gaxios), through one helper in `scripts/lib/`, whatever npm hoists. Keep the "more than one gaxios" guard: it must still fail if the app's chain really has two gaxios. All six Google smokes pass.
- [ ] `node-cron@^4.6.0`; `smoke-dst` finds node-cron's CommonJS build through the package's own exports or `require.resolve` (not a hard-coded dist path); keep the no-`timezone` rule and its smoke checks. Run `smoke-dst` (it re-runs itself under three zones).
- [ ] `@upstash/redis@^1.41.0` with `@upstash/ratelimit@^2.2.0` together. Read the 1.38-1.41 changelogs (base64 answer default, auto-pipeline split, any new constructor default) against `src/utils/redis.ts` and `src/services/calendar-read/google.ts:768` and every Redis read of a stored value; set an explicit option only if a default really changes what we read back. Run the Redis, rate-limit and cache smokes.
- [ ] `@sentry/nextjs@10.78.0` (pin the exact version in the caret: `^10.78.0`); fix the type at `sentry.server.config.ts:14` without changing behaviour (errors only, no request sessions); check `src/lib/sentry-errors-only.ts`, `src/lib/sentry-scrub.ts` and the Sentry smokes still pass; `npx next build` must pass (the old error failed it).
- [ ] tsc, lint, `bash scripts/ci-smokes.sh` (all). Commit.

### Task 3: ESLint 9.39.5 + eslint-config-next 16.4.6 and the react-hooks errors

**Files:** package.json, package-lock.json, `app/(connect)/refresh-token/RefreshTokenClient.tsx`, `app/[locale]/(app)/calendars/CalendarsClient.tsx`, `app/[locale]/(app)/dashboard/CalendarHome.tsx`, `app/[locale]/(app)/dashboard/TelegramDashboardRedirect.tsx`, and any other file the new rules flag.

- [ ] `eslint@^9.39.5 eslint-config-next@16.4.6` (eslint-config-next to match next 16.4.6, caret ok). `npm run lint` shows 9 errors (react-hooks 7: `set-state-in-effect` and render-time rules) and 4 warnings (`@next/next/no-location-assign-relative-destination`).
- [ ] Fix every error and warning without changing behaviour: what renders on the first paint, when a redirect fires, what a screen shows while the Telegram SDK loads. Prefer the React-recommended form (lazy initial state, deriving during render, `useSyncExternalStore` for an outside store, setting state in the subscription callback). A line-level `eslint-disable-next-line <rule> -- <reason>` is allowed only where the effect really synchronises with an outside system on mount and the recommended form would change behaviour; say why in the reason. No file-wide disables, no rule turned off in the config.
- [ ] For each changed component, write down in the report what it did before and after for: first render, the SDK-loaded and not-loaded paths, a stale or used link.
- [ ] tsc, lint (0 errors, 0 warnings), the smokes that read these files (grep `scripts/` for their paths). Commit.

### Task 4: the rest, removals, lucide-react 1.71, @types/node 22

**Files:** package.json, package-lock.json, `.prettierrc.json`, `.prettierignore`, any file a type or icon change touches.

- [ ] In range: `react@^19.3.1 react-dom@^19.3.1 @types/react@^19.3.0 @types/react-dom@^19.3.0`; `tailwindcss@^4.3.5 @tailwindcss/postcss@^4.3.5 postcss@^8.5.32` (tailwind 4.3.4+ needs Node ≥ 22.12: confirm `engines` and note the risk in the report); `geo-tz@^8.1.11`; `date-fns@^4.4.0`; `dotenv@^17.4.2`; `tsx@^4.23.15`; `bidi-js@^1.1.0` (spot-check a Hebrew line of the OG image text path: `git grep -n bidi-js` shows where; the smokes that cover it must pass); `openid-client` exact `6.8.9`; `@types/node-telegram-bot-api` latest 0.64.x; transitive `protobufjs` and `ws` to their patched versions if a plain `npm install` of the parent range leaves them vulnerable (no `audit fix`).
- [ ] Remove: `prettier` with `.prettierrc.json` and `.prettierignore`; `@types/node-cron` (node-cron 4 ships its own types); `postcss-loader` (a webpack loader; the build is Turbopack and `postcss.config.mjs` uses only `@tailwindcss/postcss`); `@swc/helpers` only if nothing imports or requires it and `next build` passes without it (else bump to ^0.5.24 and say why it stays). Grep each name first (`git grep -n <name> -- ':!package-lock.json'`).
- [ ] Decision 7: `lucide-react@^1.71.0` (every icon the app imports must exist; renamed ones keep their alias or move to the new name; icons now get `aria-hidden` by default: check no icon-only button lost its accessible name, i.e. each has an `aria-label` or visible text) and `@types/node@^22` (matches the runtime; fix any type it flags).
- [ ] tsc, lint, all smokes, `npx next build`. `npm audit` summary into the report (no `fix`). Commit.

### Final review (whole branch)

One reviewer on the most capable model: the whole diff against this plan, the Review Focus list, the repo's CLAUDE.md rules, and `git diff main -- package-lock.json` for anything unexpected (a downgrade, a new install script, a package from an unknown maintainer, a second copy of hdate, gaxios or react).
