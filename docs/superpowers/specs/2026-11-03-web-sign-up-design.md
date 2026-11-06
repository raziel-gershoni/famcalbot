# Web sign-up and FamCal in the browser (item 6c-1)

Status: shipped 2026-11-04 (main daa187aa); approved by the owner. Item 6c is FamCal with no messenger, in two steps:
- **6c-1, this spec:** sign up on famcal.bot and use FamCal fully in the browser, with no notifications.
- **6c-2:** web push notifications.

It builds on 6b (`docs/superpowers/specs/2026-11-02-web-sign-in-design.md`, live since 9fff29df).

The facts were read from the code at 60a9a74e. The Turnstile facts are from Cloudflare's docs on 2026-11-03. Two independent reviews are folded in: one on security, one on code facts with the flows and the legal text.

The owner approved the direction in chat on 2026-11-03 and chose to connect Telegram with a merge (§2.9).

## 1. Why

The owner, 2026-10-30: "Web-only accounts must work with NO messenger; the partner feature is available after sign-up; other features may be restricted for unregistered users."

Today an account is made only by the Telegram bot's /start or a first WhatsApp message. A sign-in on famcal.bot that matches no account is a dead end: "start in Telegram or WhatsApp".

**Goal:** a new person creates a FamCal account on famcal.bot with Google or an email code. They use the calendar, Google Calendar, the partner link and Settings in any browser, with no Telegram and no WhatsApp. Later they can connect Telegram for reminders and briefings without ending up with two accounts.

**Success:**
- A new person signs up with Google or an email code, types a name, accepts the Terms and lands on their calendar.
- An existing user is stopped before making a second account wherever FamCal can tell, and is warned where it can't. An accidental second account can be joined into the first.
- A browser-only account sees no button or setting that needs a chat, and no copy that sends them back to one.
- A browser-only person connects Google Calendar and accepts a partner invite on the web.
- A browser-only account can't lock itself out by removing its last way to sign in.
- A ban covers a browser-only account's Google account and email address.
- Strangers can't use up the email budget that sign-in codes and security notices depend on.
- An idle FamCal makes no more database queries than today.

## 2. Decisions

1. **Who can sign up:** anyone 18 or older, with Google or an email code.
   - A Telegram sign-in that finds no account still says to start the bot, because only a press of Start lets the bot message the person (6b §2.1).
   - That page now leads with: "Made your account on famcal.bot? Sign in with Google or email, then connect Telegram in Settings."
2. **Sign-up is the end of the sign-in that already exists.** Google or the email code proves who the person is, exactly as in 6b. When that proof finds no account, the person goes to the sign-up page instead of the dead end.
   - **When the verified address is already a way on another account,** there is no sign-up. Examples: a Gmail that already signs in with an email code, or an email whose address a Google way shows. The page says "This address already signs in to FamCal with an email code (or Google). Use that, then add this way in Settings." It is a check on an address the person just proved, never a sign-in by address (6b's rule stands).
   - **When an account holds this Google account's calendar but doesn't match it** (6b §2.17: another Google way, a dead connection, a live mismatch), today's no-account page stays, with no sign-up.
   - **Otherwise** the page says "No FamCal account uses dana@gmail.com yet." The main button is **Create account**, with the warning: "Already use FamCal in Telegram or WhatsApp? Don't make a second account. Open FamCal there, then add this way in Settings → Sign in on the web."
   - **Turned down:**
     - a separate sign-up page, because it would be a second copy of the Google and email flows;
     - making the account silently at the first sign-in, because there would be no moment to accept the Terms and no chance for the checks above.
3. **The sign-up page** has:
   - a name field: "Your name. Your partner sees it.";
   - the line "By creating an account, you confirm you're 18 or older and agree to the Terms and the Privacy Policy", with both linked;
   - **Create account**.

   Google gives no name, because 6b asks Google only for `openid email`, and that stays. The person types the name for either way. The verified identity waits for 10 minutes in a one-time record behind the `famcal_signin` cookie (§3.4).
4. **Bot protection: Cloudflare Turnstile on the email-code form,** on every code request.
   - It covers sign-in as well as sign-up, so the answer still gives no hint whether an address has an account (6b §2.6).
   - The widget runs in Managed mode, where most people see only a short spinner, and follows dark mode.
   - Google needs no Turnstile.
   - Turnstile is free, with no cap on checks.
   - Until the owner sets both Turnstile variables, email sign-up stays off, and email sign-in works as today.
5. **The email budget is shared out** (Resend's free plan sends 100 a day).
   - Sign-up codes get at most 30 a day, inside the 90 that codes may use.
   - Each internet address gets at most 3 sign-up codes a day.
   - When the 30 are spent, email sign-up pauses until 00:00 UTC, and the admin gets one Telegram message.
   - Security notices (decision 11) get their own 10 a day, above the 90, so a flood of codes can't silence them.
   - A notice that can't be sent is logged as a security event.
6. **New accounts per internet address:** at most 5 a day.
   - Counted by the IPv4 address, or by the IPv6 /48 block, since a /64 is easy to change.
   - A request with no address skips this count and logs it, instead of sharing one counter for everyone.
   - The 6b `x-real-ip` probe must pass before sign-up is announced.
7. **One way to make an account.** The bot's /start, the first WhatsApp message and the web share one creation step: the ban check, the account, its first FamCal calendar, and a log line. Today the two chat paths each have their own copy.
8. **Bans cover web accounts.**
   - A ban records every identifier of the account: Telegram id, WhatsApp number, Google account id, sign-in email address.
   - The sign-up, every sign-in and adding a way check them. A Google sign-up or sign-in also checks Google's verified email against the email bans.
   - The admin panel can block, list and unblock a browser-only account. Today Block is hidden for it, the server refuses it, and the list calls every non-Telegram row WhatsApp.
9. **Connect Telegram and Join** (the owner's choice: connect with a merge). A merge is offered only after the person proves, in a flow they started, that they control the account being joined. Anything less lets an attacker talk someone into joining the attacker's account into theirs (the security review).
   - **Connect.** A browser-only account presses **Connect Telegram** on the banner, in Settings → Sign in on the web, or on Plans.
     - **The link:** it opens the bot with a one-time link, valid 10 minutes, usable once.
     - **Recent sign-in required:** the link is made only within an hour of signing in on this browser. Otherwise the button says "Sign in again to connect Telegram", so a copied old session can't attach a Telegram that can't be removed.
     - **If that Telegram has no FamCal yet,** the bot asks: "Connect this Telegram to the FamCal account Dana, made on famcal.bot with dana@gmail.com? Do it only if that account is yours." [Connect] [Cancel]. The full address is shown, since a masked one is easy to imitate.
     - **On Connect:** the Telegram id is written onto the browser account. The browser stays signed in. Reminders, briefings, Send to chat and Stars payments start working.
     - **If that Telegram already has FamCal,** the bot doesn't join anything. It says: "This Telegram already has a FamCal account. To bring the account made on famcal.bot into it, open Settings here → Sign in on the web → Add Google, and choose dana@gmail.com." The way it names is email when that is the browser account's way.
   - **Join.** In any account's Settings, **Add Google** or **Add email** may end on a way that belongs to an account with no chat. Then, instead of 6b's "taken", the person gets the question "This Google account has its own FamCal account, Dana, made on famcal.bot on 3 November. Join it into this one?"
     - **What will move:** the question lists it, worked out from the merge's own rules by a dry run: its calendars and events; its sign-in ways this account lacks; its Google Calendar connection when this account has none; its partner link when this account has none, otherwise "its partner link ends"; a paid or free-gift plan that runs longer.
     - **What closes:** that account. Its trial never replaces this account's plan, since email addresses are free.
     - [Join] [Cancel]. Join runs the existing merge, taught that the joined account may have no WhatsApp (§3.6). Its browser session ends with it.
     - **The notice** goes to this account, the one that gains the ways.
   - **Refused, with a reply:** either account suspended or banned; the two are each other's partners; the link or question has expired or was already used; a press from another Telegram id.
10. **Google Calendar from the browser.**
    - Today a connection finishes only when its owner sends `gc_<id>` from their own Telegram or WhatsApp. That stops someone from finishing a consent on another person's account (R3, `src/services/google-connect.ts`).
    - The finish page now also offers **Finish here** when this browser is signed in as the account that started the consent. The server compares the session's account with the waiting connection's owner, and anyone else's press uses it up and connects nothing, as today.
    - This works for every account in a browser, not only browser-only ones. Reconnect and Copy to Google go through the same finish.
11. **Notices for a way added go to the ways that were there before**, so a thief who adds a way can't send the notice only to themselves.
    - **With a chat:** to the chat, as in 6b.
    - **With no chat:** by email to the account's existing email way, or else to its Google way's address, using the notices' own 10 a day.
    - **Wording:** connecting Telegram has its own words: "Telegram was connected to your FamCal account. Not you? Write to privacy@famcal.bot." Telegram can't be removed in Settings, so there is no "Remove".
    - Settings' "We sent a notice to your chat" has a no-chat version.
12. **The last way in is protected.**
    - Settings won't offer to remove an account's only durable way to sign in, and the server refuses it too, with the account's row locked so that two removals at once can't both pass.
    - The durable ways are Telegram, WhatsApp, a Google way and an email way. The connected calendar's Google account doesn't count, because disconnecting the calendar ends it.
13. **What a browser-only account sees.** "No chat" means no Telegram and no WhatsApp.
    - **Home:**
      - no **Send to chat** button;
      - **Connect Telegram** in place of the "Open FamCal in Telegram" banner, worded "for reminders and briefings", with a close button remembered on that device;
      - today's place banner ("Set your location for the right times"), as for everyone;
      - the empty home's hint says "To add an event, tap +".
    - **Settings:** these are hidden, since they only set up chat messages:
      - the Summaries card and the Timing card;
      - the voice input, event alerts (with its default alert and pickup) and Shabbat pause rows;
      - the reminders Pro notice.
      - In their place: "Briefings and reminders come in Telegram", with **Connect Telegram**.
    - **Plans:** "Plans are paid with Telegram Stars. Connect Telegram to change your plan", with **Connect Telegram**.
    - **Browser wording** replaces chat wording:
      - "Open it again from the bot" lines become "Your sign-in has ended. Sign in again".
      - The page gate's card leads with Sign in.
      - The invite page's "Try the bot directly" error gets browser words.
14. **The partner on the web.**
    - The invite page gets **Accept** for anyone signed in on famcal.bot.
    - Anyone signed out sees **Sign in or create an account to accept**. The sign-in or sign-up brings them back to the invite.
    - After accepting: "You're now paired with Dana", with **Open your calendar**.
    - Accepting and making an invite now require the request to come from famcal.bot, since a cookie can now accept.
    - An inviter with no chat gets no notice until 6c-2. The skip is logged.
15. **Fixes found on the way:**
    - **Feedback** from a browser account reaches the admin as "ID: N/A". It will show the FamCal id, and the Telegram id when there is one.
    - **The admin users list** calls every account without Telegram "WhatsApp". It will say "Web" for an account with no chat.
    - **Silent skips:** every notice that skips a person because they have no chat logs one line naming the send and the user id. Today these skip silently: the partner accept, the partner's Done note, the trial-ended notice, the alerts downgrade notice and the plan reminders. The plan reminders even log "Sent".
16. **The website:** the start buttons get a third choice, **Use in the browser**, which opens `/signin`. It appears on the landing hero, the closing section, blog posts and the zmanim pages' FamCal block. It does not appear on `/signin` or in the site header, which already has Sign in. `/signin` says new people can create an account there. Nothing claims the browser does everything the bots do.
17. **Legal text:** the Privacy Policy and the Terms change in all three languages, with a new `LEGAL_UPDATED`. The English draft is in §7. Hebrew and Russian carry the same meaning, and a legal review agent checks all three before they ship.
18. **Not in 6c-1** (§9): notifications in the browser (6c-2), paying on the website (Stars stay), FamCal's assistant in the browser, and deleting your own account.

Rulings (small choices; the owner can change any):

19. **Where things live:**
    - **The page:** `/{locale}/signup` (site group, per request).
    - **Its API:** `/api/auth/signup`. GET shows the waiting identity, POST creates the account.
    - **The Join answer:** `POST /api/signin-methods/join`.
    - **The connect link:** `POST /api/telegram-connect`, with the bot payload `w_<22-character token>`.
    - **The browser finish:** `POST /api/oauth/claim`.
20. **A new browser account starts like a chat account:**
    - the language of the page it signed up on;
    - no place;
    - the bot's gender and culture defaults;
    - the 14-day Pro trial, from first use;
    - its first FamCal calendar;
    - the activity line `web_signup`.
21. **The sign-up code email** has its own words:
    - **Subject:** "Your code to create a FamCal account: 123456".
    - **Body:** "Enter this code on famcal.bot to create your account."
    - **Closing line:** "If you didn't ask for this, you can ignore this email. No account is made without the code."
22. **The name:** trimmed, 1–60 characters. Control characters, bidi overrides and zero-width characters are refused, because the partner and the bot's HTML messages show it.

## 3. Pages and flows

### 3.1 Email: request

- **Order:** `POST /api/auth/email/request` keeps its order: the same-origin check, JSON, limits, then the flow cookie and `{ok:true}`.
- **Turnstile, first:** before the limits it reads `token`, the Turnstile response. The field name is one the Sentry scrubber already drops.
  - **The check:** the server calls Cloudflare's `siteverify` through `fetchWithRetry`. It sends the secret, the token, the client address (`x-real-ip`, as the limits read it) and one idempotency UUID per request, reused on retries so a retry isn't a duplicate.
  - **What must match:** the answer's `hostname` equals `new URL(getBaseUrl()).hostname`, never the request's Host. Its `action` is `email-code`.
  - **On failure:** a missing or failed token, or Cloudflare giving up, answers `{ok:false, error:'check'}`. The form says "We couldn't check this browser. Try again, or use Google." Only the status is logged.
  - **When it applies:** only when both variables are set. The widget shows only then.
- **`after()`, address on an account:** a sign-in code, as today.
- **`after()`, address on no account:**
  - **With Turnstile configured:** a sign-up code to the typed address, within decision 5's shares.
  - **Its record:** a new purpose, `signup`, holding `{hash, address}` and no account, with the same 10 minutes, tries and keyed hash as a sign-in code.
  - **Without Turnstile:** no mail, as today.
- **Unchanged:** the 6b limits, and the identical answer and timing for every address.

### 3.2 Email: verify

- **The order of checks:**
  - The verify route checks a `signin` code, then a `signup` code, for the flow's address.
  - A right sign-up code looks the address up again, since a way might have been added in the meantime. If an account uses it now, the person signs in as usual.
  - If a Google way shows that address, the answer is the "already signs in with Google" page (decision 2).
- **Otherwise:**
  - **The answer:** the sign-up flow starts (§3.4), and the route answers `{ok:true, redirect:'/{locale}/signup'}`.
  - **The cookie:** this branch keeps the new flow cookie; only the finished sign-in clears it.

### 3.3 Google

- **When it asks for sign-up:** `resolveGoogleSignIn` gets a new answer, `new`. It gives it only when no account holds this Google account in any way: no Google way with this `sub`, and no calendar key for its address.
  - The callback then starts the sign-up flow with the verified `sub` and email, and redirects to `/{locale}/signup`.
  - `onClaims` tells the shared callback to keep the cookie it just set. Today `done()` clears it, which would empty the record before the page could read it.
- **The other answers:** a calendar holder that doesn't match keeps `no-account`, and several holders keep `several`. Both show today's pages.

### 3.4 The sign-up flow

- **The record:** a new flow kind, `signup`, in `flow.ts`, behind the same `famcal_signin` cookie (path `/api/auth`, 10 minutes, one use). It holds:
  - the way (`google` or `email`);
  - the subject (Google's `sub`, or the normalised address);
  - the address to show;
  - the locale;
  - the invite token, if the person came from an invite (§3.7).
- **`GET /api/auth/signup`:**
  - It reads the record without using it up.
  - It answers `{way, address}`, or `exists` with the way that already signs in with this address (decision 2), or `restart`.
- **`POST /api/auth/signup`, `{name}`,** in this order:
  - the same-origin check and JSON;
  - the name (decision 22);
  - take the record (GETDEL);
  - the ban checks (§3.8);
  - the address check again;
  - the account cap (decision 6);
  - the creation step (§3.5), with the way written in the same transaction;
  - `finishSignIn(user, 'google' | 'email', { respond: 'json', page })`.
  - A way someone took in the meantime fails the unique (kind, subject), and the answer is 6b's `taken` page.
- **The page:**
  - It shows the address, the warning, the name field (16 px, so iOS doesn't zoom), the consent line, **Create account** and **Use another way**.
  - With no record: "This sign-up has expired. Start again."
  - With `exists`: the guidance, and no form.
  - Its words are in `site`, in he, en and ru, with Hebrew gender-neutral and Russian formal.

### 3.5 The one creation step

- **`createAccount(input)`,** in `src/services/user-service.ts`. The input is a Telegram profile, a WhatsApp profile, or `{ web: { kind, subject, address }, name, language }`.
- **The steps, in order:**
  - the ban check for that identifier;
  - `prisma.user.create` with the shared defaults;
  - for the web, the `SignInIdentity` row in the same transaction, written by a helper in `identities.ts`;
  - `ensurePrimaryNativeCalendar`, whose failure is logged and sent to Sentry (today it is only a warning);
  - one log line with the user id and how the account was made.
- **The two existing paths:** `getOrCreateUser` and `getOrCreateUserByWhatsApp` keep their lookups and call it.

### 3.6 Connect and Join

**The connect link: `POST /api/telegram-connect`**
- **Checks, in order:**
  - `verifyUserAuth` and the same-origin check.
  - The session must be a web one, with a sign-in under an hour old.
  - The account must have no Telegram id and no WhatsApp id.
  - At most 5 links an hour per account.
- **What it does:** it makes 16 random bytes, keeps `tgconnect:<sha256>` → `{userId}` for 10 minutes, and answers `{url: 'https://t.me/<bot>?start=w_<token>'}`.

**The bot, `/start w_<token>`**
- **Where it runs:** before auto-registration and before the breadcrumb, as `gc_` does. The link never makes an account, and its token is never logged.
- **The checks:**
  - It loads the browser account W without using the link up.
  - It looks up a FamCal account by the sender's Telegram id.
- **The replies:**
  - **When there is none:** the Connect question. Its button carries a short id for a pending record, kept 10 minutes and bound to the sender's Telegram id.
  - **When there is one:** the Add Google / Add email guidance (decision 9).
- **On the press:**
  - The bot takes both records (GETDEL) and checks everything again.
  - It sets W's `telegramId` and `messagingPlatform: 'telegram'`.
  - It sets the menu button as /start does.
  - It invalidates feature access and rebuilds W's reminder-cache entry.
  - It sends the welcome with the dashboard button.
  - It sends decision 11's notice by email.
  - A Telegram id that got its own account in the meantime gets the guidance instead.

**Join**
- **Where it starts:**
  - `finishAddGoogle`, and the email add's confirm, find the way held by another account W.
  - When W has no chat (and isn't this account's partner), they answer `join` with the dry run's summary and a one-time id, 10 minutes, bound to this account. The Add Google browser page and the Settings sheet show the question.
  - Otherwise they answer 6b's `taken`.
- **`POST /api/signin-methods/join`:**
  - It takes the id and runs `mergeIntoAccount(tx, W, T)`. This is `mergeWhatsAppUser`, renamed and with three changes:
    - WhatsApp ids move only from a WhatsApp W to a Telegram T, as today, and `messagingPlatform` becomes `all` only then;
    - a W with no chat may join any T;
    - W's trial never replaces T's subscription.
  - `afterMerge` follows, and its menu-button step runs only when T has Telegram.
  - The dry run and the merge read one set of rules, so the question can't promise what the merge won't do.
  - The way being added is among W's ways and moves with them.

### 3.7 Invite on the web

- **The invite page** (`invite/[token]`):
  - It reads the session cookie on the server with `validateSessionToken`, and passes the session's user id to the client.
  - The API's `verifyUserAuth` still makes the full check.
- **`/api/pair/accept` and `/api/pair/invite`** gain the same-origin check.
- **Signed in:** **Accept** posts `/api/pair/accept?user_id=<id>` with `{token}`. A 401 switches the page to signed out.
- **Signed out:**
  - The Telegram and WhatsApp links stay, under **Sign in or create an account to accept**, which links to `/signin?invite=<token>`.
  - The token must be 64 hex characters, or it is dropped.
  - It rides in the flow records (Telegram, Google, email, sign-up), never in a return URL.
  - `FinishPage` gains `{ invite: token }`, which lands on `/{locale}/invite/{token}`.
  - `invite` joins the Sentry scrubber's query and body names.
- **After accepting:** outside Telegram, success shows **Open your calendar**, and the "Open in your bot" line gets browser words.
- **No-chat logging:** an inviter with no chat logs `[pair] inviter <id> has no chat; accept notice not sent`. The empty `.catch(() => {})` at the chat-accept caller logs too.

### 3.8 Bans

- **The table:** `BlockedIdentifier` gains `googleSub String? @unique` and `email String? @unique` (the normalised address). It comes as a migration file, applied on deploy.
- **Banning:**
  - `banIdentifier` takes a user id from the admin panel and records all of the account's identifiers.
  - It still takes a bare Telegram id or number.
  - It moves `sessionsValidAfter`.
  - It logs the user id and which kinds it recorded, never the values.
- **Unbanning:** `unbanIdentifier`, the blocklist route and the admin's blocked list handle the new kinds.
- **Checking:**
  - `isIdentifierBlocked` learns `googleSub` and `email`, with the same cache. The cache keys are `blocked:google:<sub>` and `blocked:email:<emailKey>`, the keyed hash the other sign-in keys use.
  - `signInRefusal` checks all of the account's ways, read by a helper in `identities.ts`.

### 3.9 The last way

- **Removing a way:** `removeSignInMethod` locks the user row (`SELECT … FOR UPDATE`), counts the durable ways, and refuses the last one with `{error:'last-way'}`.
- **Showing it:** `listSignInMethods` reports `lastWay`. Settings shows no **Remove** on that way, and says instead: "Your only way to sign in. Add another to remove this one."

### 3.10 Google Calendar: Finish here

- **The page:** the finish page (`/oauth-complete`) asks `GET /api/oauth/claim?p=<pendingId>` whether this browser's session belongs to the waiting connection's owner. If it does, the page shows **Finish here** before the chat buttons.
- **The press:** **Finish here** posts the id (same-origin, JSON). The server:
  - takes the waiting entry;
  - checks `verifyUserAuth` by cookie;
  - compares the session's account with the owner;
  - calls `commitGoogleToken` as the chat claim does.
- **A press from another account** uses the entry up and connects nothing, as a chat claim from someone else does.

### 3.11 Flags

- **`hasChat`:** page-data gains `hasChat = telegramId !== null || whatsappPhone !== null || whatsappBsuid !== null`. The home, Settings, Plans, the editor hint and the invite page read it.
- **The banners:**
  - **Connect Telegram** shows when `!inTelegram && !hasChat`.
  - The existing banner keeps WhatsApp-only accounts: `!inTelegram && !hasTelegram && hasChat`.
  - The close is a per-user flag in `home-storage.ts`, with its try/catch pattern.

## 4. Settings

- **Sign in on the web,** for an account with no chat:
  - Telegram: **Connect** (§3.6).
  - Google and email: as in 6b, with Join (§3.6) and the last-way rule (§3.9).
- **Hidden with no chat:** the Summaries card, the Timing card, and the voice input, event alerts and Shabbat pause rows, plus the reminders Pro notice. The reminder-time row is already hidden without Telegram.
- **Stays:** language, gender, place, zmanim community, culture, the sign-in group and Google Calendar (§3.10).
- **The note card:** "Briefings and reminders come in Telegram", with **Connect Telegram**.
- **After Telegram connects,** everything shows on the next load.

## 5. Limits

| What | Limit |
|---|---|
| Email code requests | a Turnstile pass each (when configured), then the 6b limits |
| Sign-up codes | 30 a day in all, inside the 90; 3 a day per internet address |
| Security notices by email | their own 10 a day, above the 90 |
| New accounts per internet address | 5 a day (IPv4, or the IPv6 /48); none counted without an address |
| Connect Telegram links | 5 an hour per account; a sign-in within the hour; 10 minutes and one use each |
| The bot's Connect press, a Join | 10 minutes, once, bound to who started it |

- **Where they live:** the new counters are in Upstash under hashed keys, as the 6b ones are.
- **What they cost:** a sign-up costs a few queries (the ban list, the address check, the create, the calendar). A connect or a join costs a few more, and only when a person acts.

## 6. What the owner does (once; the plan gives exact values)

1. **Cloudflare → Turnstile → Add widget:**
   - name "FamCal sign-in", hostname `famcal.bot`, mode Managed, no pre-clearance;
   - put its keys into Railway as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`. The secret's name matches the log scrubber's `…_SECRET`. The site key reaches the page at request time, not at build.
2. **The 6b variables** (Telegram, Google, Resend) are still waiting, and sign-up uses them.

After both, the 6b `x-real-ip` probe runs before sign-up is announced. The new variables go into the startup checks and the README's table.

## 7. Legal text (English draft; he and ru carry the same meaning)

### Privacy

- **Who we are**, a new sentence: "You can also create an account on famcal.bot with Google or an email address, and use FamCal only in your browser."
- **What you have to give us:** "FamCal can't work without your Telegram user id or your WhatsApp number, because that's how the bot talks to you." becomes "An account needs one way for you to sign in: your Telegram user id or WhatsApp number, which is also how the bot talks to you, or the Google account or email address you created it with on famcal.bot."
- **What we keep, Your account:**
  - New item: "If you create your account on famcal.bot: the name you give us."
  - The sign-in items become:
    - "if you create your account with Google, add Google sign-in, or sign in with the Google account your calendar is connected from: your Google account id and its email address;"
    - "if you create your account with an email address, or add email sign-in: that email address;"
  - The `after` sentence becomes: "We use them only to sign you in, to send you sign-in codes, and to tell you when a way to sign in is added: in your chat, or by email if your account has no chat."
- **Short-lived copies**, new items:
  - "while you create an account on famcal.bot, the address (and Google account id) you're signing up with, for 10 minutes;"
  - "a one-time link to connect Telegram to your account, for 10 minutes."
- **Server logs**, the sign-in sentence becomes: "To stop misuse of sign-in, we also count sign-in attempts and new accounts in Upstash per IP address, per email address and, when you add an email, per account, under scrambled keys, for up to a day."
- **Children:** "We don't ask anyone's age." becomes "We don't ask anyone's age, except that creating an account on famcal.bot asks you to confirm you're 18 or older."
- **Google user data, signing in:** "We use these only to sign you in" becomes "We use these only to sign you in and, if your account has no chat, to email you when a way to sign in is added".
- **Who else handles your data:**
  - **Cloudflare:** "**Cloudflare:** our domain's DNS, forwarding the mail you send to {email} to our mailbox, and Turnstile, which checks that a person, not a program, asks for an email code on famcal.bot. Turnstile reads your IP address and browser details, not what you type."
  - **Resend:** "**Resend:** your email address and the sign-in code or notice we email you. Resend keeps a copy of each email for up to 30 days."
  - **The browser sentence** adds: "When you ask for an email code, your browser loads Cloudflare's Turnstile check from challenges.cloudflare.com."
  - **Where your data goes:**
    - "…Sentry, Cloudflare and Resend handle data for us…" becomes "…Sentry, Cloudflare (except Turnstile's signals, below) and Resend handle data for us…".
    - It adds: "Cloudflare also uses Turnstile's signals to improve its own bot detection, under its Turnstile Privacy Addendum."
  - **The people who run FamCal:** "…with your name and Telegram id." becomes "…with your name and your FamCal id, and your Telegram id if you have one."
- **Legal grounds (EU and UK):** the legitimate-interests list adds "the bot check on the email-code form (Turnstile)".
- **Cookies:** "While you sign in, `famcal_signin` holds a one-time check for 10 minutes." becomes "While you sign in or create an account, `famcal_signin` holds a one-time check for 10 minutes."
- **Your rights:**
  - "We may ask you to confirm the request from the bot, so we know it comes from you." becomes "We may ask you to confirm the request from the bot, or from the email address you sign in with, so we know it comes from you."
  - "remove a sign-in method in Settings, under "Sign in on the web";" becomes "remove a sign-in method in Settings, under "Sign in on the web", except your only one;"
  - The ban bullet becomes "if we banned the account: its Telegram id, WhatsApp number, Google account id and sign-in email address, and the reason, so it can't sign up again;"

### Terms

- **What FamCal is,** after the Telegram-only list: "An account made on famcal.bot works in your browser without Telegram or WhatsApp. In the browser you add events yourself; FamCal's assistant (voice notes, photos and messages) works in the bots. Briefings and reminders reach you once you connect Telegram in Settings."
- **Who can use FamCal:** "…and you need your own Telegram or WhatsApp account." becomes "…and you need your own Telegram or WhatsApp account, or your own Google account or email address to create an account on famcal.bot."
- **Your account and your family:**
  - "Anyone who can use your Telegram or WhatsApp account, the Google account your calendar is connected from, or a Google account or mailbox you created your account with or added for signing in, can use FamCal as you. Keep those accounts safe."
  - New: "If you lose every way you sign in, we may not be able to give the account back."
- **Paying:** "You can't pay on WhatsApp yet." becomes "You can't pay on WhatsApp or on famcal.bot yet. An account made on famcal.bot pays after you connect Telegram."
- **Suspension:**
  - "which means the bot stops answering it" becomes "which means the bot stops answering it and it can't sign in on famcal.bot".
  - "block the bot, and ask us to delete your account" becomes "block the bot if you use it, and ask us to delete your account".

**What stays fixed, and what the smokes need:**
- The new `LEGAL_UPDATED` is the ship date.
- No plan number, refund window, section order or block position changes, so `smoke-terms-plans` and the processors' positional pins hold.
- `smoke-signin-legal`'s exact sentences are updated with the text.

## 8. Testing

**Sign-up**
- **Google:**
  - `new` starts the flow, and the callback's answer carries a live `famcal_signin`;
  - a calendar holder that doesn't match, and several holders, keep their pages.
- **Email:**
  - with Turnstile, an unknown address gets a sign-up code, and a right code leads to `/signup`, with the cookie kept;
  - without Turnstile, it gets no mail;
  - the answer and its timing match a known address.
- **Addresses already in use:** a verified address that another account's Google or email way shows gets `exists` and no form, both ways round.
- **The record:**
  - one use, and gone after 10 minutes;
  - a POST without it gets `restart`;
  - a bad name (empty, too long, control, bidi or zero-width characters) is refused;
  - a way taken in the meantime gets `taken`.
- **The account:** one user, one way, one primary calendar, the page's language, and the cookie with the right method.
- **Refusals:**
  - a banned Google `sub`, a banned address, and a Google sign-up whose verified email is banned;
  - the sixth account from one address, and its IPv6 /48;
  - no address means no count and a log line.

**Email budget**
- The 31st sign-up code of the day is refused, and the admin is told once.
- The 4th sign-up code from one address is refused.
- Sign-in codes still go out after the sign-up share is spent.
- Notices still go out after the 90 are spent, up to their 10.

**Turnstile**
- `siteverify` is mocked, so no test reaches Cloudflare.
- These each answer `check`: a wrong `hostname` or `action`, a failed token, `timeout-or-duplicate`, and no answer.
- The idempotency key is the same on every retry.
- The token reaches no log or Sentry event.

**The creation step:** /start, a first WhatsApp message and the web each go through `createAccount`. A smoke fails on another `prisma.user.create`.

**Connect**
- **The link:**
  - refused for an account with a chat, or an old sign-in;
  - `w_` makes no account;
  - the token is in no log or breadcrumb.
- **Connect:** keeps the browser session; the reminder cache and feature access follow.
- **An existing Telegram account:** gets the guidance and no merge.
- **Refused:** expired, used, a press from another Telegram id, and a suspended or banned account.

**Join**
- Offered only after Add Google or Add email proves the way, and only for an account with no chat that isn't a partner.
- **The dry run matches the merge** in each case: both paired, either paired, both with Google, ways of the same kind.
- **What T keeps:** its WhatsApp ids and `messagingPlatform`; W's trial never replaces T's plan.
- The notice goes to T.
- The WhatsApp merge's own tests still pass.

**Google Calendar:** Finish here commits for the owner's session. Any other session uses the entry up and connects nothing. The chat claim still works.

**Invite**
- A signed-in browser accepts with the cookie; a stale cookie shows the signed-out state.
- Signed out, the round trip through each way and through sign-up lands on the invite.
- A bad token is dropped.
- A request from another origin is refused.
- An inviter with no chat logs the skip.

**The last way**
- The server refuses removing the only durable way.
- Two removals at once leave one way.
- The calendar account doesn't count.

**Bans**
- The migration adds the columns.
- A browser-only account can be banned, listed and unbanned.
- The log line holds no address.

**Browser-only screens** (render smokes in he, en and ru): no Send button; the Connect banner and its close; Settings without the chat rows, with the note card; the editor hint; Plans; the reopen line; the page gate; the invite page.

**Notices**
- A way added to a no-chat account goes by email to the ways that were there before. The Telegram wording has no "Remove".
- `smoke-pause` learns the new email sender's name and lists it, with the connect replies, as a reply to the person's own action.
- Each skip that used to be silent logs its line.

**Smokes the change touches:**
- `smoke-signin-setup`: its `SIGN_IN_ENV` gains the two Turnstile names, and every new `SignInIdentity` reader sits in `identities.ts`.
- `smoke-alerts-gate-writers`, for the create and the merge.
- The start-button pins: `smoke-site-chrome`, `smoke-site-pages`, `smoke-signin-page`, `smoke-site-landing`.
- `smoke-site-truth`.
- The legal smokes.

**CLAUDE.md**
- The 6b sign-in rule gains the sign-up code to a typed address, the address check on a verified address, Join, and Finish here.
- The pause rule's lists gain the new sender.

**Neon:** an idle pass still makes no query.

**Live check** (after the deploy and the setup):
- a Google sign-up and an email sign-up, on an iPhone and a desktop;
- Turnstile inside Telegram's in-app browser;
- a Connect, a Join and a Finish here;
- a web invite accept.

## 9. Non-goals

- Notifications in the browser (6c-2).
- Paying outside Telegram.
- FamCal's assistant (typing or speaking) in the browser.
- Deleting your own account, or downloading your data, from Settings.
- Connecting WhatsApp to a browser account.
- A Telegram sign-in that creates an account.
- Asking Google for the name (`profile`).
- An admin notice for each new account.
- Matching Gmail addresses that differ only by dots or `+tags`. A banned person can make a new Google account anyway.
- The `isIdentifierBlocked` cache-compare fix. It is its own backlog item, and needs an unban audit first.

## 10. Follow-ups (owner 2026-11-05)

The owner approved four changes after the 6c-1 final review ("go with recommended").

- **Adding a way needs a sign-in from the last hour.** What Connect Telegram already asks (the session's proved-at, `pa`, less than an hour old) is now asked, from one helper (`src/lib/recent-sign-in.ts`), by every browser route that adds a sign-in way or connects a Google account. It reads `provedAt` only, never the sign-in time. A request authenticated by Telegram initData (the Mini App) is never refused by the hour. A stale answer is HTTP 403 `{ ok: false, error: 'stale-sign-in' }`, with one log line (`[recent-sign-in] user <id>: <tag> refused: the <method> sign-in is not recent`: the user id and the method only). Removing a way stays ungated.
  - Gated: Add Google (the link, the continue step and the callback, which checks the proof the flow carries, so a sign-in whose hour runs out on Google's consent screen adds nothing), Add email (the code request and the confirm), the browser Google Calendar connect (start, a Copy to Google that asks Google's consent (the first one, or Approve in Google after Google stopped it), and the claim where it commits), Turn on (`calendar-on`, R2) and Join (R2).
  - A WhatsApp-link session counts like any session (R1): after an hour the screens show the "ask for a new link in WhatsApp" hint instead of a Sign in again button. The refusal says so with `whatsapp: true` beside the error (Finish here's check with `{ mine: false, stale: true, whatsapp: true }`); no other method is ever named. Connect Telegram keeps refusing a WhatsApp session always.
  - The screens learn of a stale sign-in on the press (R3); `GET /api/signin-methods` gains no field.
  - A link entry or a flow written before this change has no `provedAt` and is treated as a Mini App start (unchecked); it expires within minutes.
- **A ban records the Google way's address.** `banIdentifier` also writes the normalised address stored on the account's Google way as an `email` row of the blocklist (one row when it equals the email way's address; none when `normalizeEmail` cannot keep it). Another account whose email way is that address is signed out on the web too, as every account holding a banned identifier is. So a hard-deleted Google-only account can't come back with the same address: the email code request, the sign-up and Add email all ask the blocklist. No migration. Existing bans are not backfilled (R5): Google ways exist only through the web sign-in, which stays hidden until its Railway variables are set.
- **Two wording fixes in the Privacy Policy** (all three languages): the short-lived copies' lead-in is "Among the copies we keep:" (the list is no longer only its longest copies), and the Google line among the providers reads "if you sign in or create your account with Google". The ban sentence now names the Google account's email address as well. The "Signing in." paragraph (“If you sign in with Google, FamCal asks Google only for…”) is unchanged (R4).
- **The ban in the two "only" sentences** (owner's A, 2026-11-05; all three languages): the sign-in data's uses ("To sign you in on famcal.bot") and the Google "Signing in." paragraph's "We use these only…" both add "and, if we ban the account, to stop it signing up again"; the paragraph's deletion list ends "except what a ban keeps (see “What stays after that”)".
- `LEGAL_UPDATED.privacy` is 2026-11-05; the Terms' date stays 2026-11-04.
