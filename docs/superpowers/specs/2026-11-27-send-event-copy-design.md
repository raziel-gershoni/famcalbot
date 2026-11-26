# Send a copy of an event — design

Owner 2026-11-26: "sharing a calendar with tg user. as simple as possible", then "know what maybe not sharing a cal, but sharing a single event". Agreed in chat on 2026-11-27. The owner's one objection was the link's lifetime: "make it one time meaning the first to copy kills the copy proposal. all the rest accepted". After the builder check, the owner approved two more points ("both approved"): drafting new Privacy Policy and Terms lines, and letting a partner's events be sent. They also added a notice to the sender ("i'd like a notification when someone adds an event via link, i think you could tell me who it is also").

**Status:** built 2026-11-27, with the Privacy Policy and Terms lines approved by the owner after a legal review ("ok"). The plan file was deleted at ship (git history: `docs/superpowers/plans/2026-11-27-send-event-copy.md`).

**Claude's calls while building:**
- Send a copy shows to anyone who can see the event, not only an editor.
- The claim is one plain conditional update; a claim whose original was deleted meanwhile gives itself back.
- A failure to record the copy keeps the claim, since a release would allow a second copy.
- A second tap during one's own copy changes nothing; /start then says "You already copied this event".
- /start cp_ is answered only in the bot's private chat.
- Sentry scrubs cp_/cp: tokens (and the partner invite's invite_ token, a gap of the same kind).
- The card's "all day" is lower case, in its own words; repeats read as the sheet's ("Every week on Monday").
- A repeating event's usual time on the card is its first occurrence's, read in the viewer's zone. Across zones with different summer-time dates it can be an hour off part of the year (the copy itself is exact).

## Why

People want to hand one event to someone on Telegram: the dentist to a spouse who uses another calendar, a recital to grandma, a party to a friend. Sharing a whole calendar would need a third kind of calendar (neither yours nor your partner's) in every reader: the home, the summaries, the voice show, alerts, Ask FamCal in a chat and the bot's placement. A copy needs none of that. Once made, it is the receiver's own event, and every part of FamCal already handles it.

## What the person sees

1. **The sender:** on a FamCal event's sheet in the Mini App, a **Send a copy** button (he "שליחת עותק", ru "Отправить копию"; lucide `Forward`, not the header's paper plane). It opens Telegram's own picker of chats and contacts. The person picks someone, or a group, and a card goes from their account, marked "via @<bot>":
   - the event's title;
   - for a one-off event, its date and time, or "all day";
   - for a repeating event, its repeat in the sheet's words and its usual time ("Every Tuesday, 10:00–11:00", "Every year on 16 Kislev"), not the day the sender opened, because the copy is the whole series;
   - one button, **Copy to my calendar** (he "העתקה ליומן שלי", ru "Скопировать в свой календарь").
2. **The receiver** taps the button. The FamCal chat opens; someone new gets an account on the way in, as with the partner invite. The bot shows the event in the receiver's language and time zone, and asks which calendar it goes to, with one button per FamCal calendar they can add to. They pick one, and the bot's message turns into "Copied to <calendar>", with the event's line.
3. **One copy per card (owner):** the first person to copy it uses the card up. Anyone who taps it after that is told it was already copied and can ask for a new one. The person who took it is told which calendar it is in. Sending to a group therefore gives one copy; the sender sends again for each person who wants one.
4. **The sender is told (owner):** once the copy is made, the bot tells the sender who copied it: "<name> copied “Dentist” to their calendar". The name is the one FamCal keeps for the receiver, their Telegram first and last name from when they started the bot; "Someone" if there is none. It is in the sender's language.
   - The receiver's message says "the sender was told", never the sender's name, since the receiver may not know them by it (legal review, 2026-11-27).
   - Before they pick a calendar, the receiver is told the sender will learn their name.
   - A Telegram account stored as "User" (an empty Telegram name) counts as no name.

## Decisions (owner, 2026-11-26/27)

- **A copy, not a live event.** Changes to the original after the copy don't reach it. Each copy is remembered with its original (see "The offer"), so a later upgrade, where originals update their copies, can include every copy made before it.
- **Named "Send a copy" and "Copy to my calendar"**, never "share" (owner: "it should be called smth like 'copy to my cal'").
- **The card (Bot API `savePreparedInlineMessage` and the Mini App's `shareMessage`)**, with the plain share link as the fallback (owner: "if B is not a lot harder than A, i'd pick it").
- **The receiver picks the calendar.**
- **FamCal only:** only FamCal events can be sent, and copies go only into FamCal calendars (owner: "no need for gcal support for now").
- Claude's calls, accepted by the owner:
  - The receiver gets the event as it is when they copy it, not as it was when it was sent. If the original was deleted, they are told it is gone.
  - Telegram only: there is no Send a copy button on the website (famcal.bot in a browser), where Telegram's picker does not exist.
  - Every plan can send and copy.
  - Reminders cannot be sent: they are personal.
  - A repeating event is copied whole, as it is, from its first date, with its end or count unchanged. The card and the receiver's message describe it by its repeat, so neither can show a day the copy doesn't have. (Claude's call after the builder check.)
  - What is copied: the title, the time or all-day, the repeat (including Hebrew-date repeats and the skipped days) and the birthday mark with its birth year. The receiver's own alert settings apply, and single-day changes inside a repeating event stay behind. The description and the location stay behind too: they can hold private notes, and the card never showed them.

## The offer

- **The table:** a new `EventCopyOffer`, with a migration:
  - the original event (`sourceEventId`);
  - the sender (`senderUserId`);
  - a token's SHA-256 (`tokenHash`, unique);
  - when it was made;
  - once taken: who took it (`takenByUserId`), when (`takenAt`) and the copy (`copyEventId`).
  
  This row is how a copy remembers its original.
- **The token:** 16 random bytes in base64url (22 characters, as Connect Telegram's), never stored or logged in clear. The deep link is `https://t.me/<bot>?start=cp_<token>`, with the bot's username as the other deep links take it. It stays within Telegram's 64 characters.
- **A new offer per tap:** every tap on Send a copy makes a new offer. An offer nobody takes stays unused and harmless.
- **No expiry by time.** An offer ends when it is taken or when its original is deleted.
- **The sender's own tap never uses the card up.** Tapping their own card tells them it is waiting for someone else.
- **Checked again at the copy (Claude's call after the builder check).** An offer copies only while:
  - its original is not deleted;
  - the sender can still see the original's calendar (`getCalendarAccess` is not `none`; a partner's calendar made private, or an unlink, ends it);
  - the sender's account is active (not suspended, banned or deleted).
  
  Otherwise the receiver is told it is no longer available.
- **Deleting accounts:** an account's offers are deleted with it. When the receiver's account is deleted, their part of a taken offer is cleared; their copy goes with their events.

## How it flows (the parts decided here)

- **Making the card:** a new Mini App route, authenticated like the other item routes (`verifyUserAuth` with the init data, a rate limiter). It refuses:
  - an item that is not a FamCal EVENT (a reminder, a Google event);
  - an event whose calendar the person can't see (`getCalendarAccess` is `none`);
  - an account with no Telegram.
  
  Otherwise it makes the offer and calls `savePreparedInlineMessage` through `getBot()`'s Api, with the library's method and the codebase's Telegram retry (`retryWithBackoff` with `telegramRetryVerdict`, as `answerGuestQuery`):
  - `user_id` is the sender's Telegram id;
  - private chats and groups are allowed;
  - the result is an article, built like `guestAnswerArticle`, with the card's text and a URL button.
  
  It answers with the prepared message's id, and with the deep link and the card's text for the fallback. The card's words are in the sender's language and its times in the sender's zone.
- **Sending from the Mini App:**
  - When the client has `shareMessage` (Bot API 8.0 or later; add it to `src/types/telegram-webapp.d.ts`), it calls `shareMessage(id)`.
  - When it doesn't, when the server could not prepare the card, or when `shareMessage` fails as UNSUPPORTED, it opens `https://t.me/share/url?url=<link>&text=<card text>` with `openTelegramLink`.
  - The person closing the picker is no error.
  - A failure shows the sheet's usual error note and is logged.
  - If the prepare call fails in production because the bot needs inline mode (Telegram's documented errors don't say so), the fallback keeps it working. The log names Telegram's refusal through `telegramErrorInfo`, and the owner is given the BotFather steps.
- **The receiver's /start:**
  - A `cp_` branch sits beside `invite_` in `handleStartCommand`, after the account is made or found, and ends the same way (the policy footer, then "Address me as" for a new account).
  - It looks the offer up by the token's hash. It answers: the link doesn't work; already yours, in <calendar>; already copied by someone else; the event is gone; or, for the sender, waiting for someone else.
  - Otherwise it shows the event and one button per calendar from `writableCalendarRows`, the receiver's own first and their main calendar first among them. A person with no FamCal calendar gets their main one made first (`getMainNativeCalendar`).
- **The press:**
  - A new `cp:` callback prefix goes in the webhook's chain. The data names the offer by its token and the calendar by its id, never by its place in the list, and stays within 64 bytes. It answers the callback first, as the others do.
  - It checks the calendar is still writable for the presser.
  - It claims the offer with one conditional update (untaken, the original not deleted), so two people pressing at once get one copy.
  - It then writes the copy through the event store (`createNativeEvent`, extended to take the skipped days and the birth year, with the store validating them as it does the rest). The copy's creator is the receiver.
  - It records the copy on the offer and edits the bot's message to the result.
  - If the write fails, the claim is released, the person is asked to try again, and the error goes to Sentry.
- **Rules every sender and writer obeys (CLAUDE.md):**
  - The new claim handler writes events only through the store (`OPENS` in `scripts/smoke-alerts-gate-writers.ts`).
  - Its replies answer the person's own action (`NOT_PAUSED` in `scripts/smoke-pause.ts`).
  - Every Bot API call goes through `getBot()`.
  - Failures are read with `telegramErrorInfo`.
- **The notice to the sender:**
  - It goes to the sender's Telegram chat after the copy is committed.
  - It is sent without a sound and doesn't wait for the Shabbat and Yom Tov pause. It answers the receiver's action, like the quiet note a partner gets when a reminder is marked done (`NOT_PAUSED` in `scripts/smoke-pause.ts`, with that reason).
  - A sender with no Telegram chat or a blocked bot is logged, as every send's failure is, and the copy stands.
  - It names the receiver, never the token.
- **Logs:** one line per offer made, per answer given and per copy taken, naming the user ids, the offer's id, the event's id and the calendar's id. Never the token, the title, a name or the text.

## Privacy Policy and Terms (waiting for the owner's word)

The feature adds:
- a record that is kept: the offer, linking the original, the sender, the receiver and the copy;
- a way an event's title and time leave the account: the card the person sends, through Telegram, and the copy someone makes from it, including from a partner's calendar the person can see (owner: allowed);
- the receiver's name going to the sender, in the notice.

The approved texts list each such item, so they need new lines in all three languages, with a new `LEGAL_UPDATED`, before this ships:
- Privacy:
  - What we keep: the offer record.
  - Telegram among the processors: the cards.
  - Your partner: they can send a copy of an event from the calendars you share with them.
  - The receiver's name told to the sender.
  - How long we keep it.
  - What deleting an account does to offers and copies.
- Terms: the service list, and the existing duty to add only what you have the right to share, extended to sending copies.

The owner approves the wording before the build ships.

## Non-goals

- A live event that follows the original's changes. The offer row keeps the way open.
- Google events and Google calendars.
- Reminders.
- Sending from a browser.
- Choosing the receiver inside FamCal: Telegram's picker does that, and Telegram does not tell FamCal whom the person picked.
- A copy per member of a group from one card.
- Copying single-day changes, the description or the location.
- Calendar sharing (parked: see the 2026-11-26 recon in the owner's notes).

## Constraints

- Copy in en, he and ru: natural, gender-neutral Hebrew (the notice's "copied" included), formal Russian. The bot's words live in `messages/*.json` under `bot`, and the sheet's under `calendarHome.sheet`.
- Lucide icons only, no emoji; no `:hover`; light and dark; RTL.
- The pause rule, the alerts gate and the Telegram wire rules above.
- No console line or Sentry field holds the token, a title, a name or the card's text.
- Tests: TDD smokes with a fake bot and fake fetch. Never the real Telegram API.

## Left to the builder

- The route's path and the exact JSON.
- The migration's name.
- The exact copy, within the words above.
- The card's article id and its description line.
- The `cp:` data's exact layout.
- Whether the copy's message after a press carries an Open FamCal button.
- The smokes' shape.
