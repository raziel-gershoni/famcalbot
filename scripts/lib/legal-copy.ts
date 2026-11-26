// What the Privacy Policy and the Terms say about sending a copy of an event (spec
// docs/superpowers/specs/2026-11-27-send-event-copy-design.md, "Privacy Policy and Terms"; the owner approved the wording on
// 2026-11-27: "legal ok"): where each sentence goes in messages/<lang>.json and what it says. smoke-event-copy-legal holds the
// messages to it. The Telegram processor's clause is C3, an insert in the string legal-ask.ts's A4 pins whole.
//
// The texts are binding, owner-approved wording (CLAUDE.md): they change only on the owner's word, in all three languages
// at once, with a new LEGAL_UPDATED (src/site/legal.ts). Russian is written here with plain spaces (see legal-ask.ts).

import type { Locale, PushLegalOp } from './legal-push';

/** The eight edits in each language: Privacy C1-C5, Terms C6-C8. Six are new list items (the item after each moves one place on). */
export const COPY_LEGAL: Record<Locale, PushLegalOp[]> = {
  en: [
    { id: 'C1', doc: 'privacy', path: 'keep.blocks.3.2', kind: 'item', shifts: "When you copy an event someone", text: "When you send a copy of an event: which event, when you sent it and, once someone copies it, who did and their copy." },
    { id: 'C2', doc: 'privacy', path: 'keep.blocks.3.3', kind: 'item', shifts: "When you delete an event or a calendar", text: "When you copy an event someone sent you, the copy becomes your event, and we tell them your name, as it was on your Telegram profile when you started the bot." },
    { id: 'C3', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'insert', before: "when you mention the bot", text: "the copies of events you send to other chats with Send a copy;" },
    { id: 'C4', doc: 'privacy', path: 'partner.blocks.1.3', kind: 'item', shifts: "calendars you keep private stay private.", text: "they can send a copy of an event from the calendars you share with them to anyone on Telegram, with its title, time and how it repeats;" },
    { id: 'C5', doc: 'privacy', path: 'rights.blocks.9.1', kind: 'item', shifts: "feedback that already reached us", text: "copies other people made of events you sent them, which are theirs;" },
    { id: 'C6', doc: 'terms', path: 'service.blocks.1.4', kind: 'item', shifts: "lets you share calendars with a partner.", text: "lets you send a copy of an event to someone on Telegram;" },
    { id: 'C7', doc: 'terms', path: 'account.blocks.0.0', kind: 'whole', text: "You’re responsible for what you add and the copies you send, including details about your children, your partner and other family members. Add and send only what you have the right to share." },
    { id: 'C8', doc: 'terms', path: 'service.blocks.4.3', kind: 'item', shifts: "paying for a plan.", text: "sending a copy of an event;" },
  ],
  he: [
    { id: 'C1', doc: 'privacy', path: 'keep.blocks.3.2', kind: 'item', shifts: "כשמעתיקים אירוע שמישהו שלח לכם", text: "כששולחים עותק של אירוע: איזה אירוע, מתי שלחתם אותו, ואחרי שמישהו מעתיק אותו, מי העתיק ואת העותק שלו." },
    { id: 'C2', doc: 'privacy', path: 'keep.blocks.3.3', kind: 'item', shifts: "כשמוחקים אירוע או יומן", text: "כשמעתיקים אירוע שמישהו שלח לכם, העותק הופך לאירוע שלכם, ואנחנו מודיעים למי ששלח אותו את השם שלכם, כפי שהיה בפרופיל הטלגרם שלכם כשהתחלתם להשתמש בבוט." },
    { id: 'C3', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'insert', before: "כשמתייגים את הבוט", text: "עותקים של אירועים שאתם שולחים לצ׳אטים אחרים עם ״שליחת עותק״;" },
    { id: 'C4', doc: 'privacy', path: 'partner.blocks.1.3', kind: 'item', shifts: "יומנים שאתם שומרים כפרטיים נשארים פרטיים.", text: "הם יכולים לשלוח עותק של אירוע מהיומנים שאתם משתפים איתם לכל אחד בטלגרם, עם הכותרת, השעה ואיך הוא חוזר;" },
    { id: 'C5', doc: 'privacy', path: 'rights.blocks.9.1', kind: 'item', shifts: "משוב שכבר הגיע אלינו", text: "עותקים שאנשים אחרים העתיקו מאירועים ששלחתם להם, שהם שלהם;" },
    { id: 'C6', doc: 'terms', path: 'service.blocks.1.4', kind: 'item', shifts: "מאפשר לשתף יומנים עם בן או בת הזוג.", text: "מאפשר לשלוח עותק של אירוע לכל אחד בטלגרם;" },
    { id: 'C7', doc: 'terms', path: 'account.blocks.0.0', kind: 'whole', text: "אתם אחראים למה שאתם מוסיפים ולעותקים שאתם שולחים, כולל פרטים על הילדים שלכם, על בן או בת הזוג ועל בני משפחה אחרים. הוסיפו ושלחו רק מידע שיש לכם זכות לשתף." },
    { id: 'C8', doc: 'terms', path: 'service.blocks.4.3', kind: 'item', shifts: "תשלום על מסלול.", text: "שליחת עותק של אירוע;" },
  ],
  ru: [
    { id: 'C1', doc: 'privacy', path: 'keep.blocks.3.2', kind: 'item', shifts: "Когда вы копируете присланное ", text: "Когда вы отправляете копию события: какое событие, когда вы его отправили, а после того как кто-то его скопирует, — кто это сделал и его копию." },
    { id: 'C2', doc: 'privacy', path: 'keep.blocks.3.3', kind: 'item', shifts: "Когда вы удаляете событие или календарь", text: "Когда вы копируете присланное вам событие, копия становится вашим событием, а мы сообщаем отправителю ваше имя — как оно было указано в вашем профиле Telegram, когда вы начали пользоваться ботом." },
    { id: 'C3', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'insert', before: "если вы упоминаете бота", text: "копии событий, которые вы отправляете в другие чаты через «Отправить копию»;" },
    { id: 'C4', doc: 'privacy', path: 'partner.blocks.1.3', kind: 'item', shifts: "календари, которые вы оставили приватными, остаются приватными.", text: "он может отправить копию события из календарей, которыми вы с ним поделились, любому пользователю Telegram — с названием, временем и тем, как оно повторяется;" },
    { id: 'C5', doc: 'privacy', path: 'rights.blocks.9.1', kind: 'item', shifts: "отзывы, которые уже пришли нам", text: "копии отправленных вами событий, которые сделали другие люди: это их события;" },
    { id: 'C6', doc: 'terms', path: 'service.blocks.1.4', kind: 'item', shifts: "позволяет делиться календарями с партнёром.", text: "позволяет отправить копию события любому пользователю Telegram;" },
    { id: 'C7', doc: 'terms', path: 'account.blocks.0.0', kind: 'whole', text: "Вы отвечаете за то, что добавляете, и за копии, которые отправляете, в том числе за сведения о ваших детях, партнёре и других членах семьи. Добавляйте и отправляйте только то, чем вы вправе делиться." },
    { id: 'C8', doc: 'terms', path: 'service.blocks.4.3', kind: 'item', shifts: "оплата тарифа.", text: "отправка копии события;" },
  ],
};

/** The sentence C7 replaced, in each language: no text may still say it. */
export const COPY_LEGAL_REPLACED: Record<Locale, string[]> = {
  en: ["You’re responsible for what you add, including details about your children, your partner and other family members. Add only what you have the right to share."],
  he: ["אתם אחראים למה שאתם מוסיפים, כולל פרטים על הילדים שלכם, על בן או בת הזוג ועל בני משפחה אחרים. הוסיפו רק מידע שיש לכם זכות לשתף."],
  ru: ["Вы отвечаете за то, что добавляете, в том числе за сведения о ваших детях, партнёре и других членах семьи. Добавляйте только то, чем вы вправе делиться."],
};
