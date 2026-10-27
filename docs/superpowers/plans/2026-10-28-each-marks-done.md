# "Each of us marks it done", Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a reminder for both partners can be set so that each person marks their own Done. Whoever is done stops being pinged; the other keeps being reminded until they tap Done too.

**Owner decisions (2026-10-27/28):**
- "shared reminders with mark done for each of the participants". The owner chose "a choice per reminder", and the default stays as today (one Done covers both).
- **Editor only for now:** voice and text parsing do not change, so there is no paid eval.

This supersedes the "per-person Done" out-of-scope line in `docs/superpowers/specs/2026-10-26-remind-us-both-design.md` for reminders that have the switch on.

**Research map** (file:line on main 001747e): `<S>/each-done-research.md`. Read it first.

`<S>` = /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad

## Rules (decided by the controller)

**Data:**
- `NativeEvent.eachMarksDone Boolean @default(false)`. It is meaningful only with `forBoth`; the server stores false whenever `forBoth` is false.
- `NativeReminderPing.doneAt DateTime?`.
- The migration adds both columns, idempotently; there is no drop, so one push is enough. `scripts/smoke-remind-us-both-migration.ts`'s column check is updated with the same intent.

**Per viewer:**
- A person's own done is `state.doneAt != null || (eachMarksDone && theirPing.doneAt != null)`.
- `state.doneAt` keeps meaning "done for everyone". With the switch off, everything reads exactly as today.

**Done with the switch on** (in `applyReminderAction`):
- Lock first, as the snooze does: touch or create the state, then upsert the actor's ping row with `doneAt`. If the actor's own done is already set, the status is `already_done`.
- Then, inside the same transaction, count the done of the current recipients who can be reached. This is the set pings go to (`recipientIds`, filtered by `isPingable`), plus the actor.
- When everyone is done, set `state.doneAt` and `doneByUserId` (the last one). The result says whether this completed the occurrence.

**Undo with the switch on:**
- Clear the actor's `ping.doneAt` (`not_done` if it wasn't set), and clear `state.doneAt` if it was set (it is no longer done for everyone).
- Clear the actor's own snooze, then `invalidateDueGate()`.

**The pass, claim and snooze scan:** they skip any recipient whose own done is set. The claim SQL gains the ping-level condition, and its fake regex in `smoke-native-reminders.ts` follows.

**Telegram, with the switch on:**
- The actor's ping closes as done today ("✅ title").
- The other person's live ping is edited in place. Its buttons stay (`reply_markup` is re-sent; Telegram's "message is not modified" error is tolerated and logged at debug), and it gains a line, `bot.nativeReminders.ping.partnerDone`.
- No separate "Done by X" message is sent for these reminders.
- A ping built later for someone whose partner is already done carries the same line (`buildPingText` and the pass's late-done branch).
- With the switch off, nothing changes: the shared Done and the "Done by X" note stay as today.

**Digests, lookahead and the home:** they use the viewer's own done; the reminder drops out for the person who is done only. `reminderInfoFor` gains `eachMarksDone` and `partnerDone` (`true`, `false`, or `null` when the switch is off or there is no partner). Everything else inherits from it.

**Changing the switch:**
- It is series-level (scope `following` or `all`; `single` is refused on a repeating series, like `forWho`).
- Done occurrences stay done.
- Open occurrences lose any partial per-person done. Their state rows are reset through the existing reassign path, so a later off→on never brings partial progress back.
- Live pings are left as they are (the silent "staying" treatment, not the "now for…" text).
- `following` copies the flag to the new series.
- A change of `forWho` away from `both` clears the flag.

**The editor:** a `SwitchRow` sits under the For row and shows only when For is "Both of us". The wire field is `eachMarksDone` in the create body and the update changes. Both validate allow-lists gain it; the server refuses it, or stores false, when the reminder is not for both. Item info returns it.

**The item sheet:** with the switch on, a line under the state reads the partner's status, `calendarHome.sheet.partnerDone` or `partnerNotDone`. The row keeps the viewer's own state.

**Accounts and reach:**
- Account merge moves ping rows as today; the surviving row's `doneAt` wins.
- After an unlink, the recipients shrink to the creator, whose own done decides.
- An unreachable partner is not counted for "everyone done", as pings already follow reachable recipients.

**Copy** (exact):

| Key | en | he | ru |
|---|---|---|---|
| calendarHome.editor.eachMarksDone | Each of us marks it done | כל אחד מסמן בוצע בעצמו | Каждый отмечает сам |
| calendarHome.editor.eachMarksDoneHint | It stays open for whoever hasn't tapped Done yet | התזכורת נשארת פתוחה למי שעוד לא סימן בוצע | Напоминание остаётся открытым для того, кто ещё не отметил «Готово» |
| calendarHome.sheet.partnerDone | {name} is done | {name}: בוצע | {name}: готово |
| calendarHome.sheet.partnerNotDone | {name} hasn't marked it yet | {name}: עדיין לא | {name}: ещё нет |
| bot.nativeReminders.ping.partnerDone | ✅ {name} is done | ✅ {name}: בוצע | ✅ {name}: готово |

## Global Constraints
- The switch-off behaviour is byte-identical to today; every existing "both" smoke stays green unchanged.
- Never swap `user.id` and `telegramId`.
- No silent failures.
- No inline strings.
- Times use the wall-time resolver (CLAUDE.md).
- Gate: `npx prisma generate && npx tsc --noEmit && npx eslint . && bash scripts/ci-smokes.sh && npx tsx scripts/check-i18n-parity.ts`. Never run a build or touch the DB; migrations apply on deploy.
- Tests: every new check is shown to fail with its fix removed.

## Review Focus
1. **Two Dones at the same moment:** exactly one completes the occurrence; `state.doneAt` is set once; neither is lost.
2. **The other's ping:** after the first Done it still has its buttons and the new line; a ping sent later carries the line; the person who is done is never pinged again, even if they had snoozed.
3. **Undo:** after a partial Done, the actor is reminded again (from the next due check, without re-pinging the past); after the last Done, the occurrence is open again for the one who undid.
4. **Changing the switch or `forWho`:** done occurrences stay done, partial progress never comes back, and live pings are not stripped.
5. **Unlink, or an unreachable partner:** the creator's own Done finishes the occurrence for them, and digests stop carrying it.

---

### Task 1: The server (data, the actions, the pass, Telegram, the readers)
**Files:**
- `prisma/schema.prisma` and a new `prisma/migrations/20261028000000_each_marks_done/migration.sql`;
- event-store.ts (every place that copies `forBoth`, per the map);
- calendar-provider types and native-provider;
- calendar-write validate.ts, write.ts and item-info.ts;
- native-reminders actions.ts, pass.ts, claim.ts, due.ts, ping.ts and open-reminders.ts;
- ownership.ts;
- dto.ts and famcal.ts;
- `app/api/calendar/reminder/route.ts`;
- messages (`bot.nativeReminders.ping.partnerDone`).

- [ ] **Step 1: Failing checks,** extending the smokes listed in the map:
  - **actions:**
    - with the switch on, the first Done marks only the actor and the result is not complete;
    - the second Done completes it;
    - two Dones at once complete it once;
    - undo, partial and full;
    - `already_done` means the actor's own;
    - a never-pinged partner gets a ping row on their Done;
    - with the switch off, the old cases are unchanged;
  - **the pass and claim:**
    - the person who is done is skipped, including after a snooze;
    - the other is still pinged, and that ping carries the line;
    - the claim SQL fake follows the new condition;
  - **buttons:**
    - Dana's Done closes her ping and edits his, keeping the keyboard, with the line;
    - no "Done by" message is sent;
    - with the switch off, unchanged;
  - **the store and editor API:**
    - create with the switch, read it back in item info;
    - refused, or stored false, when not for both;
    - a series-level change with `following` copies the flag;
    - toggling resets partial progress and keeps done occurrences;
    - `forWho` away from both clears the flag;
  - **provider, digest and DTO:**
    - `reminderInfoFor` gains `eachMarksDone` and `partnerDone` (update the exact-JSON expectations);
    - the digest drops the reminder only for the person who is done;
  - **migration:** the column check covers the two new columns;
  - **voice/text create flow:** the flag stays off.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** to the Rules.
- [ ] **Step 4: Run** every reminder smoke under TZ=UTC and Asia/Jerusalem, plus the full gate. Expected: PASS.
- [ ] **Step 5: Mutations:**
  - no lock (two Dones both incomplete);
  - the pass ignores the ping-level done;
  - the edit strips the buttons;
  - the toggle keeps partial progress;
  - the switch-off path changed.
- [ ] **Step 6: Commit** `feat(reminders): "each of us marks it done" for a reminder for both: a Done is the person's own, the other keeps being reminded`.

### Task 2: The Mini App (the editor switch and the partner line)
**Files:**
- EditorSheet.tsx, editor-model.ts, editor-types.ts and editor-client.ts;
- the client DTO types, agenda.ts if needed, and ItemSheet.tsx;
- messages (the four `calendarHome` keys);
- `smoke-calendar-home-render.ts` and `smoke-calendar-editor-api.ts`.

- [ ] **Step 1: Failing checks:**
  - **the switch:** it shows only when For is "Both of us" and is sent in the create and update bodies (only when changed); a scope plan is required on a repeating series;
  - **the sheet:** it shows the partner line for both states in en/he/ru;
  - **the row:** it keeps the viewer's own state;
  - no React warnings.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the gate. Expected: PASS.
- [ ] **Step 5: Screenshots** into `<S>/each-shots/`: the editor with For "Both of us" and the switch, in he light; the sheet with "Dana: done", in en dark.
- [ ] **Step 6: Mutations:**
  - the switch shown for "Me";
  - the field always sent;
  - the partner line missing.
- [ ] **Step 7: Commit** `feat(editor): the "each of us marks it done" switch, and the partner's Done in the item sheet`.

## After the build (controller)
- One Opus review.
- One fix round.
- Spot checks.
- The CI mirror.
- Push.
- Update the remind-us-both spec's out-of-scope line.
- Delete this plan.
- Memory.
- The owner's phone check: a reminder for both with the switch on, one taps Done, the other is still reminded.
