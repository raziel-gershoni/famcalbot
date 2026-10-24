# Disconnect Google

Status: approved by the owner, 2026-10-25.

## Goal

A user who connected Google Calendar can disconnect it from the Mini App and becomes a
FamCal-only user. Nothing keeps reading Google, nothing keeps writing to it, and the stored
Google token is gone both here and at Google. Connecting again works from scratch.

## Decisions (owner-approved)

1. Settings gets a "Google Calendar" section (shown only while a token is stored) with a
   "Disconnect Google" button, in the Settings page's own look: mobile first, no hover, 44 px
   targets, logical properties for RTL. The confirmation follows the page's modal pattern and
   also follows the device's light or dark setting.
2. The confirmation has a checkbox, "Also delete the FamCal copies from Google", ticked by
   default. The copies are the "FamCal · <name>" calendars that Copy to Google made with the
   calendar.app.created scope. Only the ACTIVE copies are deleted: a copy the user earlier
   turned off with "Keep it in Google" stays in Google untouched (owner's call, review r3), and
   the confirmation says so. The confirmation also says that anyone else in the family who
   connected the same Google account will need to connect again (the revoke cuts the grant for
   every FamCal user of that account).
3. On confirm the server first sets the user's disconnect marker (`google-sync:disconnect:<id>`,
   `busy:<ms>`, then `done:<ms>` at the end) and then proceeds at once; it never waits for the
   copy worker or its lock. The worker's runs started before the marker check it before every
   write and send (items, calendar steps, outage state, the "reconnect Google" message) and
   stop; a copy calendar such a run made meanwhile is deleted by the run (best effort, logged,
   sent to Sentry), and one it can't delete stays on the link and is recorded
   (`google-sync:orphans:<id>`) for the result's list. A run that starts after the disconnect
   reads the user and links again after taking its lock and finds nothing to do. In this order:
   0. A Keep the user chose that the worker has not carried out yet is carried out now, box
      ticked or not, while the token works (the calendar's description says FamCal no longer
      updates it). Best effort; that calendar is never deleted or listed.
   a. Box ticked: delete the active copy calendars through the Google API while the token still
      works (a Keep copy is skipped). Best effort per calendar; the ones that fail are recorded.
      The links of the deleted calendars are dropped at once, before the revoke.
   b. Revoke the token at Google (https://oauth2.googleapis.com/revoke). Best effort: a
      failure is logged and sent to Sentry.
   c. Always clear local state, whatever happened in a and b (list below).
   d. Write an activity row, `calendar_disconnected`.
4. The result screen says Google is disconnected and lists every copy calendar that could not
   be deleted, so the user can remove it in Google.
5. Afterwards: summaries, reminders and the home stop reading Google without error messages
   (the same `sourcesFor` rule as a user who never connected), and the Connect Google flow
   works again from scratch.
6. The privacy page's retention paragraph (en, he, ru) says exactly what happens.
7. Auth: the user themself, through `verifyUserAuth` (Mini App initData, or the WhatsApp
   session), with the settings rate limiter, like `/api/google-sync`.

## Flow

Settings -> "Disconnect Google" -> confirmation (checkbox) -> `POST /api/google-disconnect`
`{ deleteCopies: boolean }` -> `disconnectGoogle(userId, { deleteCopies })` in
`src/services/google-disconnect.ts` -> result `{ status: 'disconnected', leftover: string[], revoked: boolean }`
-> result screen (leftover names, or just "disconnected") -> Done hides the section.

One service function is the only code path. The bot has no disconnect command, so Telegram
and WhatsApp users reach it through the Mini App (Telegram initData or the WhatsApp session).

### Step a: delete the copies

For every `GoogleSyncLink` of the user except one turned off with Keep (`!enabled &&
unlinkChoice === 'keep'`, carried out or still queued), `turnOffInGoogle(..., 'remove', ...)` (the worker's and
the hard delete's own code path) runs with the link's `unlinkToken` or else the user's token.
It checks the token's Google account, re-reads the calendar and acts only on a calendar
carrying the link's `[famcal:<linkId>]` token. Outcomes:

- `deleted` or `gone`: done.
- `emptied` (the user had added their own events, so only FamCal's were removed and the
  calendar stays), `foreign`, `otherAccount`, or any thrown error: the calendar is listed in
  the result.

### Step b: revoke

`POST https://oauth2.googleapis.com/revoke` with the refresh token (and any `unlinkToken`),
form-encoded. Revoking cuts the whole grant, calendar.app.created included, which is why
step a comes first. A 400 `invalid_token` means it was already dead and counts as revoked.

### Step c: state cleared (always)

Database, in one transaction:
- `User.googleRefreshToken = ''`, `googleScopes = []`, `googleSyncNotifiedAt = null`,
  `calendarAssignments = NULL` (the Google calendar choices and selections).
- Copy links whose Google calendar is gone: row deleted (items cascade), in step a already.
  Every other link (box unticked, a Keep copy, or the delete failed): kept but turned off with
  its queued choice, `unlinkToken` and queue cleared, so the worker stops and FamCal keeps
  hiding that Google calendar from its Google lists if the user connects again. That needs
  only the calendar's id, so `googleAccount` (usually the email address) is cleared; no
  Google account id or email stays anywhere.
- The user's open `OAuthState` rows (an unfinished consent).

Redis, each step logged and sent to Sentry on failure, never thrown:
- the Google read cache: the stamp (`stampGoogleCache`, which also drops the in-process
  recurrence cache) plus the stored `gcal:range:v1:<id>:*` and `gcal:fresh:<id>:*` entries;
- live colours `gcal:colours:<id>` and the gone warning `gcal:gone_warned:<id>`;
- the reminder cache entry: `syncReminderCacheEntry` (reminder-cache.ts, the one rule the
  settings route and the account merge use too): the entry without a token for a user who still
  gets reminders (everyone has FamCal), else removed;
- the voice flows' `voice:recent:<id>` and `voice:last_created:<id>`, and the user's open
  `voice:pending:*` confirmation cards (found by the user inside them);
- feature access caches (`invalidateFeatureAccessCache`);
- copy link retries (`clearLinkRetries`), the Google setup tracks (`clearGoogleTracks`), the
  `googleConnected` flag and the resolved-timezone cache (`tz:user:<id>`, which may have come
  from Google).

## Failure handling

- Step a or b failing never stops step c. Each failure is logged with the user and link ids and
  sent to Sentry (`google-disconnect-copy`, `google-disconnect-revoke`).
- A token that cannot be decrypted skips a and b, logged and captured; c still runs and every
  copy with a stored calendar id is listed.
- The database transaction failing is the one failure that returns an error (500). The token
  may be revoked by then, so the error line does not say "nothing was changed": it says the
  disconnect didn't finish, Google may already have lost access, and to try again. The retry
  completes: the deleted copies' links were dropped before the revoke, so they are not listed
  as left over, and a token Google has as dead counts as revoked.
- A repeated or double-tapped request is harmless: with no token and no links it only clears
  caches again.
- The page shows a retryable error line; it never shows raw error text.

## Non-goals

- No disconnect from the chat (no command), no bulk or admin disconnect.
- No change to hard-delete or account merge behaviour.
- Settings stays light-only on its page; only the new confirmation follows the device scheme.

## Tests (`scripts/smoke-google-disconnect.ts`, in `scripts/ci-smokes.sh`)

All with fakes (in-memory Prisma and Redis, fake Google client, stubbed fetch, captured errors).
1. Order: copies deleted, then revoke, then local clear.
2. Box unticked: no copy deleted, links turned off and queue cleared, the rest the same.
3. A copy failing, `emptied`, `foreign`: listed; the others deleted; the clear still runs.
4. Revoke failing (network, non-2xx): captured, clear still runs; `invalid_token` counts as revoked.
5. State cleared: token, scopes, choices, links, OAuth states, every Redis key above.
6. After: `googleStateOf` is `none`, `sourcesFor` is `['famcal']`, the worker has no link to pick, a
   fresh `commitGoogleToken` works.
7. Route: 401 without auth, 400 on a bad body, rate-limited like settings, the user's own id only.
8. Activity row written, declared and worded in the admin timeline.
9. UI: the section only when connected; confirmation, working, result and error states in en,
   he, ru; checkbox ticked by default; 44 px targets; no hover-only rules; no raw keys, no emoji.
10. i18n parity and the privacy copy in all three languages.
