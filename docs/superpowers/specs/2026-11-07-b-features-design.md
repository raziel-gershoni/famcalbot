# Trial-ended notice, "Address me as" at sign-up, Delete account: design

**Status:** APPROVED by the owner 2026-11-07 ("B accepted as recommended"): every decision below takes the recommended answer, including the Terms and Privacy Policy wording in all three languages (B1 decision 1, B3 decision 8). Written 2026-11-06. `LEGAL_UPDATED` (`privacy` and `terms`) moves to the ship day.

In the Russian legal text below, `~` marks a no-break space (U+00A0), as the texts use it after one-letter words and before an em dash.

---

## B1. Notice by browser notification when the trial ends (accounts with no chat)

**Goal.** Someone with an account made on famcal.bot (no Telegram, no WhatsApp) hears that their Pro trial ended. Today the trial ends with no message, and only a log line says it was skipped.

**What the person sees**
1. The trial ends (14 days after sign-up). The notice goes out the first time FamCal checks their plan after that: the first reminder or event alert that comes due, or the first time they open the app. This is the same moment the Telegram notice goes out today.
2. Every browser where they turned notifications on shows: **"Your Pro trial has ended"** / "You're on the Free plan now, so reminders and event alerts have stopped. Your calendar stays as it is."
   - he: "תקופת הניסיון של Pro נגמרה" / "עכשיו אתם במסלול החינמי, ולכן התזכורות וההתראות לפני אירועים נפסקו. היומן שלכם נשאר כמו שהוא."
   - ru: "Пробный период Pro закончился" / "Теперь у вас бесплатный тариф, поэтому напоминания и уведомления о событиях больше не приходят. Ваш календарь остаётся без изменений."
3. Tapping it opens the plan page. With no chat, that page already shows "Connect Telegram to change your plan".
4. If the trial ends inside their Shabbat and Yom Tov pause, nothing is sent, the same as on Telegram today.

**Decisions**
1. **Add a clause to the Terms that names this notice?** Recommend **yes**. The Terms list what browser notifications carry (reminders, alerts, the day's list), so the list should include this one too. It's one clause in three languages, released with B3's change under one new date (wording below).
2. **Should the notification mention Telegram or Stars?** Recommend **no**. It says what changed, and the plan page says how to pay. That way the notification stays correct once other ways to pay arrive (the next topic).
3. **When it is sent:** at the first plan check after the trial ends, as on Telegram. Recommend **no new daily job**. Someone with no reminders and no alerts loses nothing they would notice until they open the app, and the notice comes at that point.
4. **Only this one notice?** Recommend **yes**. The 3-day, last-day and plan-ended notices are for paid plans, and an account with no chat can't pay. "Reminders paused" is already covered by this notification's text.

**Technical choices (made):** a new push kind `plan-ended` with a 24-hour lifetime, normal urgency, in `PAUSED_KINDS`, tag `plan-ended`. In `expireTrialSubscription`, the branch that only logs "no Telegram" becomes: Telegram as today; else if `canReachByPush` then `isPaused(..., 'trial-expired notice')`, then `sendWebPush`; else log `[trial-expired notice] skipped user <id>: no Telegram and no device with notifications on`. The device count comes from `PUSH_DEVICE_COUNT` in the select that is already there, so no extra query. A push that no device takes is logged and not retried, the same as a Telegram failure today.

**Privacy Policy:** **no change needed.** The notifications section is general: "**Notifications in your browser.** We write each one when we send it, and don't store it. It stays on your device until it's cleared there…". The content line says "an event's title, time and place **can be** in a notification", not "only". The retention line says "A notification waiting at a push service for a device that's off is dropped there within a day", and the 24-hour lifetime fits that. A plan notice adds no new data, no new recipient and no new retention.

**Terms change (Decision 1)**, in the "only on Telegram" block:
- en, current: "Reminders, event alerts and a short notification that lists the day's events reach you on each phone…" → new: "Reminders, event alerts, a short notification that lists the day's events and a notice when your trial ends reach you on each phone…" (the rest of the sentence stays)
- he, current: "תזכורות, התראות לפני אירועים והתראה קצרה עם רשימת האירועים של היום מגיעות אליכם…" → new: "תזכורות, התראות לפני אירועים, התראה קצרה עם רשימת האירועים של היום והודעה כשתקופת הניסיון נגמרת מגיעות אליכם…"
- ru, current: "Напоминания, уведомления о~событиях и~краткое уведомление со списком событий дня приходят…" → new: "Напоминания, уведомления о~событиях, краткое уведомление со списком событий дня и~сообщение об окончании пробного периода приходят…"

**Files:** `src/services/subscription-service.ts`, `src/services/web-push/send.ts`, `messages/{en,he,ru}.json` (`bot.push.planEndedTitle`, `bot.push.planEndedBody`, Terms), `src/site/legal.ts`, `scripts/smoke-web-push-send.ts`, `scripts/smoke-pause.ts` (the reason text only), the web-push spec's kind table and CLAUDE.md's push rule (add the trial notice to the list of scheduled callers that ask the pause).

**Tests:** smoke-web-push-send: update the pinned lifetimes and `PAUSED_KINDS`. smoke-pause-subscription, with a mocked DB and push: a no-chat account with a device gets one push; one with no device logs the skip; a paused one gets nothing; a Telegram account goes to Telegram as before; a WhatsApp-only account is still skipped; an early adopter gets nothing.

**Inverse cases:** a second plan check finds the trial already EXPIRED, so nothing is sent again. Connecting Telegram later deletes the devices, and Telegram has no catch-up message, the same as today. A paid plan can't happen without a chat. Notifications turned off: a skip line in the log. Telegram accounts: no change. **Bug to report, not fix:** `expireSubscriptions` skips the downgrade for a paid account with no Telegram id (`subscription-reminders.ts:297`). It can't happen today, because paying needs Telegram, but it will matter once other ways to pay exist.

---

## B2. "Address me as", asked once at sign-up

**Goal.** A new person picks male or female forms for their summaries and the voice show when they sign up, instead of being addressed as male without being asked.

**What the person sees**
- **Website sign-up:** under the name field, a two-option choice labelled "Address me as" (he "לשון פנייה", ru "Как к вам обращаться"), with "Male / Female" (he "לשון זכר / לשון נקבה", ru "В мужском роде / В женском роде"). The hint says it's used for the grammar of summaries and the voice show. "Create account" stays off until there's a name and a choice.
- **Telegram /start (new account only):** after the first reply (the welcome, or the reply to a partner's invite), a short message: "How should FamCal address you? It sets the grammar of your summaries and the voice show. You can change it in Settings." There are two buttons. Tapping one saves the choice and turns the message into a one-line confirmation. Not tapping leaves male.
  - he: "באיזו לשון לפנות אליכם? כך ייכתבו הסיכומים והתוכנית הקולית. אפשר לשנות בהגדרות."
  - ru: "Как к вам обращаться? От этого зависит грамматика сводок и радиошоу. Изменить можно в «Настройках»."
- **First WhatsApp message:** the language buttons, then the value-proposition and set-up link messages as today, then the same question with two reply buttons as the last message. Answering saves it. Anything else goes on as normal (male stays).

**Decisions**
1. **Website: required, with nothing preselected?** Recommend **yes**. It costs one tap, and preselecting male would bring back the silent default.
2. **Telegram: ask with a button pair after the first reply, not leave it to Settings?** Recommend **yes**. Otherwise the person isn't really asked.
3. **A third option ("plural / neutral")?** Recommend **not now**. It needs a third form in the voice show, the summaries and the Hebrew pointing in all three languages. It would be a separate feature.
4. **Ask existing accounts?** Recommend **no**. Their stored "male" can't be told apart from a real choice, and the Settings row is there.

**Technical choices (made):**
- The "created now" signal comes from `getOrCreateUser`, which returns `{ user, created }`. No new column.
- No question on `/start connect`: that new Telegram account is merged into the WhatsApp account, which already answered.
- One shared `isGender` (moved out of the settings route) checks every input.
- Saving goes through the existing user update.
- Telegram callback prefix `gd:m|f`, matched to the presser's own Telegram id. The WhatsApp button ids `gender_m|gender_f` are recognised in the webhook even after the onboarding state has expired.
- The web body gets `gender`, checked next to `cleanName` before the record is touched. `NewAccount`'s web branch carries it, and `accountData` uses it (the chat branches keep 'male').
- Log line: `[gender] user <id> chose via <telegram|whatsapp|web>`, never a name.

**Privacy Policy / Terms:** no change. The Policy already lists "your language and how you want to be addressed ("Address me as")".

**Files:** `src/services/user-service.ts`, `src/services/telegram/commands.ts`, `src/services/telegram/webhook-handlers.ts` (callback), a small `src/services/address-choice.ts` (the save and the prompt, shared by Telegram and WhatsApp), `src/services/whatsapp-onboarding.ts`, `src/services/web-signin/signup.ts`, `app/api/auth/signup/route.ts`, `app/[locale]/(site)/signup/SignUpClient.tsx`, `app/api/settings/route.ts` (shared `isGender`), `messages/{en,he,ru}.json` (`bot.onboarding.address*`, `site.signup.address*`), `scripts/smoke-pause.ts` (the new sender goes in NOT_PAUSED: it replies to the person's own /start or message).

**Tests (mocked DB and messaging):**
- Sign-up refuses a missing or unknown choice with 400, and makes the account with "female" when chosen.
- `createAccount` web arm stores it.
- A new /start sends the question once. A returning /start doesn't, and neither does `connect`.
- `gd:f` saves female for the presser only, and a stray value is refused.
- WhatsApp: the question comes after the CTA, the button saves, and free text skips.
- smoke-account-create and smoke-account-merge still pass.

**Inverse cases:**
- Pressing the other button later, or the same one twice: it just saves again.
- Changing it in Settings still works.
- Partner: the choice also decides how the partner's summaries and show speak about this person.
- Merge caveat: an explicit Telegram "male" can't be told apart from the starting value, so linking a WhatsApp account that chose female takes female (both choices were the person's own).
- Paid plan: not relevant.
- Telegram vs web: both are asked once at creation. An account made on the web and later connected to Telegram isn't asked again.

---

## B3. "Delete account" in Settings

**Goal.** A person can delete their own account from Settings, in the Mini App or the browser, with the same full deletion the admin's Delete does. Data export comes later.

**What the person sees**
1. At the bottom of Settings: a red row, "Delete account" (Lucide `Trash2`).
2. Tapping it opens a sheet titled "Delete your account?", listing:
   - your calendars and events, settings, plan and sign-in ways are deleted;
   - your partner is unlinked, and loses the calendars you own and their events; events you added to their calendars stay with them;
   - FamCal's copy calendars are removed from your Google account, except those you chose to keep, and FamCal's access to Google is revoked;
   - "This can't be undone."
3. If a paid month is still running, one more line: "Your paid plan ends with your account. To cancel a payment, ask us before you delete (Terms, Cancelling and refunds)." It links to the Terms.
4. Then a red "Delete my account" button and Cancel. In a browser whose sign-in is more than an hour old, the button is replaced with "Sign in again" (the same as adding a sign-in way). A WhatsApp-link session gets "ask for a new link in the chat".
5. While it's deleting: a spinner, and the sheet can't be closed. Done: "Your account is deleted." The Mini App closes. A browser goes to famcal.bot's home page, signed out, and this browser's notifications are turned off.

**Decisions**
1. **How to confirm: one red button in the sheet, or typing a word?** Recommend **the button**. The sheet is already a second step, and the browser needs a sign-in from the last hour. Typing a Latin "DELETE" on a Hebrew or Russian keyboard is friction. The server still requires `{ confirm: true }`.
2. **A paid month still running?** Recommend **warn and still allow** (step 3). Blocking keeps a person in an account they want gone. After deletion we hold no payment row, so a refund has to be asked for first. The Terms add that sentence.
3. **A suspended account?** Recommend it **can't delete itself** (it already gets 403) and keeps the "write to us" right. A banned (not suspended) Telegram account may delete itself: the ban rows stay, so it can't sign up again.
4. **Tell the partner?** Recommend **no**, the same as unlinking today. The sheet tells the person what the partner loses.
5. **A goodbye message in the chat?** Recommend **no**. The screen confirms, and a message could prompt a reply that makes a new account.
6. **A "keep my copies in Google" switch?** Recommend **no**. Remove them, as the Policy says, except those already turned off with Keep. No new switch.
7. **Re-signing up after a delete gives a fresh 14-day trial** (the admin delete already allows this). Recommend **accept for now**.
8. **The legal wording below**: needs the owner's approval in all three languages.

**Technical choices (made):**
- `hardDeleteUser(userId, by: { admin: number } | 'self')`: one code path. When the person deletes, `unlinkedByUserId` is null and the log reads `[account-delete] user <id> deleted their account (<telegram|session>)`. It first calls `markDisconnecting` so a copy worker that is running stops. The function stays next to `personalCacheKeys` (a smoke depends on that).
- The route `POST app/api/account/delete/route.ts`, in order: `refuseCrossSite`, then `verifyUserAuth(settingsRateLimiter, 'account-delete')`, then `refuseStaleSignIn`, then `confirm === true`, then refuse an admin account, then `hardDeleteUser(id, 'self')`, then `clearSessionCookie`. Errors go to `captureError('account-delete', { user_id })`, which logs ids only.
- UI: `AccountDelete.tsx` + `account-delete-client.ts`, built like `GoogleDisconnect.tsx` (presentational and container split, phases idle/confirm/working/done). It calls `turnOffPush` before the request. The page data gets `paidMonthRunning`.
- Push devices, sign-in ways and pings go with the row (cascade). Sessions in other browsers fail with 404, which clears their cookie.

**Legal changes (owner approves the wording). `LEGAL_UPDATED`: both `privacy` and `terms` move to the ship day.** They read 2026-11-06 now, so if it ships today the value stays and the change is recorded in the spec.

*Privacy Policy, "Your rights and choices", paragraph after the rights list:*
- en, replace "There's no button yet to delete your account or download your data. We do both by hand when you ask." → "You can also delete your account yourself in Settings. There's no button yet to download your data. We make you a copy by hand when you ask."
- he, replace "עדיין אין כפתור למחיקת החשבון או להורדת המידע שלכם. כשמבקשים, אנחנו עושים את שניהם ידנית." → "אפשר גם למחוק את החשבון בעצמכם, בהגדרות. עדיין אין כפתור להורדת המידע שלכם. כשמבקשים, אנחנו מכינים לכם עותק ידנית."
- ru, replace "Кнопки, чтобы удалить аккаунт или скачать свои данные, пока нет. По вашей просьбе мы делаем и~то и~другое вручную." → "Удалить аккаунт можно и~самостоятельно, в~«Настройках». Кнопки, чтобы скачать свои данные, пока нет. По вашей просьбе мы готовим копию вручную."

*Privacy Policy, "You can also, at any time" list (the last item's period becomes a semicolon, then one new item):*
- en: "unlink your partner in the web app;" + "delete your account in Settings. It can't be undone: below is what we delete and what stays."
- he: "לבטל את הקישור לבן או בת הזוג באפליקציית הרשת;" + "למחוק את החשבון בהגדרות. אי אפשר לבטל את המחיקה: בהמשך מפורט מה אנחנו מוחקים ומה נשאר."
- ru: "разорвать связь с~партнёром в~веб-приложении;" + "удалить аккаунт в~«Настройках». Отменить удаление нельзя: ниже сказано, что мы удаляем и~что остаётся."

*Terms, "Suspension and closing an account", last paragraph:*
- en, current: "You can stop using FamCal any time: block the bot if you use it, and ask us to delete your account (see the [Privacy Policy](/privacy))." → new: "You can stop using FamCal any time: block the bot if you use it, and delete your account in Settings, or ask us to delete it (see the [Privacy Policy](/privacy)). Your plan ends with the account: to cancel a payment, ask us before you delete the account (see "Cancelling and refunds" above)."
- he, current: "אפשר להפסיק להשתמש ב־FamCal בכל עת: לחסום את הבוט, אם אתם משתמשים בו, ולבקש מאיתנו למחוק את החשבון (ראו [מדיניות הפרטיות](/privacy))." → new: "אפשר להפסיק להשתמש ב־FamCal בכל עת: לחסום את הבוט, אם אתם משתמשים בו, ולמחוק את החשבון בהגדרות, או לבקש מאיתנו למחוק אותו (ראו [מדיניות הפרטיות](/privacy)). המסלול נגמר יחד עם החשבון: כדי לבטל תשלום, פנו אלינו לפני שמוחקים את החשבון (ראו ״ביטול והחזרים״ למעלה)."
- ru, current: "Вы можете перестать пользоваться FamCal в~любой момент: заблокируйте бота, если вы им пользуетесь, и~попросите нас удалить ваш аккаунт (см. [Политику конфиденциальности](/privacy))." → new: "Вы можете перестать пользоваться FamCal в~любой момент: заблокируйте бота, если вы им пользуетесь, и~удалите аккаунт в~«Настройках» или попросите нас его удалить (см. [Политику конфиденциальности](/privacy)). Тариф заканчивается вместе с~аккаунтом: чтобы отменить платёж, напишите нам до того, как удалите аккаунт (см. «Отмена и~возврат» выше)."

These need no change: "When we delete your account, we:" (it matches `hardDeleteUser`), "What stays after that" and the retention lines.

**Files:**
- `src/lib/user-moderation.ts`, `app/api/admin/users/moderation/route.ts` (new signature)
- `app/api/account/delete/route.ts` (new)
- `app/[locale]/(app)/settings/AccountDelete.tsx`, `account-delete-client.ts` (new), `SettingsClient.tsx`
- `src/lib/page-data.ts` (`paidMonthRunning`)
- `messages/{en,he,ru}.json` (`settings.accountDelete.*`, legal)
- `src/site/legal.ts`
- `scripts/smoke-recent-sign-in.ts` (add the route to GUARDED), `scripts/smoke-signin-legal.ts` (the three pinned Terms fragments)
- README, CLAUDE.md (one clause in the sign-in rule: deleting your own account needs the hour)

**Tests (mocked DB and Google):** a new `scripts/smoke-account-delete.ts` covers:
- a cross-site request: 403
- a stale web session: 403 with sign-in-again
- initData passes the hour check
- no confirm: 400
- suspended: 403
- admin: refused
- the right request calls `hardDeleteUser(id, 'self')` and clears the cookie

Also:
- `hardDeleteUser` 'self': `unlinkedByUserId` is null and `markDisconnecting` comes first
- the sheet's phases render, and the paid-month line shows only when a paid month is running
- existing: smoke-bug-batch-safety, smoke-signin-data #8, smoke-account-merge, smoke-alerts-gate-writers (the route writes no events), smoke-pause (no new sender)

**Inverse cases:**
- Pressed twice or in two tabs: the second gets 404, which clears the cookie and shows "already deleted".
- After deleting on Telegram: old Mini App buttons say the account is gone. /start or any message makes a brand-new account (new trial), unless banned.
- After deleting on WhatsApp: the next message starts onboarding again.
- Partner: unlinked, their calendars turn private, they lose the deleted person's calendars and keep their own events. Reminders that were "for" the deleted person fall back to their creator.
- Paid plan: it ends with the account (warned). Payment rows go, Telegram's records stay.
- Google connected: copies removed (Keep honoured), grant revoked. A Google failure doesn't stop the delete.
- Banned: the ban rows stay. Suspended: can't delete (write to us).
- Admin: the row is hidden and the route refuses (the owner's own account).
