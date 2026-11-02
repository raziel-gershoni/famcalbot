# Web sign-in on famcal.bot (item 6b)

Status: approved by the owner, 2026-11-02, with §2.17 (Google Calendar connections sign in) added at the owner's request. Item 6 is 6a (public zmanim pages, live), 6b (this spec) and 6c (FamCal with no messenger). The facts were checked against the code at a5cb6ef6 and against the providers' live pages on 2026-11-02. Two independent reviews (security, and code facts with product and legal) are folded in.

## 1. Why

Today a browser gets into FamCal only through a one-time link that the WhatsApp bot sends. A Telegram user can't use FamCal outside Telegram at all, and nobody can come back to famcal.bot later and just sign in.

**Goal:** a person with a FamCal account opens famcal.bot in any browser, signs in with Telegram, Google or an email code, and uses the same web app they know from the Mini App.

**Success:**
- A Telegram user signs in on famcal.bot with Telegram and lands on their calendar.
- A person who connected Google Calendar signs in with that Google account at once. Another Google account or an email code works once added in Settings.
- They stay signed in for 30 days of use. They can sign out on this device or on every device.
- An idle FamCal makes no more database queries than today (Neon's free plan, CLAUDE.md). A signed-in request costs the same one user-row query as today. A sign-in costs a few queries (the account, the ban list, the last-used date), and only when a person acts.
- No sign-in secret (code, token, one-time check) or email address reaches a log line or Sentry.

## 2. Decisions

For the owner:

1. **Who can sign in: existing accounts only.**
   - The person must already have FamCal through Telegram or WhatsApp. Telegram works at once, and so does the Google account their calendar is connected from (§2.17). Another Google account and email work after the person adds them in Settings (§4).
   - A sign-in that matches no account gets a page saying so. If they use FamCal on WhatsApp, the page says to send "settings" there to get a link, then add Google or email in Settings. If they're new, it says to start FamCal in Telegram or WhatsApp.
   - New accounts made on the web are 6c.
   - Alternative: let a Telegram sign-in create a new account directly. The bot then can't message that person until they press Start, so their summaries and reminders would silently not arrive.
2. **How: our own sign-in on top of today's session cookie**, not Better Auth (which I proposed on 30 Oct).
   - **No extra reads.** Every user route already accepts the cookie, and a signed-in request still reads only the user row it reads today. Better Auth keeps sessions in its own tables.
   - **No fake emails.** Better Auth requires an email address on every user, which Telegram-only people would have to fake.
   - **Safer email codes.** Better Auth limits its codes per IP address only, and resets the number of tries with each new code.
   - **The repo's retry rules.** `openid-client` 6 (maintained, certified) checks Telegram's and Google's tokens, with Google's calls through `googleFetch` and Telegram's through `fetchWithRetry`.
   - **Size:** about 3–4 days of work, against 4–6.
   - **Cost:** we own the sign-in code. A certified library does the token checks, and the final review is a security review.
3. **Three ways, each asking for the least data.**
   - **Telegram:** Telegram's login (OpenID Connect) with `openid profile`. We use only the Telegram id, which FamCal already keeps.
   - **Google:** `openid email`, with no name or photo. We key on Google's account id, never on the email.
   - **Email:** a 6-digit code, valid for 10 minutes.
4. **Session length: 30 days, renewed while you use FamCal on the web.**
   - Settings gets **Sign out**, which clears this browser's cookie. To end a copied or stolen session, there's **Sign out on all devices**.
   - The WhatsApp link's session stays 24 hours and is never renewed.
   - Alternatives: 7 days, or 90 days.
5. **Email sender: Resend's free plan.**
   - 3,000 emails a month and 100 a day.
   - Codes come from `FamCal <signin@famcal.bot>`, with replies going to `privacy@famcal.bot`.
   - Its records go on `send.famcal.bot` and `resend._domainkey`, so they don't touch the inbound mail set up yesterday.
   - Resend keeps a copy of each email for up to 30 days.
   - Alternatives: Amazon SES (cheaper at scale, more setup) or Postmark (paid).
6. **No CAPTCHA.**
   - Signing in mails only addresses that are already on an account. Anyone else gets the same reply on screen and no mail.
   - **Add email** mails any address, but only from a signed-in account, at 3 addresses a day.
   - With the limits in §5, the form can't be used to mail strangers in bulk.
   - Cloudflare Turnstile comes with 6c, when sign-up by email opens.
7. **Google's button uses Google's own "G" mark.** Google's branding rules require it on a "Continue with Google" button. It is the one exception to Lucide-only; every other icon is Lucide, with no emoji.
8. **The Privacy Policy and the Terms change** in all three languages, with a new `LEGAL_UPDATED`. The draft English sentences are in §7, and the lawyer agent checks them before they ship.

Rulings (small choices; the owner can change any):

9. **Where Google and email are added:** Settings → **Sign in on the web**, in the Mini App and in the web app. Email works everywhere.
   - Google refuses to sign in inside in-app browsers, so from the Mini App, **Add Google** opens a one-time link (5 minutes) in your browser.
   - That link opens a famcal.bot page that names the account ("Add Google sign-in to Dana's FamCal"), with a **Continue** button. Only that press uses up the link and starts Google.
   - Afterwards that browser is signed in.
10. **Every added way sends a notice in your chat:** "Google d•••@gmail.com can now sign in to your FamCal. Not you? Settings → Sign in on the web → Remove." It's a reply to your own action, so the Shabbat pause doesn't hold it. A stolen session can't add a way quietly. One limit: a WhatsApp-only account gets the notice only inside WhatsApp's 24-hour window, since Meta refuses free-form messages outside it (the refusal is logged); a WhatsApp template for it is a backlog item.
11. **The site header** gets **Sign in** (header and phone menu), linking to `/signin`. When you're already signed in, `/signin` takes you straight to your calendar. The site stays static, and there's no extra cookie for this.
12. **One sign-in table**, `SignInIdentity`:
    - columns: kind (`google` or `email`); subject (Google's account id, or the email); the address to show; the user; when it was added and last used;
    - unique on (kind, subject) and on (user, kind), so one Google account and one email per person, each on one account only;
    - it is deleted with the account;
    - a WhatsApp-into-Telegram merge moves the WhatsApp row's sign-in ways to the Telegram row in the same transaction, keeping the Telegram row's where both have one;
    - we never match a person by an address they typed, a name or a phone number. The one address match is Google's own (§2.17): the connected calendar's account, confirmed live with Google.
13. **Ending sessions: one date on the user, `sessionsValidAfter`.**
    - It is read in the row every request already reads, so it costs no extra query.
    - These move it: **Sign out on all devices**, removing a sign-in way, a suspension, and a ban. A ban finds the row by the Telegram id or WhatsApp number it names. The device you removed a way from gets a fresh cookie.
    - Today a ban leaves a live session running; after this it doesn't.
14. **Fixes the web makes visible:**
    - **Send to chat:** the chat follows how you signed in. A WhatsApp-link session answers on WhatsApp. A Telegram, Google or email session answers on Telegram. A WhatsApp-only account signed in another way can't use the sheet, which says to open FamCal from WhatsApp, because WhatsApp refuses free replies after 24 hours. The success line names the chat used. (Today it says "Sent to WhatsApp" after a Telegram send.)
    - The **Open FamCal in Telegram** banner shows only to WhatsApp-only accounts. Today Telegram users see it, and its link starts WhatsApp linking.
    - Both "no access" cards (the page gate and the home screen's own) gain **Sign in**.
    - `/dashboard` reads the cookie and opens your calendar.
    - The Calendars screen's 10-second poll while a copy runs, and the home screen's midnight refetch, wait while the tab is hidden, so an open tab can't keep Neon awake.
    - The admin entry in the menu is hidden outside Telegram.
15. **These stay in the chat:** paying with Stars and finishing a Google Calendar connection, as today. The admin panel stays Telegram-only.
16. **The session cookie is renamed `__Host-famcal_session`** (Secure, Path=/, no Domain), so no famcal.bot subdomain can plant one. The cost: WhatsApp users with a session open at deploy (24 hours at most) sign in once more.
17. **The Google account a calendar is connected from also signs in** (the owner's request). The person already proved that account is theirs when they connected it.
    - **What we keep:** on the user, a keyed hash of the connected account's address (`googleAccountKey`, its key derived from `SESSION_SECRET` with its own label and stored with a key version), never the address itself, and `googleCalendarSignIn` (default on). The calendar consent has no `openid`, so the address is the account's primary calendar id (`googleAccountOf`, already used by the copy to Google).
    - **When it's written:** in `commitGoogleToken` on every connect and reconnect (one more Google call), and cleared by the disconnect. A WhatsApp-into-Telegram merge moves it with the Google connection. Accounts connected before 6b are not keyed at startup (the owner's decision, 2026-11-02, after the legal review: Google's User Data Policy asks to notify people and ask them before their data is used in a new way). Their Settings row offers **Turn on**; the press reads the primary calendar id once, live, and keeps its hash. A key made under another `SESSION_SECRET` no longer matches, and the row offers Turn on again.
    - **At sign-in:** when (google, sub) has no `SignInIdentity`, the hash of the token's verified email is looked up. Exactly one account with `googleCalendarSignIn` on, a live Google connection and no Google sign-in way yet → Google is asked again with that account's calendar token, and its primary calendar id must equal the verified email right now. Then a Google `SignInIdentity` is made for that sub, the person is signed in, and the chat gets a notice: "You signed in to FamCal on the web with Google d•••@gmail.com, the account your calendar is connected from. Not you? Settings → Sign in on the web → Remove."
    - **No match, a dead connection, or several FamCal accounts on the same Google account** (a shared family account) → the no-account page. For several, it says to add Google in Settings on the account they want. Google not answering → "try again", not the no-account page.
    - **In Settings:** before its first use, the Google row reads "The Google account your calendar is connected from" (no address, since we keep none), with **Remove** when its hash is kept, or **Turn on** when it isn't yet (connected before 6b, Google didn't name the account at connect, or keyed under another `SESSION_SECRET`). Turn on answers: on; shared (another FamCal account holds the same Google account, so nothing is kept: use Add Google); reconnect (the calendar's token is dead); or try again (Google didn't answer). A Google account held by several FamCal accounts shows no calendar row. **Add Google** shows whenever the row isn't on. Removing it, or removing a Google sign-in way later, turns `googleCalendarSignIn` off, so it isn't made again; **Add Google** still works. Disconnecting Google Calendar stops the match; a sign-in way already made stays, listed in Settings like any other.
    - **Google's data rules:** the address is used only for a feature the person sees (signing in with that Google account), and the Policy says so (§7). A connection made before the Policy said so is used for sign-in only after its owner presses Turn on.

## 3. Pages and flows

- **`/signin`**, in the (site) group, rendered per request:
  - three buttons: **Continue with Telegram**, **Continue with Google**, **Email me a code**;
  - it says that Telegram approval happens in a Telegram app, on this phone or another device;
  - inside Telegram's in-app browser, the Telegram button opens the Mini App instead, and the Google button says to open the page in your browser.
- **Telegram:** a redirect to Telegram's login, with PKCE (S256), a one-time state, a nonce and `origin=https://famcal.bot`, and RS256 tokens only.
  - On `/api/auth/telegram/callback`, `openid-client` checks the id_token against Telegram's published keys.
  - The account is found by the `id` claim, the Telegram user id. Telegram's `sub` is a different number per bot, so it is never used.
  - The nonce is checked when Telegram returns it. The first live sign-in records whether it does.
- **Google:** the same shape, on its own OAuth client, without `include_granted_scopes`, on `/api/auth/google/callback`.
  - `openid-client` checks the token: signature, issuer, audience (only the sign-in client), expiry and nonce. `email_verified` must be true.
  - The account is found by (google, sub), or else by the connected calendar's account (§2.17).
- **Email:**
  - **The address:** accepted only as ASCII after trimming; an IDN domain is turned into punycode first. Anything else gets the generic answer.
  - **Where the code goes:** to the address stored on the row, never to the typed text.
  - **One answer for everyone:** the screen always says "If this email is on a FamCal account, we sent a code."
    - Every limit is counted, and answered in the same words, for unknown addresses too, before the account lookup.
    - Making, storing and mailing the code run after the response (Next `after()`).
    - A wrong code for an unknown address gets the same "wrong or expired code" answer.
  - **The code:** stored only as a keyed hash. A new code replaces the old one, a correct one is used up at once (`GETDEL`), and tries are counted (`INCR`) before the comparison.
  - **Sending:** through `fetchWithRetry` with an idempotency key. A failed send logs the user id, the status and Resend's id, never the body.
- **The one-time checks** (state, PKCE verifier, nonce, and the email flow's request) live in Redis for 10 minutes and can be used once.
  - They are bound to the browser by `famcal_signin`: httpOnly, Secure, SameSite=Lax, path `/api/auth`, cleared after use.
  - A callback whose state doesn't match the record under that cookie is refused. A callback without the cookie says to start again in the browser you began in.
  - `redirect_uri` comes from the app's base URL, never from the request's Host. The token comes back in the query. There's no return-path parameter.
  - Every sign-in and Settings POST must come from `https://famcal.bot` (its Origin) and send JSON. Together with the cookie, this blocks login CSRF: someone else's sign-in landing in your browser.
- **One finishing step** for every way, including the existing WhatsApp link:
  - refuse a suspended account, or one whose Telegram id or WhatsApp number is banned, with its own page;
  - set the cookie, with how you signed in (`tg`, `google`, `email`, `wa`) and the sign-in time in milliseconds;
  - redirect to `/{language}/dashboard?user_id=…`, or the page the WhatsApp link names (`select-calendars`);
  - the language is the person's own.
- **The session cookie:**
  - It is refused when its sign-in time is before `sessionsValidAfter`. A cookie made before 6b counts its `iat`.
  - It is renewed only by `/api/page-data`, after the row check accepted it, when it is over a day old and wasn't made by a WhatsApp link. A renewed cookie keeps its first sign-in time and method.
  - A response that refuses a cookie which passed its signature check (revoked, suspended, banned, no row) also clears it. `/signin` and the card then show the buttons, instead of looping.
- **UI:** the frontend-design skill designs `/signin` and the Settings group, in the site's and the app kit's tokens.
  - All copy goes through `messages` in he, en and ru: the pages, the email in the person's language, the notices and the errors. `/signin`'s client strings sit in the `site` namespace.
  - Hebrew is gender-neutral and Russian formal.
  - Inputs are 16px, so iOS doesn't zoom on focus.

## 4. Settings: Sign in on the web

A new group in Settings (Mini App and web app):
- **Telegram:** shown as on for Telegram accounts. Nothing to add.
- **Google:** **Add** starts Google's sign-in (§2.9), then shows the address. **Remove** asks first. With Google Calendar connected and no Google way yet, the row shows the calendar's account (§2.17).
- **Email:** **Add** asks for the address, mails a code, then asks for the code. An address already on another account is refused only after its code is right. **Remove** asks first.
- Adding sends the chat notice (§2.10). Removing signs out every web session (§2.13).
- **Sign out** (web only) and **Sign out on all devices**.
- Telegram and WhatsApp can't be removed here.

## 5. Limits

| What | Limit |
|---|---|
| Codes to one email | 1 a minute, 5 a day |
| Code requests from one address | 20 an hour |
| Add-email codes per account | 3 addresses a day |
| Tries per code | 5, then the code is void |
| Wrong codes for one email | 10 a day, then email sign-in for it pauses for a day |
| Wrong codes from one address | 20 an hour |
| All codes sent | 90 a day (Resend allows 100). After that, email sign-in pauses until 00:00 UTC, and the admin gets one Telegram message |
| Telegram and Google callbacks | one use per state, 10 minutes |

- The limits live in Upstash, under hashed keys, for at most a day. They run before any database lookup.
- An address is the client IP: `x-real-ip`, as the zmanim pages use it. An IPv6 address counts by its /64.
- Before launch, one real request confirms that Railway sets `x-real-ip` and overwrites a value the client sends.

## 6. What the owner does (once; the plan gives exact values and a copy-paste list)

1. **BotFather → the bot → Login Widget:**
   - domain `famcal.bot`, callback `https://famcal.bot/api/auth/telegram/callback`;
   - put the Client ID and Client Secret into Railway as `TELEGRAM_LOGIN_CLIENT_ID` and `TELEGRAM_LOGIN_CLIENT_SECRET`.
   - BotFather warns that this switch can't be undone. FamCal uses nothing from the old login, so nothing is lost.
2. **Google Cloud, the same project:**
   - a new Web client "FamCal sign-in", with redirect `https://famcal.bot/api/auth/google/callback`;
   - put its values into Railway as `GOOGLE_SIGNIN_CLIENT_ID` and `GOOGLE_SIGNIN_CLIENT_SECRET`.
3. **Resend:**
   - make an account, add `famcal.bot` in region eu-west-1, and let it write its DNS records to Cloudflare;
   - put the API key into Railway as `RESEND_API_KEY`.
   - Optional: a DMARC record (`_dmarc`, `v=DMARC1; p=none`) for better delivery.
4. **Startup checks and the README:** the new variables go into the startup checks and the README's table. The secret names match the log scrubber's pattern.

## 7. Legal text (English draft; he and ru follow after approval, lawyer-checked)

**Privacy:**
- **Who we are:** "…through a web app that opens from the bot, or when you sign in on famcal.bot…"
- **Cookies:** "`__Host-famcal_session` keeps you signed in to the web app.
  - After you sign in on famcal.bot with Telegram, Google or an email code, it lasts 30 days from your last visit.
  - After you open the web app from a WhatsApp link, it lasts 24 hours.
  - While you sign in, `famcal_signin` holds a one-time check for 10 minutes."
- **What we keep:** "If you add Google sign-in, or sign in with the Google account your calendar is connected from: your Google account id and its email address. If you add email sign-in: that email address. For each, when you added it and last used it. If you connected Google Calendar: a scrambled form of that Google account's address, so we can recognise it when you sign in with it. We use them only to sign you in and to send you sign-in codes."
- **Google user data:** "If you sign in with Google, FamCal asks Google only for your account id and email address. If you connected Google Calendar, signing in with that same Google account signs you in to your FamCal: we check it is the same account by reading your primary calendar's id (its address) with the calendar permission you gave. We use these only to sign you in, never share them, and delete them when you remove Google sign-in, disconnect Google Calendar (the scrambled address) or delete your account."
- **Processors:**
  - Telegram's line adds "signing in to famcal.bot with Telegram".
  - New: "**Google**, if you sign in with Google: your Google account id and email address, to sign you in."
  - New: "**Resend**: your email address and the sign-in code, to email you the code. Resend keeps a copy of each email for up to 30 days."
  - Resend also joins the list of processors bound by their terms, and the transfers line (the US).
- **Server logs:** the IP sentence widens: "…and to stop misuse of sign-in, we count sign-in attempts per IP address and per email address in Upstash, under scrambled keys, for up to a day."
- **Retention:** "Sign-in methods: until you remove them or your account is deleted. Sign-in codes: 10 minutes. Sign-in counters: up to a day."
- **Security:** "On famcal.bot it checks the session cookie set when you signed in."
- **Your rights:**
  - "You can remove a sign-in method in Settings."
  - Deleting an account also deletes its sign-in methods.

**Terms:**
- **Account security:** "Anyone who can use your Telegram or WhatsApp account, the Google account your calendar is connected from, or a Google account or mailbox you added for signing in, can use FamCal as you."
- **Eligibility** is unchanged: an account still needs Telegram or WhatsApp.

## 8. Testing

- **Flows:**
  - State, nonce and PKCE are refused when wrong, reused or late.
  - A Telegram sign-in finds the person by `id`, never by `sub`.
  - A Google sign-in is refused when `email_verified` is false or the audience is the calendar client.
  - The calendar match (§2.17): one account with a live check that agrees signs in and gets the notice; a live check that disagrees, a dead connection, two accounts on one Google account, `googleCalendarSignIn` off, or an account that already has a Google way each fall back to the no-account page; removing the way turns the match off; disconnecting clears the hash; Turn on keys the account once after a live check and answers shared, reconnect or try again; Settings shows Add Google for a shared or not-yet-on account.
  - An unknown identity, a suspended account and a banned account each get their page.
  - The WhatsApp link still opens Select calendars.
  - A POST from another Origin is refused.
- **Email:**
  - The same words and timing for known and unknown addresses.
  - Every limit in §5, with tries counted before the compare.
  - A Kelvin-sign or other non-ASCII address is refused.
  - The code goes to the stored address.
  - The code is stored only as a hash.
- **Sessions:**
  - 30 days, with renewal only in page-data.
  - Refused before `sessionsValidAfter`, with millisecond sign-in times.
  - Revoked and refused cookies are cleared, with no loop.
  - A WhatsApp-link cookie is never renewed.
  - A ban, a suspension and removing a way end sessions.
  - A merge keeps the WhatsApp row's ways.
- **Leaks:** a smoke posts `{email, code}` to a failing route and finds neither in the Sentry event. The scrubber drops `code`, `state`, `token`, `id_token` and `email` from URLs, queries and JSON or form bodies.
- **The pause rule:** `smoke-pause` learns the email sender and lists it as a reply to the person's own action, along with the chat notice.
- **Neon:** an idle pass still makes no query. The Calendars poll and the midnight refetch stop in a hidden tab.
- **Send to chat:** each kind of session goes to the right chat, and a WhatsApp-only account without a WhatsApp-link session gets the hint.
- **Live check:** one real sign-in with each way, on an iPhone (Safari, with and without the Telegram app) and on a desktop.

## 9. Non-goals

- New accounts on the web.
- Accepting a partner invite on the web.
- Web push and FamCal with no messenger (6c).
- Paying outside Telegram.
- The admin panel on the web.
- Passkeys and Apple sign-in. Apple's rule applies to App Store apps, not websites.
- The brief light flash before dark mode in the web app.

## 10. Answered

1. Google Auth Platform → Audience is **In production** (the owner, 2026-11-02), so any Google user can sign in.
