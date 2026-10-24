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
   calendar.app.created scope.
3. On confirm the server does, in this order:
   a. Box ticked: delete the copy calendars through the Google API while the token still
      works. Best effort per calendar; the ones that fail are recorded.
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

For every `GoogleSyncLink` of the user, `turnOffInGoogle(..., 'remove', ...)` (the worker's and
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
- Copy links whose Google calendar is gone: row deleted (items cascade). Every other link
  (box unticked, or the delete failed): kept but turned off with its queued choice,
  `unlinkToken` and queue cleared, so the worker stops and FamCal keeps hiding that Google
  calendar from its Google lists if the user connects again.
- The user's open `OAuthState` rows (an unfinished consent).

Redis, each step logged and sent to Sentry on failure, never thrown:
- the Google read cache: the stamp (`stampGoogleCache`, which also drops the in-process
  recurrence cache) plus the stored `gcal:range:v1:<id>:*` and `gcal:fresh:<id>:*` entries;
- live colours `gcal:colours:<id>` and the gone warning `gcal:gone_warned:<id>`;
- the reminder cache entry: `updateUserInCache` without a token for a user who still gets
  reminders (everyone has FamCal), else `removeUserFromCache`, by the settings route's rule;
- feature access caches (`invalidateFeatureAccessCache`);
- copy link retries (`clearLinkRetries`), the Google setup tracks (`clearGoogleTracks`), the
  `googleConnected` flag and the resolved-timezone cache (`tz:user:<id>`, which may have come
  from Google).

## Failure handling

- Step a or b failing never stops step c. Each failure is logged with the user and link ids and
  sent to Sentry (`google-disconnect-copy`, `google-disconnect-revoke`).
- A token that cannot be decrypted skips a and b, logged and captured; c still runs and every
  copy with a stored calendar id is listed.
- The database transaction failing is the one failure that returns an error (500): nothing was
  cleared locally, the user can retry, and a retry finds the copies already gone.
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
