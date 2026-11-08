# Ask FamCal in a chat, one line per person: design

Status: SHIPPED 2026-11-08. Decisions APPROVED by the owner 2026-11-08 ("go"); the legal wording in §6 (A1, A6, A7 and the controller's A8) APPROVED by the owner 2026-11-08 ("ok"), LEGAL_UPDATED 2026-11-08. Builds on the shipped spec `2026-11-07-ask-in-chat-design.md` (its rules stay unless this one says otherwise).

## 1. Goal and decisions

Today one answer gives the caller's busy and free times, merged over every calendar they selected. Now the answer is split by person, using the calendar settings FamCal already has (labels and the person named on a calendar). It stays one code path: `update.ts`, `window.ts`, `busy.ts`, `text.ts` and `handler.ts` are changed, not copied, and the busy times still come from the summaries' reader.

The owner's decisions (2026-11-08, binding):

1. **One line per person:** the caller; the partner; each kid, by the person name set on their calendar ("Kids" when none is set); "Family" for calendars with no label. Busy and free times only, never an event's name.
2. **Lines are headed by first names:** the caller's FamCal name, the partner's name, each kid's calendar person name. No role words; "Kids" and "Family" are the localized fallbacks.
3. **The same single Gemini call also reads who the question is about:** the caller, the partner, the kids, one person by name, the family, or everyone. One person or group asked: only their line(s). Otherwise: everyone.
4. **Nobody specific asked:** the caller's line always (busy or free), the others only when busy. A group or "everyone" asked explicitly: each of its lines, busy or free.
5. **Partner's calendars:** a calendar the partner owns (FamCal, shared to the caller) counts as the partner's; one the partner labelled `kids` counts as the kids'. The owner's label is read internally; screens still never show it. Google calendars follow the caller's own labels (`primary | yours | spouse | kids | birthdays`). `birthdays` and Google holiday calendars stay out; reminders and birthdays never count; an all-day event is busy all day (as today).
6. **Legal:** the Terms paragraph and the Privacy item that now say the answer shows only the caller's busy times must say it can also show, by name, when the partner and the kids are busy, from the calendars the caller sees. Drafted in en, he and ru (§6). The owner approves it. `LEGAL_UPDATED` moves to the ship day.

Rulings given with the task (binding):

7. **No names go to Gemini.** The model returns who was asked as a kind (`me | partner | kids | family | everyone | person`) and, for a person, the name as the messages write it. The code matches it locally against the calendars' `personName` and `personEnglishName` and the partner's name, ignoring case and Hebrew niqqud. No match means no one in particular. So the Privacy text about what Gemini receives does not change.
8. **Hebrew and Russian lines don't gender the person.** The words describe the schedule, not the person ("מאיה: יש תוכניות 16:00–17:00", "Маша: есть планы с 16:00 до 17:00"). Every Hebrew answer still starts right to left (`leadRtl`). `smoke-he-neutral` and `smoke-ru-formal` pass.
9. **Google unread:** as today, no line ever says free; the partial line stays.
10. **Order:** caller, partner, kids (in calendar order), Family.
11. **Several labels:** a calendar with several labels counts for each of its groups. An own calendar labelled `yours` or `primary` is the caller's.
12. **Names:** the caller's from the FamCal user (first word of `user.name`); the partner's from the pairing (first word of the partner user's name), else the spouse calendar's `personName`; a kid's from its calendar's `personName` (or `personEnglishName` in an en or ru answer, when set).

My rulings inside those (small choices, made here):

13. **"Everyone" when no one matches.** A name no line answers, or a group with no line (kids asked, no kids calendar), is treated as "no one in particular" (decision 4's rule), and the log says `person-none` / `kids-none`.
14. **A day with no line left.** With no one in particular asked, if the caller has no line of their own (no calendar labelled primary or yours) and nobody else is busy, the day shows every line (all free), so a day is never empty. With no calendar anyone's at all, the caller's line exists with no calendars (free, as today's answer would say).
15. **The base form of a name.** The model returns the name as the messages write it, but without a Hebrew prefix letter (למאיה → מאיה) and in the Russian nominative (у Маши → Маша). It is still only text from the messages. The matcher also tries the asked name's first word and the name without one Hebrew prefix letter.
16. **A question about the caller is no one in particular** (the owner, 2026-11-08, after a live answer hid a busy kid: "can you pick me up on the 29th at 15:30?" read as `me` showed only the caller). `me`, or the caller named, gives the caller's line and every busy one, as no one in particular does: the others' plans bear on the caller's time. "Are you all free?", "אתם פנויים?" and "вы все свободны?" are `everyone`. Only the partner, the kids, the family, everyone or another person's name narrows an answer.
17. **The caller can be named too.** "Is Raziel free?" matches the caller's own name (`user.name`, `englishName`), and is then no one in particular (ruling 16).
18. **Same-named kids share a line.** Kids' calendars that name the same person (folded) are one line, and so are all kids' calendars that name no one ("Kids").
19. **Direction per line.** A Hebrew answer's line that starts with a Latin name gets U+200F. An English or Russian answer's line that starts with a Hebrew name gets U+200E (new `leadLtr`).
20. **Russian ranges read "с 16:00 до 17:00".** `bot.askInChat.range` in ru becomes `с {from} до {to}` (the ruling's example). en stays `{from}-{to}`, he `{from}–{to}`.

**The partner's calendar about the caller (ruling, told to the owner 2026-11-08 before the legal OK).** A FamCal calendar the partner owns and labelled `spouse` (a calendar the partner keeps *about the caller*) is on the caller's line, as the summaries read it (`labelsFromViewerSide` turns the owner's `spouse` into the viewer's `yours`): its events are the caller's plans. Every other calendar the partner owns is the partner's (decision 5); one the partner labelled kids is the kids'.

Not in scope: a setting to hide a person; naming a person on the Start line or the error lines; a person's line for someone with no calendar; events by zman; any change to what the summaries, the home or the editor show.

## 2. What people see

Raziel (FamCal name "Raziel", Hebrew users store "רזיאל") is paired with Dana. His kids' calendars name Maya and Noa. On Friday 13.11, Raziel has something 19:00-21:00, Maya 17:30-19:00, Dana and Noa nothing, the family calendar nothing.

| Asked | en | he |
|---|---|---|
| No one in particular ("@bot Friday evening") | `Friday 13.11, evening:`<br>`Raziel: busy 19:00-21:00, free the rest`<br>`Maya: busy 17:30-19:00, free the rest` | `יום שישי 13.11, בערב:`<br>`רזיאל: יש תוכניות 19:00–21:00, שאר הזמן פנוי`<br>`מאיה: יש תוכניות 17:30–19:00, שאר הזמן פנוי` |
| One kid by name ("is Maya free Friday evening?") | `Friday 13.11, evening:`<br>`Maya: busy 17:30-19:00, free the rest` | `יום שישי 13.11, בערב:`<br>`מאיה: יש תוכניות 17:30–19:00, שאר הזמן פנוי` |
| The kids ("are the kids free Friday evening?") | `Friday 13.11, evening:`<br>`Maya: busy 17:30-19:00, free the rest`<br>`Noa: free` | `יום שישי 13.11, בערב:`<br>`מאיה: יש תוכניות 17:30–19:00, שאר הזמן פנוי`<br>`נועה: אין תוכניות` |
| Google unread (no one in particular; Maya's calendar is on Google) | `Friday 13.11, evening:`<br>`Raziel: busy 19:00-21:00`<br>`Google Calendar couldn't be read, so this is from FamCal alone.` | `יום שישי 13.11, בערב:`<br>`רזיאל: יש תוכניות 19:00–21:00`<br>`את Google Calendar לא הצלחנו לקרוא, אז התשובה לפי FamCal בלבד.` |
| Everyone ("are you all free Friday evening?") | the date line, then Raziel, Dana (`Dana: free`), Maya, Noa, and Family (`Family: free`) | the same five lines |
| "Are you free Friday evening?" (the caller) | `Friday 13.11, evening:`<br>`Raziel: busy 19:00-21:00, free the rest` | `יום שישי 13.11, בערב:`<br>`רזיאל: יש תוכניות 19:00–21:00, שאר הזמן פנוי` |

Several days give one date line each, each followed by its people. The lines for no account, rate limit, "which day?", "up to 3 days" and "couldn't check" do not change.

## 3. Who is in the answer

### 3.1 The model reads who was asked (`window.ts`, `src/prompts/ask-in-chat.ts`)

`ASK_WINDOW_SCHEMA` gains a required field:

```json
"who": { "kind": "me" | "partner" | "kids" | "family" | "everyone" | "person", "name": string | null } | null
```

The prompt says what each kind means (rule 16's examples, in the three languages), that `name` is only for `person` and is the name as written in its base form (ruling 15), that `null` means no one in particular, and that FamCal's own earlier answer lists names as its lines, not as a question, so `who` is read only from what is asked. The prompt gets no name from FamCal.

`parseAskWho(text): AskWho | null` (new, `window.ts`) checks it:
- `who` missing or null: `null`.
- Not an object: `AskWindowError('"who" is not an object or null')`.
- `kind: 'person'` needs a name of 1 to 60 characters after trimming (`WHO_NAME_MAX_CHARS`), else `AskWindowError('"who.name" is not a name of 1 to 60 characters')`.
- Any other kind must be one of `ASK_GROUPS`, else `AskWindowError('"who.kind" is not me, partner, kids, family, everyone or person')`. A group drops any name.
- The reasons name the field, never the value (as `parseAskWindow`'s do), and a rejection is asked again once with the reason, in the same loop.

```ts
export type AskGroup = 'me' | 'partner' | 'kids' | 'family' | 'everyone';
export type AskWho = { kind: AskGroup } | { kind: 'person'; name: string };
// ReadAskWindowResult gains: who: AskWho | null
```

`parseAskWindow` keeps its shape and its tests; both parsers read the JSON through one `readObject`.

### 3.2 The people (`src/services/ask-in-chat/people.ts`, new, pure)

```ts
export type PersonKind = 'me' | 'partner' | 'kid' | 'family';
export interface Person {
  key: string;            // 'me' | 'partner' | 'family' | 'kid:<folded name>' ('kid:' for kids' calendars naming no one)
  kind: PersonKind;
  name: string | null;    // the line's first word(s); null: the language's word (bot.askInChat.people.*)
  aliases: string[];      // folded names a question may use: each whole name and its first word
  calendarIds: string[];  // the calendars whose events are theirs, in list order
}
peopleOf({ assignments, partnerOwned, me, partner, locale }): Person[]
```

`assignments` and `partnerOwned` come from **`getCalendarsWithOwners(user)`** (new in `src/services/calendar-provider/user-calendars.ts`). It is `getCalendarAssignmentsForUser`'s own body, returning the same list plus the ids of the FamCal calendars whose `ownerUserId` is not the user's. `getCalendarAssignmentsForUser` becomes `(await getCalendarsWithOwners(user)).assignments`, so every other caller is unchanged and no query is added. The labels are already the caller's side (`labelsFromViewerSide` keeps the owner's `kids` and `birthdays`), so "the partner labelled it kids" is `partnerOwned.has(id) && labels.includes('kids')`.

Each calendar, in list order:

| Calendar | Counts for |
|---|---|
| labelled `birthdays`, or a Google holiday calendar (`…#holiday@group.v.calendar.google.com`) | no one (never busy) |
| the partner owns it | the partner, unless the partner labelled it `spouse` (about the caller: `yours` from the caller's side, then the caller) or `kids` (then the kid it names) |
| otherwise, labelled `primary` or `yours` | the caller |
| otherwise, labelled `spouse` | the partner |
| otherwise, labelled `kids` | the kid its `personName` names |
| otherwise, no label | the family |

A calendar with several labels counts for each (ruling 11).

Names (ruling 12): caller `firstWord(user.name)`; partner `firstWord(partner.name)` from `getActivePartnerSummary(user.id, user.pairingId)` (`src/services/native-reminders/ownership.ts`, the existing ACTIVE-pairing read), else the first partner calendar's person (`personEnglishName` in en/ru when set, else `personName`); a kid's person likewise. A blank name is `null`. Aliases: the caller's `name` and `englishName`, the partner's pairing `name` and `englishName` plus every partner calendar's `personName`/`personEnglishName`, a kid's `personName` and `personEnglishName`. The family has none.

**Folding** (`foldName`): NFD, drop U+0591-U+05C7 (niqqud and cantillation), NFC, drop apostrophes, geresh and gershayim (`'’\`"׳״`), lower case, ё → е, single spaces, trimmed.

### 3.3 Which lines were asked (`askedLines(who, people)`)

```ts
interface Asked { keys: ReadonlySet<string> | null; log: string }
```

| `who` | `keys` | `log` |
|---|---|---|
| null | null (no one in particular) | `none` |
| `me` / `partner` / `kids` / `family` | the people of that kind | the kind |
| `everyone` | every person | `everyone` |
| `person` | the people whose aliases hold the first of these forms that any person answers: the folded name, its first word, and each of those without one leading Hebrew prefix letter (ו ב כ ל מ ש ה, before at least two more letters) | `person` |
| a kind or name that picks no one | null | `<kind>-none` |

The name is never logged, reported or kept.

## 4. The words (`text.ts`, keys `bot.askInChat.*`)

### 4.1 Shape

Each day asked: its **date line** (`head.*`: the date, and the part of the day, the range or the time asked), then **one line per person shown** (`line.*`, headed by `{name}`). Days are separated by nothing but their date lines. With Google unread, `googlePartial` closes the answer. With no line at all, the answer is `unavailable`. Each line is laid out by `leadRtl` in Hebrew and by `leadLtr` (new) in English and Russian (ruling 19).

```ts
interface AskLine { person: Person; judged: Judged }
interface AskAnswer {
  range: AskRange; hebrewAsked: boolean; tz: string;
  days: { day: DayKey; lines: AskLine[] }[];   // every person, in peopleOf's order
  asked: ReadonlySet<string> | null;           // askedLines().keys
  googleGap?: GoogleGap;
}
```

### 4.2 Which lines a day shows

1. `asked` set: the people asked, busy or free (decision 4).
2. `asked` null: the caller's line, and every line whose verdict is not `free`. If that leaves none, every line (ruling 14).
3. Google unread: drop every `free` line from what 1 or 2 chose (ruling 9). A day left with no line has no date line either.

### 4.3 Strings

`date`, `until`, `from`, `parts.*`, `googlePartial`, `unavailable`, `noDate`, `tooManyDays`, `noAccount`, `openButton` and `rateLimited` are unchanged. `range` changes in ru only. The old `day.*`, `window.*`, `at.*` and `partial.*` keys (which held `{date}`) are replaced by:

| Key | en | he | ru |
|---|---|---|---|
| `range` | `{from}-{to}` (same) | `{from}–{to}` (same) | `с {from} до {to}` |
| `head.day` | `{date}:` | `{date}:` | `{date}:` |
| `head.window` | `{date}, {when}:` | `{date}, {when}:` | `{date}, {when}:` |
| `head.at` | `{date}, {time}:` | `{date}, {time}:` | `{date}, {time}:` |
| `line.day.some` | `{name}: busy {ranges}, free the rest of the day` | `{name}: יש תוכניות {ranges}, שאר היום פנוי` | `{name}: есть планы {ranges}, в остальное время свободно` |
| `line.day.free` | `{name}: free all day` | `{name}: כל היום פנוי` | `{name}: весь день свободен` |
| `line.day.all` | `{name}: busy all day` | `{name}: יש תוכניות כל היום` | `{name}: планы на весь день` |
| `line.window.some` | `{name}: busy {ranges}, free the rest` | `{name}: יש תוכניות {ranges}, שאר הזמן פנוי` | `{name}: есть планы {ranges}, в остальное время свободно` |
| `line.window.free` | `{name}: free` | `{name}: אין תוכניות` | `{name}: планов нет` |
| `line.window.all` | `{name}: busy throughout` | `{name}: הלו״ז מלא` | `{name}: всё время занято` |
| `line.at.busy` | `{name}: busy ({ranges})` | `{name}: יש תוכניות ({ranges})` | `{name}: есть планы ({ranges})` |
| `line.at.free` | `{name}: free` | `{name}: אין תוכניות` | `{name}: планов нет` |
| `line.partial` | `{name}: busy {ranges}` | `{name}: יש תוכניות {ranges}` | `{name}: есть планы {ranges}` |
| `people.me` | `Me` | `אני` | `Я` |
| `people.partner` | `Partner` | `בן או בת הזוג` | `Партнёр` |
| `people.kids` | `Kids` | `הילדים` | `Дети` |
| `people.family` | `Family` | `המשפחה` | `Семья` |

The Russian binds `в` and `с` to the next word with U+00A0, as the file does. The Hebrew words describe the schedule ("there are plans", "the rest of the day is free", "the schedule is full", "no plans"), never the person, and avoid the standalone `השאר`, which `smoke-he-neutral` reads as an imperative. The Russian is impersonal or agrees with `день` and `время`, never with the person. `people.partner` reuses the words the app already uses for the partner (en and ru "Partner", he "בן או בת הזוג"). `people.me` appears only for a caller whose FamCal name is blank.

Examples (Friday 13.11, Jerusalem): `Friday 13.11, 20:00:` / `Dana: busy (19:00-21:00)`; `Пятница, 13.11, с 18:00 до 20:00:` / `Маша: планов нет`; `יום שישי 13.11:` / `נועה: יש תוכניות עד 02:00 ומ־22:00, שאר היום פנוי`.

## 5. The read and the handler

`readBusyDays(user, days, tz, locale, deps)` (`busy.ts`):
- Reads `getCalendarsWithOwners(user)` and `getActivePartnerSummary(user.id, user.pairingId)` together (`Promise.all`), builds `peopleOf(...)`, then makes the **same one read** as today (`readLookaheadEvents` on every id, `DEFAULT_ON_DEMAND_READ`).
- Splits the events by person (an event counts for every person whose calendar it is on) and runs the existing `busyIntervals` per person per day.
- Returns `{ people: Person[], days: { day, people: { person, intervals }[] }[], googleGap? }`.
- Throws as before. A failed partner read throws too, and is a FamCal error (the "couldn't check" line and Sentry).
- `deps.calendarsOf` and `deps.partnerOf` replace `deps.assignmentsOf` for the smokes.

`handleGuestMessage`:
- `readBusy(user, days, tz, locale)`.
- `askedLines(read.who, busy.people)`.
- `judgeWindow` per person per day, then `askAnswerText({ ..., asked: asked.keys })`.
- The answered log line becomes `[ask] user <id>: answered <kind> x<days> who=<none|me|partner|kids|family|everyone|person|<kind>-none> people=<n> busy=<n> google=<…> in <ms> ms (ai <ms>, read <ms>)`.
- `busy` counts the shown intervals over every person. No name, alias or matched key is ever logged.

Cost: per question, one more pairing read and one partner row read (`getActivePartnerSummary`; none when unpaired) on a path the person invoked. No new timer path and no new Gemini call; the prompt grows by about 15 lines.

## 6. The Privacy Policy and the Terms (DRAFT, for the owner's OK)

The meaning changes in all three languages at once. `LEGAL_UPDATED` (`src/site/legal.ts`) moves to the ship day for both documents. `scripts/lib/legal-ask.ts` holds each text (Russian there with plain spaces). `messages/ru.json` binds every one-letter word (в, с, к, о, у, и, а, я) to the next word with U+00A0, as `smoke-site-truth` T6 and `smoke-ask-in-chat-legal` G4 require. Edits A1 and A6 are decision 6's. **A8 is the controller's addition (2026-11-08), found missing by the branch review:** the Privacy Policy's "Your partner" list now also says the partner can ask the bot in another chat, which shows the caller by name; drop it if the owner prefers (then also drop it from `messages/`, `scripts/lib/legal-ask.ts` and the count of eight in `smoke-ask-in-chat-legal`). **A7 is my addition** (the AI now also reads *who* is asked, and that clause lists what the AI can get wrong); drop it if the owner prefers. Privacy (b)-(d) (what the bot and Gemini receive) do not change: Gemini still gets the two texts and nothing from the calendars (ruling 7).

### A1. Privacy, "What we don’t keep", the item about a message asked about in another chat

`legal.privacy.sections.notKeep.blocks[0][2]`

- **English**
  - Current: **A message you ask about in another chat** (Telegram only). When you reply to a message in another Telegram chat and mention our bot, Telegram sends us that message, which someone else may have written, and your mention. We send both to the AI only to find the day and time you’re asking about, and we keep neither. The bot then answers in that chat, where everyone in it can see the answer: it shows only when you’re busy and when you’re free, never what your events are.
  - New: **A message you ask about in another chat** (Telegram only). When you reply to a message in another Telegram chat and mention our bot, Telegram sends us that message, which someone else may have written, and your mention. We send both to the AI only to find the day and time you’re asking about, and whose time, and we keep neither. The bot then answers in that chat, where everyone in it can see the answer: it shows only busy and free times, from the calendars you see in FamCal: yours, your family’s, and, by name, your partner’s and your children’s. It never shows what anyone’s events are.
- **Hebrew**
  - Current: **הודעה שאתם שואלים עליה בצ׳אט אחר** (בטלגרם בלבד). כשעונים להודעה בצ׳אט אחר בטלגרם ומתייגים בתשובה את הבוט שלנו, טלגרם שולחת אלינו את ההודעה הזו, שאולי כתב מישהו אחר, ואת התיוג שלכם. אנחנו שולחים את שתיהן לבינה המלאכותית רק כדי להבין על איזה יום ושעה אתם שואלים, ולא שומרים אף אחת מהן. אחר כך הבוט עונה באותו צ׳אט, וכל מי שנמצא בו רואה את התשובה: היא מראה רק מתי אתם עסוקים ומתי אתם פנויים, ואף פעם לא מה האירועים שלכם.
  - New: **הודעה שאתם שואלים עליה בצ׳אט אחר** (בטלגרם בלבד). כשעונים להודעה בצ׳אט אחר בטלגרם ומתייגים בתשובה את הבוט שלנו, טלגרם שולחת אלינו את ההודעה הזו, שאולי כתב מישהו אחר, ואת התיוג שלכם. אנחנו שולחים את שתיהן לבינה המלאכותית רק כדי להבין על איזה יום ושעה אתם שואלים ועל מי, ולא שומרים אף אחת מהן. אחר כך הבוט עונה באותו צ׳אט, וכל מי שנמצא בו רואה את התשובה: היא מראה רק מתי יש תוכניות ומתי הזמן פנוי, לפי היומנים שאתם רואים ב־FamCal: שלכם, של המשפחה, וגם, לצד השם, של בן או בת הזוג ושל הילדים. מה האירועים עצמם היא לא מראה אף פעם.
- **Russian**
  - Current: **Сообщение, о котором вы спрашиваете в другом чате** (только в Telegram). Когда вы отвечаете на сообщение в другом чате Telegram и упоминаете в ответе нашего бота, Telegram передаёт нам это сообщение (его мог написать кто-то другой) и ваше упоминание. Мы отправляем их ИИ только для того, чтобы понять, о каком дне и времени вы спрашиваете, и не храним ни то, ни другое. Затем бот отвечает в том же чате, и ответ видят все его участники: в нём указано только, когда вы заняты и когда свободны, но никогда не сказано, что это за события.
  - New: **Сообщение, о котором вы спрашиваете в другом чате** (только в Telegram). Когда вы отвечаете на сообщение в другом чате Telegram и упоминаете в ответе нашего бота, Telegram передаёт нам это сообщение (его мог написать кто-то другой) и ваше упоминание. Мы отправляем их ИИ только для того, чтобы понять, о каком дне и времени вы спрашиваете и о ком, и не храним ни то, ни другое. Затем бот отвечает в том же чате, и ответ видят все его участники: в нём указано только, когда есть планы и когда время свободно, по календарям, которые вы видите в FamCal: вашим и семейным, а также, с указанием имён, календарям партнёра и детей. Что это за события, в ответе не сказано никогда.

### A6. Terms, "What FamCal is", the paragraph about mentioning the bot in another chat

`legal.terms.sections.service.blocks[5]`

- **English**
  - Current: When you mention the bot in another Telegram chat, it answers in that chat, and everyone in it sees the answer: when you’re busy and when you’re free on the day you asked about, from all the calendars you chose in FamCal. It never shows your events’ names. Mention it only where you’re happy for the people there to see that.
  - New: When you mention the bot in another Telegram chat, it answers in that chat, and everyone in it sees the answer: busy and free times on the day you asked about, from the calendars you see in FamCal: yours, your family’s, and, by name, your partner’s and your children’s. It never shows the events’ names. Mention it only where you’re happy for the people there to see that.
- **Hebrew**
  - Current: כשמתייגים את הבוט בצ׳אט אחר בטלגרם, הוא עונה באותו צ׳אט, וכל מי שנמצא בו רואה את התשובה: מתי אתם עסוקים ומתי אתם פנויים ביום ששאלתם עליו, לפי כל היומנים שבחרתם ב־FamCal. שמות האירועים שלכם לא מוצגים אף פעם. תייגו אותו רק בצ׳אט שבו מתאים לכם שהמשתתפים יראו את זה.
  - New: כשמתייגים את הבוט בצ׳אט אחר בטלגרם, הוא עונה באותו צ׳אט, וכל מי שנמצא בו רואה את התשובה: מתי יש תוכניות ומתי הזמן פנוי ביום ששאלתם עליו, לפי היומנים שאתם רואים ב־FamCal: שלכם, של המשפחה, וגם, לצד השם, של בן או בת הזוג ושל הילדים. שמות האירועים לא מוצגים אף פעם. תייגו אותו רק בצ׳אט שבו מתאים לכם שהמשתתפים יראו את זה.
- **Russian**
  - Current: Когда вы упоминаете бота в другом чате Telegram, он отвечает в этом чате, и ответ видят все его участники: когда вы заняты и когда свободны в день, о котором вы спросили, по всем календарям, выбранным в FamCal. Названия ваших событий он не показывает никогда. Упоминайте его только там, где вы готовы показать это участникам чата.
  - New: Когда вы упоминаете бота в другом чате Telegram, он отвечает в этом чате, и ответ видят все его участники: когда есть планы и когда время свободно в день, о котором вы спросили, по календарям, которые вы видите в FamCal: вашим и семейным, а также, с указанием имён, календарям партнёра и детей. Названия событий он не показывает никогда. Упоминайте его только там, где вы готовы показать это участникам чата.

### A7. Terms, "AI and computed times can be wrong", first item (my addition)

`legal.terms.sections.ai.blocks[1][0]`

- **English**
  - Current: understand voice notes, photos, PDFs and forwarded messages, and the day you ask about in another chat;
  - New: understand voice notes, photos, PDFs and forwarded messages, and the day and the people you ask about in another chat;
- **Hebrew**
  - Current: להבין הודעות קוליות, תמונות, קובצי PDF והודעות מועברות, ואת היום שאתם שואלים עליו בצ׳אט אחר;
  - New: להבין הודעות קוליות, תמונות, קובצי PDF והודעות מועברות, ואת היום והאנשים שאתם שואלים עליהם בצ׳אט אחר;
- **Russian**
  - Current: понимать голосовые сообщения, фото, PDF и пересланные сообщения, а также день, о котором вы спрашиваете в другом чате;
  - New: понимать голосовые сообщения, фото, PDF и пересланные сообщения, а также день и людей, о которых вы спрашиваете в другом чате;

### A8. Privacy, "Your partner", the list's item about the partner asking the bot in another chat (controller's addition)

`legal.privacy.sections.partner.blocks[1][2]`, a new item before "calendars you keep private stay private." (which moves one place on)

- **English**
  - Current: (no such item)
  - New: they can ask the bot in another Telegram chat when you’re busy: the answer, which everyone in that chat sees, shows by your name when you have plans and when you’re free, from the calendars you share with them, never what your events are;
- **Hebrew**
  - Current: (no such item)
  - New: הם יכולים לשאול את הבוט בצ׳אט אחר בטלגרם מתי יש לכם תוכניות: התשובה, שכל מי שבצ׳אט רואה, מראה לצד השם שלכם מתי יש לכם תוכניות ומתי הזמן פנוי, לפי היומנים שאתם משתפים איתם, ואף פעם לא מה האירועים שלכם;
- **Russian**
  - Current: (no such item)
  - New: он может спросить бота в другом чате Telegram, когда у вас есть планы: в ответе, который видят все участники чата, по вашему имени указано, когда у вас есть планы и когда время свободно, по календарям, которыми вы с ним поделились, но никогда не сказано, что это за события;

The Hebrew addresses the reader in the plural (אתם) as the rest of the text does, and names the partner gender-neutrally (בן או בת הזוג). The Russian stays formal (вы).

## 7. Files

- `src/services/ask-in-chat/people.ts` (new): `peopleOf`, `askedLines`, `foldName`, `HOLIDAY_CALENDAR` (moved here from `busy.ts`).
- `src/services/ask-in-chat/window.ts`: `AskGroup`, `AskWho`, `parseAskWho`, `readObject`, `who` on the result.
- `src/prompts/ask-in-chat.ts`: the `who` field and its rules.
- `src/services/ask-in-chat/busy.ts`: `readBusyDays(user, days, tz, locale)` per person.
- `src/services/ask-in-chat/text.ts`: date line plus person lines, `leadLtr`, the new `AskTexts` and `AskAnswer`.
- `src/services/ask-in-chat/handler.ts`: `readBusy` with the locale, `askedLines`, the log line.
- `src/services/calendar-provider/user-calendars.ts` and `index.ts`: `getCalendarsWithOwners`, `CalendarsWithOwners`.
- `messages/{en,he,ru}.json`: `bot.askInChat` (§4.3), and `legal.*` (§6, after the owner's OK).
- `scripts/lib/legal-ask.ts`, `src/site/legal.ts` (`LEGAL_UPDATED`, ship day).
- `CLAUDE.md`: the guest-answer rule says the lines are by person (from `getCalendarsWithOwners` and `peopleOf`), and that a person asked is matched locally and never sent to the model or logged.
- README: the feature line says "busy and free times, one line per person".

## 8. Tests (offline: no network, no database, no paid call)

- `scripts/smoke-ask-in-chat-people.ts` (new):
  - `peopleOf`: the table of §3.2 on one family's list (FamCal own and partner's, Google, birthdays and holiday), several labels, partner names from the pairing and from a spouse calendar, kid names in he and in en/ru, same-named kids sharing a line, the unnamed kids' line, no calendar at all.
  - `foldName`: niqqud, case, ё, geresh, apostrophe, spaces.
  - `askedLines`: each group, everyone, a person by Hebrew, English, niqqud, upper case, full name, prefix letter; the partner by both names; the caller by name; `kids-none`, `partner-none`, `person-none`.
- `scripts/smoke-ask-in-chat-window.ts`:
  - `parseAskWho`: each group; a trimmed person; a group's name dropped; null and missing.
  - Bad kind, no name, blank name, 61+ characters, not an object: each throws `AskWindowError`, the reason holds `"who` and never the value.
  - `readAskWindow`: carries `who`; the schema requires it; the prompt has its rules; a bad `who` is asked again with the reason.
- `scripts/smoke-ask-in-chat-busy.ts`:
  - `readBusyDays`: still one read on every id; the people from `calendarsOf` and `partnerOf`; each person gets only their calendars' intervals; the locale names them; the gap is kept; a reader failure is thrown.
- `scripts/smoke-ask-in-chat-text.ts` (in three process zones):
  - Every §4.3 row in en, he and ru, exactly (date line plus person line), the midnight edges, instants, 00:00-24:00, three days, the Hebrew-date echo.
  - The no-one-in-particular rule; the every-line fallback; a group, one person, everyone; the four fallback words in each language.
  - Google unread: free lines and empty days dropped, no free word left, "couldn't check" when nothing is left.
  - Each line's direction: a Latin name in Hebrew gets U+200F, a Hebrew name in English gets U+200E.
  - No title, no HTML.
- `scripts/smoke-ask-in-chat-handler.ts`:
  - The default answer and its log line (`who=none people=2`); the locale reaches the read.
  - A kid asked by name (free) and the kids asked get only the kid's line; an unknown name gives the default (`who=person-none`).
  - A sentinel kid name never reaches a log or a report.
- `scripts/smoke-partner-labels.ts`:
  - `getCalendarsWithOwners` returns the same list in one store read, with the partner's FamCal ids.
  - `peopleOf` on that real list: Raziel with the calendar Dana keeps about him; Dana with her primary and her named work calendar; Leo; Mia; Dana's birthdays out.
- `scripts/smoke-ask-in-chat-legal.ts`: the eight edits with the new A1/A6/A7/A8, each drafted word for word in §6 (G5); the 2026-11-07 wording of each is gone; `ASK_WORDING_DAY` 2026-11-08.
- Unchanged and still passing: `smoke-he-neutral`, `smoke-ru-formal`, `smoke-bot-key-paths`, `check-i18n-parity`, `smoke-site-truth` (T6), `smoke-signin-legal`, `smoke-pause`.
- The gate: `npx tsc --noEmit -p .`, `npm run lint`, `bash scripts/ci-smokes.sh`.
