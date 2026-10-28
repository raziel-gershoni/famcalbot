# Public website (famcal.bot): the product as it is, in the app's look

Status: approved by the owner, 2026-10-28 (§10 holds the answers). Owner queue item 5. Item 6 (web login, and anonymous access to the calendar and zmanim) is a separate spec after this one; this spec only leaves room for it.

## 1. Why

The public site still describes the old product: Google required, Telegram only, "your calendar data is never stored". Today FamCal has its own calendar (Google is optional), WhatsApp, reminders (including by zman), the Shabbat and Yom Tov pause, the voice show, partner pairing and plans. The site also looks nothing like the app, has no dark mode, has no menu on a phone, and fails contrast in several places. The privacy and terms pages make claims that are false today (§7).

**Goal:** a visitor understands what FamCal does today, in their language, in the app's own look, and starts it on Telegram or WhatsApp. Every claim on the site is true.

**Success:**
- every statement on every public page matches the code (the truth list in §4 holds);
- a phone visitor can navigate, switch language and start the bot;
- light and dark follow the device, and all text passes WCAG AA;
- search engines see one URL per page per language.

## 2. Decisions

The owner's answers on 2026-10-28 ("go with recommendations"):

1. **Audience:** Jewish families first, in every language. Hebrew dates, holidays, zmanim and the Shabbat pause are first-class on the page, not a side section.
2. **Language:** the browser's language decides (next-intl's detection, as today), and the switcher stays. The switcher goes to the same page in the other language.
3. **Look:** the app's own look (the `--ch-*` tokens of `components/app-ui/theme.ts`), light and dark, showing the real app. **Ruling:** "real app screenshots" are built as the real app parts rendered live with sample data (§5.3), not as PNG files. They follow the visitor's language and theme on their own, and they can never fall behind the app.
4. **Pages:**
   - one landing page, which absorbs How it works;
   - a plans section read from `src/config/plans.ts`, with no mention of early access (§3.2.5);
   - the blog is kept;
   - Privacy and Terms are rewritten. I draft them; the owner reads them before they ship.
5. **Calls to action, revised for the owner's doubt** ("in Israel WA is pretty popular"). Two buttons of the **same size and weight**: Telegram, then WhatsApp. They sit side by side, stacked on a phone. Under them is one honest line: reminders, photo capture and paying for a plan are on Telegram for now.
   - Evidence: a WhatsApp-only family gets the briefings, the voice show on request, voice-note events and the calendar in a browser. It gets no reminders, no event alerts, no photo or PDF capture, and no way to pay (`web/channels.md` in the session's notes).
   - Shrinking WhatsApp would hide the channel most Israelis will pick. Hiding the gap would break the truth rule.
   - Telegram goes first only in reading order, as the full product.
6. **Fixed without a decision:**
   - the phone menu and contrast;
   - pinch-zoom on public pages;
   - no `telegram-web-app.js` on public pages;
   - the SEO fixes (§6.4);
   - a share image per language.

## 3. What the visitor sees

### 3.1 Header (every public page)

- **Logo.**
- **Links:** How it works (`#how`), Plans (`#plans`), Blog.
- **Language switcher.**
- **Start control:**
  - On a wide screen, two compact buttons, Telegram and WhatsApp, equal in size.
  - On a phone, the links and the switcher sit behind a menu button that opens a sheet, and one Start button jumps to the start section.
- **Room for item 6:** the header has space for a later "Sign in". Nothing is built for it now.
- **Size:** every tap target is at least 44 px.

### 3.2 Landing (`/`, `/he`, `/ru`)

In order:

1. **Hero.**
   - A headline about the family's day in one place, by voice.
   - A short line under it.
   - The two start buttons and the honest line (§2.5).
   - Beside the text, or under it on a phone: the most characteristic moment of the product. A voice note ("Dentist for Noa on Thursday at four") turns into the bot's confirm card, then into the event on the calendar home. It is built from live app parts (§5.3).
2. **How it works**, three steps:
   - start the bot on Telegram or WhatsApp and pick a language;
   - add things by voice (or a photo of an invitation, on Telegram);
   - get the morning briefing and reminders.

   Google appears only as optional: "already use Google Calendar? connect it".
3. **What it does**, grouped, each item with one plain line and a lucide icon:
   - **Calendar:** FamCal's own calendar, several coloured calendars, partner sharing.
   - **Jewish calendar:** Hebrew dates in letters, holidays and the four national days, repeat on the Hebrew date (birthdays, yahrzeit) with the count, the sun button's day list, reminders by zman for each person's own place, and the Shabbat and Yom Tov pause.
   - **Adding:** voice notes, and on Telegram photos, PDFs and albums.
   - **Reminders:** Done and Snooze, "remind us both", event alerts (Telegram).
   - **Briefings:** the morning and evening summaries, the week on request, weather in context, and the two-host voice show.
   - **Languages:** Hebrew, English, Russian, right to left where needed.

   Only what is built is listed (§4).
4. **Telegram or WhatsApp.** A small two-column comparison of what each channel does today, from the channel matrix. It is the long form of the honest line, and it says that linking WhatsApp to Telegram later keeps everything.
5. **Plans** (`#plans`), read from `PLAN_CONFIGS` and `TRIAL_DURATION_DAYS`:
   - **Cards:**
     - Free: 10 text and 3 voice summaries a month, 3 calendars.
     - Basic: unlimited summaries, 5 calendars.
     - Pro: everything, including reminders, voice, photo and PDF events, Copy to Google, and unlimited calendars.
   - **Price:** in Telegram Stars per month, formatted for the locale.
   - **Terms notes:** a 14-day Pro trial starts by itself, with no card. Monthly, no auto-renew. Paid with Telegram Stars inside Telegram.
   - **No early access** (owner 2026-10-28): the site never mentions early access and never reads the switch. The switch and its code stay in the app.
   - **Wording:** card bullets come from messages, never from `PLAN_CONFIGS[...].features`, which is English-only and stale.
6. **From the founder.** The existing personal story, shortened, linking to the blog post.
7. **Start again.** The two buttons once more, then the footer.

### 3.3 Other pages

- **`/how-it-works`** permanently redirects to `/#how` in the same language.
- **Blog index and post:**
  - the new chrome and the article type in the app's tokens;
  - the post's stale lines are fixed (Google-first, and informal Russian in the narrative);
  - the end-of-post call to action is the two buttons.
- **Privacy, Terms:** the new chrome, with the texts in messages (§7).
- **`/share`:** the new chrome. Its stale copy is fixed (Google-first). Its message templates are what a user sends a friend, so their informal Russian stays. The Russian guard exempts them by name, with that reason.
- **Unchanged:** `/invite/[token]` (already in the app look), share-story, and every Mini App page.

### 3.4 Footer

Links (How it works, Plans, Blog, Privacy, Terms, Contact), the language switcher, "Made in Israel" (no emoji), and the copyright years.

## 4. Words

- **Where the strings live.** All copy is in `messages/{en,he,ru}.json`, under the namespaces the pages read:
  - `site` (chrome);
  - `landing`, rewritten;
  - `legal.privacy` and `legal.terms`.

  The layout's hardcoded titles, keywords and JSON-LD move to messages too. The `howItWorksPage` keys are deleted with the page.
- **Hebrew and Russian voice.** Hebrew is gender-neutral (plural or infinitive calls to action, no "את/ה"), and Russian is formal. Both read as written in that language, not translated. Specific changes:
  - `smoke-ru-formal` drops its `landing` exemption;
  - quoted dialogue in «…» stays exempt;
  - the share templates are exempted by name (§3.3).
- **Truth list.** A smoke keeps these out of every public string in every language:
  - "never stored" and its he/ru forms;
  - "full feature parity";
  - Google as a required step;
  - OpenAI and OpenWeatherMap.

  The site may claim only what §2 of the product facts verified. It says nothing about events by zman, typed events, two-way Google sync, WhatsApp reminders, WhatsApp photo capture, auto-renewal, or a scheduled weekly summary.
- **No early access.** The public pages never say "early access" or its he/ru forms (the truth list's smoke checks it).
- **Sample people** in the live parts are made-up names per language, never a real user.

## 5. Look

The design work is done with the frontend-design skill during the build. These are its fixed inputs.

### 5.1 Tokens and theme

- **One stylesheet** for the public site, built from the same token values as `theme.ts`. Those values move into one shared module that both read, so the site and the app cannot drift.
- **Theme:** light and dark come from `prefers-color-scheme` in CSS. There is no JavaScript theme switch, so a server-rendered page does not flash.
- **Not reused:** `AppScreen` stays off marketing pages, because it repaints `html`, sizes to the Telegram viewport and runs the Telegram hooks.
- **Font:** the app's system stack. The Google Fonts download is dropped. That is faster, and it is one less third party to name in the privacy policy.
- **Icons and emoji:** lucide icons only. No emoji anywhere on the site.

### 5.2 Contrast and motion

- **Contrast:** all text at least 4.5:1 and large text 3:1, in both themes. Brand buttons use shades that pass with white text; today's WhatsApp green (#25D366) and Telegram blue (#0088cc) fail with white text.
- **Motion:** one moment only, the hero's voice-note-to-event sequence. It plays once and is skipped under `prefers-reduced-motion`.
- **Hover:** nothing depends on hover.
- **Layout:** no horizontal overflow at 320 px.

### 5.3 Live app parts

- **What is shown:**
  - the bot's confirm card, as an HTML chat bubble in the bot's real words from messages;
  - the calendar home's Agenda, rendered with the real `AgendaView` and sample data in a phone frame;
  - a reminder ping with Done and Snooze.
- **Rendering:** on the server, in the visitor's language and theme. If a part needs client JavaScript only for interaction, it is rendered without that interaction.
- **Budget:** the landing's client JavaScript stays small. If `AgendaView` pulls in too much, the plan renders it to static markup.

## 6. Structure

### 6.1 Two root layouts

- **The split:** public pages move into the `app/[locale]/(site)` route group with their own root layout, and the Mini App pages into `app/[locale]/(app)`. URLs do not change.
- **The site layout:**
  - allows zoom;
  - loads no Telegram script;
  - passes only the site's namespaces to the client;
  - sets `color-scheme`.
- **The app layout** keeps today's behaviour: the Telegram script `beforeInteractive`, no zoom, and the full messages.
- **Moving between the two** is a full page load, which suits a site-to-app hop. Smokes that read `app/[locale]/layout.tsx` follow the move.

### 6.2 Links and URLs

- **One link helper.** Internal links go through next-intl's navigation helpers (`createNavigation`). English is then unprefixed, as `localePrefix: 'as-needed'` intends, and no link points at a redirect.
- **Site URL.** One shared constant for `https://famcal.bot`, read by the layout, sitemap, robots, JSON-LD and the share page.
- **WhatsApp number.** `const WA_PHONE` keeps its literal form wherever the landing defines it (`smoke-miniapp-gate.ts` reads it). If the landing's file moves, that smoke's path moves with it.

### 6.3 Data on the page

- **Server reads.** The landing reads only `PLAN_CONFIGS` and `TRIAL_DURATION_DAYS` (no imports, safe anywhere), so it can be fully static.
- **"Unlimited".** `Infinity` is rendered as "Unlimited" from messages, never serialised.

### 6.4 SEO

- **Metadata per page and language:**
  - a canonical URL;
  - `alternates` with `x-default`;
  - title and description from messages;
  - a per-language share image made with `next/og` (`opengraph-image.tsx`).
- **Sitemap:** the unprefixed English URLs plus `/he` and `/ru`. Privacy and Terms are added, how-it-works is removed, and `lastModified` is a real date, not "now".
- **Robots and noindex:** robots stops listing the non-existent `/admin`. Every Mini App page gets `noindex` from the app layout.
- **JSON-LD:** localised and true (no "full feature parity"). The Organization block is kept.

## 7. Privacy and Terms

The full facts with file references are in the session notes (`web/data.md`, checked by a second reader in `web/data-verify.md`). The pages say, in plain words:

### 7.1 Privacy

- **Who we are,** and how to contact us (§10.1).
- **What we keep:**
  - your account: Telegram id or WhatsApp number, the name from your profile, language, "Address me as", your place at city level for weather and zmanim, community and settings;
  - your calendar: events, reminders, the family members' names you add, and your notes for the AI. These are stored in our database;
  - the Google connection, if you make one: an encrypted token and the calendars you chose. Google events are held at most 30 minutes to show them, and are not kept;
  - your partner link;
  - your plan and the Telegram Stars payment reference. We never receive card details;
  - feedback you send;
  - an activity log, deleted after 90 days.
- **What we don't keep:**
  - voice notes, read and dropped (on a failed read, held 5 minutes for a retry);
  - photos and PDFs;
  - the generated audio, deleted after sending;
  - your device's location, which is looked up in your browser and never reaches us.
- **Who processes it:**
  - Google Gemini (the AI: voice, photos, PDFs, text, and your events for briefings and the voice show);
  - Telegram;
  - Meta (WhatsApp);
  - Google Calendar (if connected);
  - Neon (database);
  - Upstash (cache);
  - Railway (hosting);
  - Sentry (error reports: your id, first name and technical details);
  - OpenStreetMap Nominatim and Open-Meteo (place, weather, sun times).

  No ads, no analytics, no selling.
- **Your partner** sees the calendars you share and the reminders made for both of you.
- **Cookies:** `famcal_session` (the WhatsApp web login, 24 hours) and `NEXT_LOCALE` (language). Nothing else.
- **Your controls:** Settings, Disconnect Google (which revokes FamCal's access at Google), unlink your partner, turn briefings off, or block the bot. Deleting your account, or getting a copy of your data, is done on request through the contact (§10.1), within 30 days. Deleting also revokes Google access (bug list item: today's admin delete does not).
- **Children:** parents may add their children's names and schedules. Using FamCal needs a Telegram or WhatsApp account, under that app's own age rule (§10.4).
- **Security:** connections are encrypted, and Google tokens are encrypted with AES-256-GCM. Claims about the providers' encryption at rest are stated only if checked in their documentation during the build.

### 7.2 Terms

- **The service:** a Telegram and WhatsApp bot with a web app; Google is optional.
- **Eligibility:** a Telegram or WhatsApp account, which means meeting that app's own age rule where you live (§10.4). FamCal sets no age of its own.
- **Plans:**
  - the Free, Basic and Pro limits;
  - the automatic 14-day Pro trial;
  - monthly, no auto-renew, paid with Telegram Stars;
  - refunds per §10.3, through `/paysupport`.
- **AI output can be wrong:** summaries, voice reading, and computed zmanim (check a halachic time that matters with a reliable source).
- **You are responsible** for the data you add about family members.
- **Fair use:** acceptable use, suspension, liability limits, Israeli law, and contact.

### 7.3 How the texts ship

- They live in messages (`legal.*`), in natural Hebrew and formal Russian.
- They carry a real "last updated" date.
- They ship only after the owner has read the English text in the chat.

## 8. Non-goals

- Web login, and anonymous access to the calendar or zmanim (item 6).
- A self-service "Delete my account" or data export. Requests are handled by the contact for now. A self-service flow is a later decision.
- Closing WhatsApp's feature gaps. The site states them; it doesn't fix them.
- New blog posts, analytics or tracking, a cookie banner (only essential cookies are used), and A/B tests.
- The Mini App pages, including the old Google screens (Calendars, Select calendars, refresh-token, the OAuth pages). Those are a separate redesign (W4).

## 9. Tests

- **Render (all three languages, light and dark CSS present):**
  - the landing, blog, privacy and terms render;
  - both start buttons share one class list and the honest line is present;
  - the plan cards show the numbers from `PLAN_CONFIGS`, and no public string mentions early access;
  - the sample names are not real users.
- **Site layout:**
  - no `telegram-web-app.js`;
  - the viewport allows zoom;
  - only the site namespaces reach the client;
  - no Google Fonts link.
- **SEO:**
  - the sitemap lists unprefixed English and no redirecting URL;
  - every page has a canonical and alternates with `x-default`;
  - robots has no `/admin`;
  - the Mini App layout sets noindex;
  - `/how-it-works` redirects to `/#how` per language.
- **Copy:**
  - the truth list (§4);
  - `smoke-ru-formal` without the landing exemption;
  - the i18n parity check;
  - no emoji in site strings;
  - no hardcoded user-facing string in the site's TSX.
- **Contrast:** every text and button pair of the site's tokens in both themes, with the kit's existing contrast helper.
- **Existing:** `smoke-miniapp-gate` still finds the landing's WhatsApp number.

## 10. Questions for the owner (answers 2026-10-28)

1. **Contact for privacy and legal requests:** the default, set up on Nov 1. `privacy@famcal.bot` through Cloudflare Email Routing (free), forwarding to the owner's inbox; I give the steps that day. Until it receives mail, the pages name the bot's `/feedback`.
2. **Gemini billing:** paid tier. The policy says Google does not use the content to improve its products.
3. **Refunds for Stars:** a refund on request within 14 days of a payment, through `/paysupport`, using Telegram's refund call. This holds while Stars is the way to pay.
4. **Minimum age:** no FamCal age of its own (owner: the default). The terms say a person must meet the age rule of the app they use FamCal through, since Telegram and WhatsApp set their own by country. Children's details are added by their parents.
5. **Early access and payments:** the site doesn't mention early access; plans and Stars prices stay (owner, corrected 2026-10-28). The switch and its code stay in the app; the owner believes it has been off for a while. Payment options beyond Stars are a later research task, not part of this spec.

## 11. Risks

- **The layout split** touches every page's root. A wrong move breaks the Mini App's Telegram start. Each moved page is covered by the existing page smokes and by a check that the app layout still loads the Telegram script `beforeInteractive`.
- **Rendering `AgendaView` on the landing** may pull client code. The plan measures it and falls back to static markup.
- **The early-access switch.** If it were on, everyone would get Pro and the site's plan limits would not be what people get. The owner believes it is off; the admin panel shows it.
- **Legal text** is drafted from code facts, not legal advice. The owner reads it, and the decisions in §10 shape it.
