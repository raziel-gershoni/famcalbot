# Public website (famcal.bot) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For the look of the landing (Task 4) also invoke the `frontend-design:frontend-design` skill before writing its CSS.

**Goal:** the public pages describe FamCal as it is today, in the visitor's language, in the app's own look (light and dark), with a working phone menu, equal Telegram and WhatsApp start buttons, true Privacy and Terms, and clean SEO — as the approved spec says.

**Architecture:** the `[locale]` tree splits into two root layouts by route group: `(site)` for the public pages (zoom allowed, no Telegram script, only the site's messages, `color-scheme`) and `(app)` for the Mini App pages (today's layout unchanged, plus `noindex`). URLs don't change. The site gets one stylesheet built from the same token values as the app's `theme.ts` (moved into one shared module both read), its own chrome (header with a phone menu sheet, footer), and a landing whose hero shows the real app parts (the bot's confirm card, the home's Agenda, a reminder ping) rendered on the server with sample data.

**Tech Stack:** Next.js 16 app router, next-intl (`createNavigation`, `getTranslations`, `t.rich`), `next/og` for share images, lucide icons, the app's `--ch-*` token values, smoke scripts with `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-10-28-public-website-design.md` (approved 2026-10-28; §10 holds the owner's answers). Inputs prepared for this plan:
- the copy deck in en/he/ru with proposed keys: `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/web/copy-deck.md` (reviewed by the controller before Task 1 starts; use its final text verbatim);
- the Privacy and Terms English text: `.../scratchpad/web/legal-draft-en.md` (the owner reads it first; the controller hands the approved text and its he/ru versions to Task 5);
- the facts behind both: `.../scratchpad/web/{product,channels,channels-verify,data,data-verify,sitetech,copy}.md`.

## Global Constraints

- Every public statement is true of the code today (spec §4 truth list). A smoke keeps out, in every public string and language: "never stored" and its he/ru forms, "full feature parity", Google as a required step, OpenAI, OpenWeatherMap, "early access" and its he/ru forms; and the site says nothing about events by zman, typed events, two-way Google sync, WhatsApp reminders, WhatsApp photo capture, auto-renewal or a scheduled weekly summary.
- Strings only in `messages/{en,he,ru}.json` (namespaces `site`, `landing`, `legal.privacy`, `legal.terms`, plus existing keys reused); the layout's hardcoded titles, keywords and JSON-LD move there too; `howItWorksPage` keys are deleted with the page. Hebrew gender-neutral toward the reader, Russian formal; the share page's message templates keep their informal Russian, exempted by name in `smoke-ru-formal.ts` with that reason; quoted dialogue in «…» stays exempt. `smoke-ru-formal.ts` drops its `landing` exemption and `smoke-he-neutral.ts` its `landing`/`howItWorksPage` ones.
- The look: the app's token values (`components/app-ui/theme.ts`) moved into one shared module that the app theme and the site stylesheet both read; light and dark from `prefers-color-scheme` in CSS only (no JS theme switch); the system font stack (the Google Fonts link goes); lucide icons, no emoji anywhere on the site; text 4.5:1 and large text 3:1 in both themes, including the brand buttons (today's #25D366 and #0088cc fail with white text: pick passing shades); one motion only (the hero's voice-note → card → event sequence, once, skipped under `prefers-reduced-motion`); nothing depends on hover; no horizontal overflow at 320 px; every tap target 44 px.
- The two start buttons share one class list (same size and weight), Telegram first in reading order, stacked on a phone, with the honest line under them.
- `const WA_PHONE` keeps its literal form wherever the landing defines it (`scripts/smoke-miniapp-gate.ts` reads it); if the file moves, that smoke's path moves with it.
- `AppScreen` stays off the site (it repaints `html`, sizes to Telegram's viewport and runs Telegram hooks).
- Internal links through next-intl's `createNavigation` helpers (English unprefixed as `localePrefix: 'as-needed'` intends; no link to a redirect). One shared site-URL constant (`https://famcal.bot`) for the layout, sitemap, robots, JSON-LD and the share page.
- The Mini App must keep working exactly as today: the `(app)` layout keeps the Telegram script `beforeInteractive`, no zoom, the iOS 16 px input rule, `touch-action: manipulation`, and the full messages. Every Mini App page smoke keeps passing; a new check pins the script and the viewport in the `(app)` layout.
- Smokes with the fake env only (`bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/<file>.ts`; suite `bash scripts/ci-smokes.sh`); never `npm run build` (it migrates prod) — `npx next build` and the CI mirror (`.../scratchpad/ci-local.sh <sha>`) are fine and required after the layout split. Textual message edits; mutation checks; local commits with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31`; never push.

## Review Focus

1. A phone visitor in Hebrew, dark mode, 320 px wide: the menu sheet opens and closes (Escape, the close button, a tap outside), the language switch lands on the same page in the other language, the start buttons work, nothing overflows.
2. A Mini App page after the split (the home, Settings, the admin panel) inside Telegram: the Telegram script still loads before the app, the page can't zoom, and a full page load between the site and the app works.
3. An English visitor at `/` and `/how-it-works`: no redirect chain, `/how-it-works` lands on `/#how`; `/he/how-it-works` on `/he#how`.
4. A visitor with JavaScript off: the landing, the plans, the blog and the legal pages render fully (server-rendered), only the hero's motion is missing.
5. The plans section when `PLAN_CONFIGS` changes a number or a limit becomes `Infinity`: the card follows, "Unlimited" comes from messages, nothing serialises `Infinity`.

---

### Task 1: Words

Paste the copy deck's final text into `messages/{en,he,ru}.json` (`site.*`, `landing.*`; landing rewritten, old landing keys not in the deck deleted once unread), the blog post fixes into `content/blog/why-i-built-famcal/{en,he,ru}.mdx`, the share page fixes into `share.*`. Delete `howItWorksPage.*` when Task 5 deletes the page. Update the two copy guards' exemptions as the Global Constraints say. Commit `feat(site): the site's words, true and in natural Hebrew and formal Russian`.

### Task 2: Foundation — the split, the tokens, links

- Move the public pages (`page.tsx`, `LandingClient.tsx`, `how-it-works`, `privacy`, `terms`, `blog`, `share`) into `app/[locale]/(site)/` and every Mini App page and `PageGate.tsx`, `not-found.tsx`, `[...rest]` into `app/[locale]/(app)/`; replace `app/[locale]/layout.tsx` with the two root layouts (read Next 16's rules for multiple root layouts and confirm with `npx next build`; `app/(connect)` from W4-3 is a third root and stays as it is).
- The `(site)` layout: `<html lang dir>`, viewport allowing zoom, `color-scheme: light dark`, no Telegram script, no Google Fonts, `NextIntlClientProvider` with only `site`, `landing`, `legal`, `blog`, `share` (and what the live parts read), and the site stylesheet.
- The `(app)` layout: today's layout as it is (script, viewport, the input/zoom rules, full messages), plus `robots: { index: false }` metadata.
- The shared token module (e.g. `src/lib/design-tokens.ts` or `components/app-ui/tokens.ts`): the light and dark values `theme.ts` uses today, read by `theme.ts` (no visual change in the app: prove it with the app smokes and a screenshot of the home before/after) and by the site stylesheet.
- `i18n/navigation.ts` with `createNavigation(routing)`; the site constant; `WA_PHONE` literal kept.
- Smokes: update every smoke that reads `app/[locale]/layout.tsx` or a moved page's path (grep `scripts/` for the paths); add checks: the `(app)` layout has the Telegram script `beforeInteractive`, `userScalable: false`, the input rule and noindex; the `(site)` layout has none of the script, allows zoom, has no Google Fonts link and passes only the site namespaces. CI mirror green. Commit in steps (`refactor(site): …`).

### Task 3: Chrome

- `SiteHeader` rebuilt: logo; links How it works (`#how`), Plans (`#plans`), Blog; the language switcher (same page in the other language, via the navigation helpers); on a wide screen two compact equal start buttons; on a phone a menu button opening a sheet (links + switcher; Escape, close button and outside tap close it; focus moves into it and back) and one Start button that jumps to the start section. Room in the header for a later "Sign in" (nothing built).
- `Footer` rebuilt: links How it works, Plans, Blog, Privacy, Terms, Contact (the bot's feedback link as today), the switcher, "Made in Israel" (no emoji), the copyright years.
- Smokes: render in en/he/ru: links' hrefs (unprefixed English), the switcher's targets, the menu sheet's open/close and focus, 44 px targets (CSS), no emoji, RTL mirroring. Commit `feat(site): header with a phone menu, and footer`.

### Task 4: The landing

Invoke `frontend-design:frontend-design` first: the brief is the spec's §3.2 and §5 (tokens fixed: the app's; layout, type scale and the hero composition are the design work). Build the sections in the spec's order — hero (headline, line, the two buttons and the honest line, and the live parts), How it works (`id="how"`, three steps), What it does (six groups, lucide icon per item), Telegram or WhatsApp (two columns from the channel matrix + the linking line), Plans (`id="plans"`, cards from `PLAN_CONFIGS` and `TRIAL_DURATION_DAYS`, prices in Stars formatted for the locale, bullets from messages, "Unlimited" from messages, the terms notes, never early access), From the founder (short, link to the post), Start again (`id="start"`, the two buttons).
- Live parts, server-rendered in the visitor's language and theme with made-up sample people per language: the bot's confirm card as an HTML chat bubble in the bot's real words (keys the copy deck names), the home's Agenda via the real `AgendaView` (or its static markup if the client bundle grows: measure the landing's JS before and after and say the numbers in the report), a reminder ping with Done and Snooze. One motion: the voice note → card → event sequence, once, none under reduced motion.
- The page is static (no server reads beyond `PLAN_CONFIGS`); no early-access read.
- Smokes: each section and anchor in en/he/ru; both start buttons with one class list and the honest line; plan numbers equal `PLAN_CONFIGS` (change a number in a fake to prove it follows) and `Infinity` → "Unlimited"; sample names are not from the real users' fixture list and are per language; the truth list over the rendered HTML; contrast of every site token pair in both themes with the kit's contrast helper; no `@media (hover` rule that hides content; `prefers-reduced-motion` stops the animation; no overflow at 320 px (screenshot). Commit `feat(site): the landing`.

### Task 5: The other pages

- `/how-it-works` → permanent redirect to `/#how` in the same language (`/he/how-it-works` → `/he#how`); delete the page and `howItWorksPage.*`.
- Blog index and post in the new chrome with the article type in the app's tokens; the fixed lines; the end-of-post call to action = the two buttons.
- Privacy and Terms from `legal.privacy.*` / `legal.terms.*` (the owner-approved text the controller provides, with its he/ru), headings and lists from messages, a real "Last updated" date; contact as the spec §10.1 says (privacy@famcal.bot from Nov 1, the bot's /feedback until then). **Do not commit the legal texts until the controller says the owner approved them**; build the pages against placeholder keys first if needed and swap.
- `/share` in the new chrome with its stale lines fixed.
- Smokes: each page renders in en/he/ru; the redirect per language; the truth list; legal pages have the sections the spec §7 lists. Commit per page.

### Task 6: SEO

- Per page and language: canonical, `alternates` with `x-default`, title and description from messages, a per-language share image with `next/og` (`opengraph-image.tsx`).
- `app/sitemap.ts`: unprefixed English URLs plus `/he`, `/ru`; Privacy and Terms added; how-it-works gone; `lastModified` a real date (the content's or a build constant), not `new Date()`.
- `app/robots.ts`: drop `/admin`; keep the API and connect paths.
- JSON-LD localised and true (from messages), the Organization block kept.
- Smokes: the sitemap has no redirecting or prefixed-English URL; every page has a canonical and `x-default`; robots has no `/admin`; the `(app)` layout's noindex; the og image route answers per language. Commit `feat(site): SEO`.

### Task 7: Guards and docs

- `scripts/smoke-site-truth.ts` (the truth list + no early access + no emoji + no hardcoded user-facing string in the site's TSX, over messages and rendered pages); the copy guards without their old exemptions; the i18n parity check.
- Screenshots (`.../scratchpad/site-shots/`): the landing in en light 1280 and 360, he dark 360, ru light 360; the menu sheet open he dark; plans; privacy en; blog post ru dark.
- Update the spec's status line and README's site section if it describes the old site. Commit `docs(site): …`.
