# Remind us both: design

**Date:** 2026-10-26 · **Status:** for the owner's review. Builds on the native reminders spec
(`2026-10-14-native-reminders-design.md`, where "Remind us both" was left out of scope) and keeps
its rulings R1–R12 unless this spec says otherwise.

## Goal

Today a reminder is for exactly one person: its creator, or the creator's partner. A paired user can
now make one reminder for **both of us**: both partners are pinged, both see it, and one Done closes
it for both.

## Owner decisions (2026-10-26)

1. **Done:** one Done covers both. The other person's ping turns into "✅ Done by {name}" and they get
   the usual silent "Done by" note.
2. **Snooze:** per person. Only the person who snoozed is pinged again; the other's ping stays as it is.

## Behaviour

- **Who "both" is:** the creator and the partner stored on the reminder, while that partner is still
  the creator's ACTIVE partner and can receive pings (Telegram, not suspended, unreachable or
  blocked). Otherwise it is a reminder for the creator alone. This is worked out on every read, like
  R2, so unpairing writes nothing and a later new partner never inherits it.
- **Pings:** each person is pinged at the reminder's time; a date-only reminder pings each at their
  own morning time (`User.reminderTime`, default 09:00), each in their own timezone. The ping reads
  "⏰ {title}" plus a line "for both of you" (instead of "from: {name}").
- **Done (either person, from the ping or the app):** the occurrence is done for both. Every other
  live ping of that occurrence is edited to "✅ Done by {name}" without buttons, and the other person
  gets the existing silent `doneBy` note ("✅ Done by {name}: {title}"). Exactly one note per person.
  Undo in the app reopens it for both.
- **Snooze (either person):** only the snoozer is pinged again at the snooze time; "Tomorrow" uses
  the snoozer's timezone and morning time (as today). The app's state line shows the viewer's own
  snooze. Undo clears the shared Done and the viewer's own snooze.
- **Who may act:** Done, Snooze and Undo: either person. Edit: the creator only (unchanged).
  Delete: the creator or the partner (unchanged rule for the person a reminder is for).
- **Seeing it:** both partners see it in the Mini App calendar regardless of calendar sharing (as a
  reminder for the partner works today), in both daily digests, and in both "open since" carry-over
  lists until done. In the digests it sits in each viewer's own section, marked "for both of you".
- **Gates (unchanged):** the creator's plan access decides (checked at fire time); pings and notes go
  to Telegram only (R12); reminders are never copied to Google.

## Creating and changing it

- **Voice / forwarded / typed text:** the extraction's "who" rule gets a third value, `both`, for
  "remind us", "remind both of us", "remind me and Dana", «תזכיר לנו», «תזכיר לשנינו», «напомни нам»,
  «напомни нам обоим». Today these become `self`. With no partner, or a partner who can't be pinged,
  it falls back to `self` (with the existing "partner isn't on Telegram" notice when there is a
  partner). Other people named stay in the title, as today.
- **Confirmation card:** "📆 {when} · for both of you"; the created line "Reminder set for both of
  you…" (with its date-only form). The existing "Keep as mine" button also turns a "both" into a
  reminder for the creator alone.
- **Mini App editor:** the "For" row becomes three options: Me / {partner} / Both of us, on create
  and on edit, under the same conditions as the partner option today (the partner can be reminded;
  on edit, the creator only). Changing who it's for keeps today's rule: the open occurrences' ping
  state is cleared and their live pings edited ("now for both of you" / "now for {name}").
- **Chat edits** still can't change who a reminder is for (as today).

## Data model

- `NativeEvent.forBoth Boolean @default(false)`. A "both" reminder stores `forUserId` = the partner
  and `forBoth = true`; recipients = `[creator, forUserId]` when R2 accepts `forUserId`, else
  `[creator]`. A single reminder is unchanged (`forBoth = false`, recipient = R2's owner). Keeping
  `forUserId` = the partner means the existing partner paths (visibility merge, delete rule, account
  merge) need no new column.
- **New `NativeReminderPing`**, one row per occurrence per recipient: `stateId` → `NativeReminderState`
  (cascade), `userId` → `User` (cascade), `snoozedUntil`, `lastPingedAt`, `pingAttempts`, `pingChatId`,
  `pingMessageId`, timestamps; unique `(stateId, userId)`, index on `snoozedUntil`.
  `NativeReminderState` keeps the occurrence-level `doneAt` / `doneByUserId`. Every reminder (single
  or both) uses the new table, so there is one code path; a single reminder simply has one row.
- **The claim** stays one atomic statement per recipient: ensure the occurrence's state row, then
  insert-or-update the recipient's ping row only while the occurrence isn't done and that recipient's
  `lastPingedAt` is before the due time. Release, undo and the 3-attempt cap work per ping row.
  Button data keeps the occurrence id (`nr:d:<stateId>`, `nr:s15:<stateId>`…); the tapping user picks
  the ping row.
- **Migration, two pushes** (a deploy migrates while the previous build still serves):
  1. Add `forBoth`; create `NativeReminderPing`; copy each state row's ping columns into a ping row for
     its recipient (`COALESCE(forUserId, creatorUserId)`). The state table's old ping columns leave
     the Prisma schema in this push but stay in the database; for this one release the claim also
     treats an old `lastPingedAt` at or after the due time as already pinged (raw SQL), so a ping the
     old build sends during the deploy is not sent twice.
  2. A later push drops those old columns and the fallback.

## Error handling and logging

Each recipient's send is independent: one person's failure (blocked bot, unreachable) is logged with
the occurrence id and recipient id and never stops the other's ping. The "Done by" edit and note
failures are logged and don't undo the Done. All new paths log through the existing reminder logs and
Sentry, with ids, never titles.

## Testing

- Smokes (DB and Telegram mocked): recipients (paired, unpaired, partner without Telegram, a new
  partner), the per-recipient claim (each pinged once, each at their own morning time for a date-only
  one, a retry for one recipient only), Done from either side (shared, the other ping edited, one note
  each), per-person Snooze and Undo, the digest sections and carry-over for both, the Mini App
  visibility and actions for both, the editor's three-way For row, the migration's copy and the
  deploy-window fallback.
- **LLM prompt (paid, needs the owner's OK first):** add "remind us" cases in en/he/ru to
  `scripts/eval-native-reminders.ts`. Run only the new cases first (about 9 calls, roughly
  $0.10–0.15), stop on the first failure, then the full table (about 56 calls, roughly $0.60–0.80)
  to confirm nothing else moved.

## Out of scope

More than two people (children, others), per-person Done, Google copies of reminders, WhatsApp pings,
chat edits that change who a reminder is for.
