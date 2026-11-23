# Menu revamp: a lean menu, one way into Google calendars, plan and feedback in Settings, a Telegram link in the admin panel

Owner's request 2026-11-24; the short version was approved in chat ("go") with the picks 1a, 2a, 3a, 4a, 5a.

## Why

- The zmanim button's sun looks like the weather sun right under it, so it reads as "weather".
- The ⋯ menu has up to ten entries. "Calendars" and "Choose calendars" both lead to calendar lists, and Calendars itself links to the
  same selection screen, so the two are unclear together.
- The Google calendars screen lists every calendar twice (a switch list, then a "Chosen calendars" list for the details).
- Reconnect Google sits in the menu, far from the Google calendars it fixes.
- The admin panel shows a user's Telegram id as plain text, with no way to reach the person.

## Goals

1. **Zmanim button icon (1a).** The header's zmanim button shows lucide `Sunset` instead of the hand-drawn sun. Its label
   (`header.zmanim`), place, size and behaviour stay. The weather icons and SendSheet's weather icon stay as they are.
2. **Menu (2a).** The menu becomes, in order: Settings, Calendars, Partner, Refresh, and Admin panel (admins inside Telegram only,
   as today). Connect Google Calendar, Choose calendars, Reconnect Google, Subscription and Feedback leave the menu. Their pages,
   routes and every other way in (bot buttons, banners, See plans links, `/feedback`, `/start feedback`) stay as they are.
3. **One way into Google calendars (3a).** Calendars stays the hub, and its Google section's single row stays the only way into
   the Google calendars screen (`/select-calendars`). Connect (state `none`) and Reconnect (state `reconnect`) stay on that row as
   today.
4. **A compact Google calendars screen.**
   - One list, "Show in FamCal". A **shown** calendar's row has the colour dot, the name, and a quiet line with its role
     (Mine, Spouse, Kids, Birthdays, or "No role") plus the Main tag. Tapping the row's text opens its details. The switch at the
     row's end turns it off.
   - A **hidden** calendar's row is the dot and the name. The whole row is its switch, as today; there are no details to edit
     until it is shown. *(builder's call, approved as part of the design)*
   - Google's description line is no longer drawn. *(builder's call: compactness)*
   - The "Chosen calendars" section and its hint are removed. The details sheet is today's calendar sheet, unchanged: main
     calendar, role, note for the AI, spouse details.
   - "Not in your Google list" (first, only when there are any) and "Notes for all calendars" stay as they are.
   - A new last section, "Google account":
     - **Reconnect Google**, an accent action row with a one-line hint. It is a full page load of
       `/refresh-token?user_id=<id>`, which already returns here after Google's consent.
     - **Disconnect Google (4a).** Today's `GoogleDisconnect` section and sheet move here from Settings, unchanged in words and
       behaviour (Settings no longer shows it). Once disconnected, closing the result goes to the Calendars screen.
   - Back (Telegram's BackButton and the header's back) closes an open sheet, else goes to the Calendars screen (today it goes to
     the home).
   - **A dead Google token.** When Google refuses the token (`classifyGoogleError` gives `token`), the screen today shows the
     generic "something went wrong / retry" card, and the menu's Reconnect was the way out. That card now has its own notice,
     `googleReconnect`: a StateCard that says Google stopped answering for this account, with a Reconnect Google action to
     `/refresh-token?user_id=<id>`. Missing scopes still redirect to `/refresh-token` as today, and other failures keep the generic
     card.
5. **Settings gets two link rows.**
   - **Plan at a glance**, first on the screen, in its own card under the section label "Plan". The row shows the plan's name and
     one status line:
     - "Early access" when the person is an early adopter;
     - the trial's days left while trialing (the same words as the home's trial banner);
     - "Active until <date>" for a paid plan with a period end;
     - nothing else for Free.
     Tapping it opens the Subscription screen. The wording and the rule come from one shared helper that the Subscription screen
     also uses, so the two never disagree.
   - **Send feedback**, last before Delete account (after Sign-in methods), in its own card. Tapping it opens the Feedback screen.
   - Both open with `&from=settings`. On the Subscription and Feedback screens, Back returns to Settings when `from=settings`,
     else to the home as today. A feedback that was sent still offers "Back to calendar" as today.
6. **Admin: open a user in Telegram (5a).** The admin profile's Who card gets an "Open in Telegram" button next to the Telegram
   id, and an "Open in WhatsApp" button next to the WhatsApp phone.
   - **Telegram.** The button calls a new admin route, which asks Telegram for the user's chat (`getChat` through the one
     `getBot()` Api). Nothing new is stored.
     - With a username, the route answers `https://t.me/<username>`, and the Mini App opens it with
       `Telegram.WebApp.openTelegramLink` (a new helper beside `openExternalLink` in `src/lib/telegram-ui.ts`; outside Telegram,
       `window.open`).
     - Without a username, or when `getChat` is refused, the bot sends the admin's own chat one message: the user's name as an
       HTML inline mention `<a href="tg://user?id=<id>">name</a>`. Telegram documents this as working for anyone who contacted the
       bot in private, unless they turned on forwarded-messages privacy for the bot. The panel then says it was sent to the admin's
       chat.
   - **WhatsApp.** The button opens `https://wa.me/<digits of whatsappPhone>` with `openExternalLink`, with no server call. It is
     shown only when a phone is known.

## Settled after the builder check

- **The Google account section.** The Google screen loads its list only with a stored token, so it always shows both Reconnect and
  Disconnect. The dead-token card (`googleReconnect`) shows Reconnect Google as its action and the same Disconnect section under
  it, so a person whose token died can still disconnect, as Settings allowed before. The no-token notice has nothing to
  disconnect. After a disconnect, the Calendars screen loads its own page data afresh, so its Google row is current.
- **Back from the Google screen** always goes to Calendars, whoever opened it (the OAuth return, a banner, a bot button).
  Calendars is now its parent, and Calendars' own Back goes home.
- **Hiding a calendar** keeps today's rules. Turning it off drops its role and note, and the server's `none_selected` / `no_yours`
  refusals stand. A hidden calendar has no details to reach.
- **Plan at a glance.**
  - The shared helper is the Subscription screen's own rule, extracted: the name is `subscription.plans.<effectivePlan>.name` for
    every plan, Free and Basic included.
  - The status line is exactly today's `status` on that screen: early access first, then the trial's days, then "Active until"
    for a paid plan with a period end, else none.
  - So an admin grant, a paid plan with no period end, and a cancelled plan show the name alone, as the Subscription screen does.
  - No tag on the row.
- **`from=settings`** decides only Back on those two screens. It is not carried into their other links.
- **The admin buttons.**
  - "Open in Telegram" shows only when the user has a `telegramId` (a web-only account shows "no Telegram" as today). It is not
    gated by bans or blocks: the admin may look anyone up.
  - "Open in WhatsApp" shows only with a `whatsappPhone` (stored E.164); its link is the phone's digits.

## Non-goals

- No change to the Calendars screen's own sections (FamCal calendars, Copy to Google, the partner's) or to its Google row's words.
- No new stored data. No username column, and no change to the Privacy Policy or the Terms.
- No change to the Subscription or Feedback screens beyond Back, and the shared status helper's extraction.
- No change to the home's banners (the reconnect banners keep linking to `/refresh-token`) or to the OAuth return page.
- No hover styles.

## Constraints

- The repo's rules apply: i18n in en, he and ru with no inline copy. Hebrew is gender-neutral (plural imperative or infinitive and
  noun on buttons), Russian formal, and both natural. Lucide icons only, no emoji. RTL correct. Light and dark from the device.
  No `:hover`.
- Telegram:
  - Every Bot API call goes through `getBot()`, and failures are read only through `telegramErrorInfo`.
  - The admin message is a message to the admin, so it asks no pause. Its file goes in `scripts/smoke-pause.ts`'s `NOT_PAUSED`
    with that reason.
  - No console line or Sentry field holds the user's name, the username, the message text or a chat id beyond the user ids the
    admin routes already log.
  - Tests never call the real Telegram API.
- The admin route is guarded like the other admin routes (same auth helper), and refuses a non-admin.
- The `user.id` and `telegramId` roles stay as they are: the route takes the profile's own user id (the database id the panel
  already uses) and reads `telegramId` from the row.
- The smokes that pin what changes are updated in the same commit as the change: menu entries, copy tables, the settings section
  order and key coverage, the Subscription and Feedback backs, the select-calendars screen, the Google-disconnect UI, the page-data
  props, the admin render, and the pause table. New behaviour gets new assertions there.

## Left to the builder

- The exact row markup for the shown calendar row (a text button and a separate switch button in one `ch-form-row`, with no nested
  buttons), reusing the kit's classes and tokens.
- Where the plan-glance helper lives (for example `src/lib/plan-glance.ts`), and how Settings' page data gets the early-adopter flag
  and the trial's days (the Subscription page's own reads, `checkEarlyAdopterAccess` and `getTrialStatus`).
- Whether `GoogleDisconnect` and its client move into `select-calendars/`. Its i18n stays under `settings.googleDisconnect`.
- The new keys' names, and the words, within the rules above.
