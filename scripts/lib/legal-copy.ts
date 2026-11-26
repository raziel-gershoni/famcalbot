// What the Privacy Policy and the Terms say about sending a copy of an event (spec
// docs/superpowers/specs/2026-11-27-send-event-copy-design.md, "Privacy Policy and Terms"): the owner approved the first
// wording on 2026-11-27 ("legal ok") and, the same day, the legal review's changes ("ok"). Where each sentence goes in
// messages/<lang>.json and what it says; smoke-event-copy-legal holds the messages to it. The Telegram processor's string
// is pinned whole by legal-ask.ts's A4, the use and EU/UK contract lines by legal-push.ts's P3 and P13.
//
// The texts are binding, owner-approved wording (CLAUDE.md): they change only on the owner's word, in all three languages
// at once, with a new LEGAL_UPDATED (src/site/legal.ts). Russian is written here with plain spaces (see legal-ask.ts).

import type { Locale, PushLegalOp } from './legal-push';

/** The seventeen edits in each language: Privacy C1-C5, C9-C15; Terms C6-C8, C16, C17. */
export const COPY_LEGAL: Record<Locale, PushLegalOp[]> = {
  en: [
    { id: 'C1', doc: 'privacy', path: 'keep.blocks.3.2', kind: 'item', shifts: "When you copy an event someone", text: "When you tap Send a copy: which event, when you tapped and, once someone copies it, who did, when, and their copy. Whoever copies it first gets the event as it is at that moment. Until then the card keeps working, unless the event is deleted or you can no longer see its calendar." },
    { id: 'C2', doc: 'privacy', path: 'keep.blocks.3.3', kind: 'item', shifts: "When you delete an event or a ", text: "When you copy an event someone sent you, the copy becomes your event. We keep a record that you copied it, and tell the sender your name as we keep it for your account." },
    { id: 'C3', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'insert', before: "when you mention the bot", text: "the cards you send to other chats with Send a copy, with an event’s title and when it is, which everyone in that chat sees;" },
    { id: 'C4', doc: 'privacy', path: 'partner.blocks.1.3', kind: 'item', shifts: "calendars you keep private sta", text: "they can send a copy of an event from the calendars you share with them to anyone on Telegram: its title, time, how it repeats and, for a birthday, the year of birth, never its place or notes;" },
    { id: 'C5', doc: 'privacy', path: 'rights.blocks.9.1', kind: 'item', shifts: "cards you sent with Send a cop", text: "copies other people made of your events, from cards you or your partner sent them, which are theirs;" },
    { id: 'C6', doc: 'terms', path: 'service.blocks.1.4', kind: 'item', shifts: "lets you share calendars with ", text: "lets you send a copy of an event to anyone on Telegram;" },
    { id: 'C7', doc: 'terms', path: 'account.blocks.0.0', kind: 'whole', text: "You’re responsible for what you add and the copies you send, including details about your children, your partner and other family members. Add and send only what you have the right to share." },
    { id: 'C8', doc: 'terms', path: 'service.blocks.4.3', kind: 'item', shifts: "paying for a plan.", text: "sending a copy of an event;" },
    { id: 'C9', doc: 'privacy', path: 'rights.blocks.9.2', kind: 'item', shifts: "feedback that already reached ", text: "cards you sent with Send a copy, and notices that named you in another person’s chat with the bot, which stay in Telegram;" },
    { id: 'C10', doc: 'privacy', path: 'retention.blocks.0.10', kind: 'item', text: "**Copies of events:** the record of each copy you send, until your account, or the account whose calendar holds the event, is deleted. If you copied one, your link to that record goes when your account is deleted." },
    { id: 'C11', doc: 'privacy', path: 'rights.blocks.7.0', kind: 'insert', before: "your sign-in methods", text: "the records of copies of events you sent and your link to the ones you took," },
    { id: 'C12', doc: 'privacy', path: 'use.blocks.0.0', kind: 'insert', before: "and your Google connection", text: "sending copies of events," },
    { id: 'C13', doc: 'privacy', path: 'euUk.blocks.2.0', kind: 'insert', before: "briefings", text: "sending copies of events," },
    { id: 'C14', doc: 'privacy', path: 'euUk.blocks.2.4', kind: 'item', shifts: "For the settings that can show", text: "To tell the person who sent a copy of an event who copied it: our legitimate interest, and the sender’s, in knowing who took a copy that works once." },
    { id: 'C15', doc: 'privacy', path: 'euUk.blocks.2.3', kind: 'swap', from: "For details you add about", to: "For details you add or send about" },
    { id: 'C16', doc: 'terms', path: 'fairUse.blocks.1.1', kind: 'whole', text: "add or send details about someone that you have no right to share;" },
    { id: 'C17', doc: 'terms', path: 'account.blocks.0.3', kind: 'whole', text: "A partner sees the calendars you share with them, and can send copies of their events. If you allow it, they can also change them." },
  ],
  he: [
    { id: 'C1', doc: 'privacy', path: 'keep.blocks.3.2', kind: 'item', shifts: "כשמעתיקים אירוע שנשלח אליכם, ה", text: "כשלוחצים על ״שליחת עותק״: איזה אירוע, מתי לחצתם, ואחרי שמישהו מעתיק אותו, מי העתיק, מתי, והעותק שלו. מי שמעתיק ראשון מקבל את האירוע כפי שהוא באותו רגע. עד אז הכרטיס ממשיך לעבוד, אלא אם האירוע נמחק או שאין לכם יותר גישה ליומן שלו." },
    { id: 'C2', doc: 'privacy', path: 'keep.blocks.3.3', kind: 'item', shifts: "כשמוחקים אירוע או יומן, אתם וב", text: "כשמעתיקים אירוע שנשלח אליכם, העותק הופך לאירוע שלכם. אנחנו שומרים רישום שהעתקתם אותו, ומודיעים למי ששלח אותו את השם שלכם, כפי שהוא נשמר בחשבון שלכם." },
    { id: 'C3', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'insert', before: "כשמתייגים את הבוט", text: "הכרטיסים שאתם שולחים לצ׳אטים אחרים עם ״שליחת עותק״, עם הכותרת של האירוע ומתי הוא, שכל מי שבצ׳אט רואה;" },
    { id: 'C4', doc: 'privacy', path: 'partner.blocks.1.3', kind: 'item', shifts: "יומנים שאתם שומרים כפרטיים נשא", text: "הם יכולים לשלוח עותק של אירוע מהיומנים שאתם משתפים איתם לכל אחד בטלגרם: הכותרת, השעה, איך הוא חוזר, וביום הולדת גם שנת הלידה, אבל אף פעם לא המקום או ההערות;" },
    { id: 'C5', doc: 'privacy', path: 'rights.blocks.9.1', kind: 'item', shifts: "כרטיסים ששלחתם עם ״שליחת עותק״", text: "עותקים שאנשים אחרים העתיקו מהאירועים שלכם, מכרטיסים ששלחתם להם אתם או בן או בת הזוג, שהם שלהם;" },
    { id: 'C6', doc: 'terms', path: 'service.blocks.1.4', kind: 'item', shifts: "מאפשר לשתף יומנים עם בן או בת ", text: "מאפשר לשלוח עותק של אירוע לכל אחד בטלגרם;" },
    { id: 'C7', doc: 'terms', path: 'account.blocks.0.0', kind: 'whole', text: "אתם אחראים למה שאתם מוסיפים ולעותקים שאתם שולחים, כולל פרטים על הילדים שלכם, על בן או בת הזוג ועל בני משפחה אחרים. הוסיפו ושלחו רק מידע שיש לכם זכות לשתף." },
    { id: 'C8', doc: 'terms', path: 'service.blocks.4.3', kind: 'item', shifts: "תשלום על מסלול.", text: "שליחת עותק של אירוע;" },
    { id: 'C9', doc: 'privacy', path: 'rights.blocks.9.2', kind: 'item', shifts: "משוב שכבר הגיע אלינו כהודעות ב", text: "כרטיסים ששלחתם עם ״שליחת עותק״, והודעות שהזכירו את השם שלכם בצ׳אט של מישהו אחר עם הבוט, שנשארים בטלגרם;" },
    { id: 'C10', doc: 'privacy', path: 'retention.blocks.0.10', kind: 'item', text: "**עותקים של אירועים:** הרישום של כל עותק ששולחים נשמר עד שהחשבון שלכם, או החשבון שביומן שלו נמצא האירוע, נמחק. אם העתקתם עותק, הקישור שלכם לרישום נמחק כשהחשבון שלכם נמחק." },
    { id: 'C11', doc: 'privacy', path: 'rights.blocks.7.0', kind: 'insert', before: "את דרכי הכניסה", text: "את הרישומים של עותקים ששלחתם ואת הקישור שלכם לעותקים שהעתקתם," },
    { id: 'C12', doc: 'privacy', path: 'use.blocks.0.0', kind: 'insert', before: "והחיבור ל־Google", text: "שליחת עותקים של אירועים," },
    { id: 'C13', doc: 'privacy', path: 'euUk.blocks.2.0', kind: 'insert', before: "הסיכומים", text: "שליחת עותקים של אירועים," },
    { id: 'C14', doc: 'privacy', path: 'euUk.blocks.2.4', kind: 'item', shifts: "להגדרות שיכולות ללמד על אורח ה", text: "כדי להודיע למי ששלח עותק של אירוע מי העתיק אותו: האינטרס הלגיטימי שלנו, ושל מי ששלח אותו, לדעת מי לקח עותק שעובד פעם אחת." },
    { id: 'C15', doc: 'privacy', path: 'euUk.blocks.2.3', kind: 'swap', from: "לפרטים שאתם מוסיפים על", to: "לפרטים שאתם מוסיפים או שולחים על" },
    { id: 'C16', doc: 'terms', path: 'fairUse.blocks.1.1', kind: 'whole', text: "להוסיף או לשלוח פרטים על אדם כשאין לכם זכות לשתף אותם;" },
    { id: 'C17', doc: 'terms', path: 'account.blocks.0.3', kind: 'whole', text: "בן או בת הזוג רואים את היומנים שאתם משתפים איתם, ויכולים לשלוח עותקים של האירועים שבהם. אם תאפשרו, הם יוכלו גם לשנות אותם." },
  ],
  ru: [
    { id: 'C1', doc: 'privacy', path: 'keep.blocks.3.2', kind: 'item', shifts: "Когда вы копируете присланное ", text: "Когда вы нажимаете «Отправить копию»: какое событие, когда вы нажали, а после того как кто-то его скопирует, — кто и когда это сделал и сделанную им копию. Тот, кто скопирует первым, получит событие таким, каким оно будет в этот момент. До тех пор карточка действует, если только событие не удалено и у вас остаётся доступ к его календарю." },
    { id: 'C2', doc: 'privacy', path: 'keep.blocks.3.3', kind: 'item', shifts: "Когда вы удаляете событие или ", text: "Когда вы копируете присланное вам событие, копия становится вашим событием. Мы сохраняем запись о том, что вы его скопировали, и сообщаем отправителю ваше имя — так, как оно сохранено в вашем аккаунте." },
    { id: 'C3', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'insert', before: "если вы упоминаете бота", text: "карточки, которые вы отправляете в другие чаты через «Отправить копию», с названием события и временем, когда оно будет, — их видят все участники чата;" },
    { id: 'C4', doc: 'privacy', path: 'partner.blocks.1.3', kind: 'item', shifts: "календари, которые вы оставили", text: "он может отправить копию события из календарей, которыми вы с ним поделились, в любой чат Telegram: название, время, как оно повторяется, а для дня рождения — год рождения, но никогда не место и не заметки;" },
    { id: 'C5', doc: 'privacy', path: 'rights.blocks.9.1', kind: 'item', shifts: "карточки, которые вы отправили", text: "копии ваших событий, которые сделали другие люди по карточкам от вас или вашего партнёра: это их события;" },
    { id: 'C6', doc: 'terms', path: 'service.blocks.1.4', kind: 'item', shifts: "позволяет делиться календарями", text: "позволяет отправить копию события в любой чат Telegram;" },
    { id: 'C7', doc: 'terms', path: 'account.blocks.0.0', kind: 'whole', text: "Вы отвечаете за то, что добавляете, и за копии, которые отправляете, в том числе за сведения о ваших детях, партнёре и других членах семьи. Добавляйте и отправляйте только то, чем вы вправе делиться." },
    { id: 'C8', doc: 'terms', path: 'service.blocks.4.3', kind: 'item', shifts: "оплата тарифа.", text: "отправка копии события;" },
    { id: 'C9', doc: 'privacy', path: 'rights.blocks.9.2', kind: 'item', shifts: "отзывы, которые уже пришли нам", text: "карточки, которые вы отправили через «Отправить копию», и уведомления с вашим именем в чате другого человека с ботом: они остаются в Telegram;" },
    { id: 'C10', doc: 'privacy', path: 'retention.blocks.0.10', kind: 'item', text: "**Копии событий:** запись о каждой отправленной вами копии хранится, пока не будет удалён ваш аккаунт или аккаунт, в календаре которого находится событие. Если копию взяли вы, ваша связь с этой записью удаляется вместе с вашим аккаунтом." },
    { id: 'C11', doc: 'privacy', path: 'rights.blocks.7.0', kind: 'insert', before: "способы входа", text: "записи об отправленных вами копиях событий и вашу связь с копиями, которые вы взяли," },
    { id: 'C12', doc: 'privacy', path: 'use.blocks.0.0', kind: 'insert', before: "и подключение Google", text: "отправка копий событий" },
    { id: 'C13', doc: 'privacy', path: 'euUk.blocks.2.0', kind: 'insert', before: "сводки", text: "отправка копий событий," },
    { id: 'C14', doc: 'privacy', path: 'euUk.blocks.2.4', kind: 'item', shifts: "Для настроек, которые могут го", text: "Чтобы сообщить отправителю копии события, кто её скопировал: наш законный интерес и интерес отправителя в том, чтобы знать, кто забрал одноразовую копию." },
    { id: 'C15', doc: 'privacy', path: 'euUk.blocks.2.3', kind: 'swap', from: "которые вы добавляете:", to: "которые вы добавляете или отправляете:" },
    { id: 'C16', doc: 'terms', path: 'fairUse.blocks.1.1', kind: 'whole', text: "добавлять или отправлять сведения о человеке, которыми вы не вправе делиться;" },
    { id: 'C17', doc: 'terms', path: 'account.blocks.0.3', kind: 'whole', text: "Партнёр видит календари, которыми вы с ним поделились, и может отправлять копии их событий. Если вы разрешите, он сможет их и изменять." },
  ],
};

/** Whole sentences these edits replaced, in each language: no text may still say them. */
export const COPY_LEGAL_REPLACED: Record<Locale, string[]> = {
  en: [
    "When you send a copy of an event: which event, when you sent it and, once someone copies it, who did and their copy.",
    "When you copy an event someone sent you, the copy becomes your event, and we tell them your name, as it was on your Telegram profile when you started the bot.",
    "they can send a copy of an event from the calendars you share with them to anyone on Telegram, with its title, time and how it repeats;",
    "copies other people made of events you sent them, which are theirs;",
    "add details about someone that you have no right to share;",
    "A partner sees the calendars you share with them. If you allow it, they can also change them.",
    "lets you send a copy of an event to someone on Telegram;",
    "You’re responsible for what you add, including details about your children, your partner and other family members. Add only what you have the right to share.",
  ],
  he: [
    "כששולחים עותק של אירוע: איזה אירוע, מתי שלחתם אותו, ואחרי שמישהו מעתיק אותו, מי העתיק ואת העותק שלו.",
    "כשמעתיקים אירוע שמישהו שלח לכם, העותק הופך לאירוע שלכם, ואנחנו מודיעים למי ששלח אותו את השם שלכם, כפי שהיה בפרופיל הטלגרם שלכם כשהתחלתם להשתמש בבוט.",
    "הם יכולים לשלוח עותק של אירוע מהיומנים שאתם משתפים איתם לכל אחד בטלגרם, עם הכותרת, השעה ואיך הוא חוזר;",
    "עותקים שאנשים אחרים העתיקו מאירועים ששלחתם להם, שהם שלהם;",
    "להוסיף פרטים על אדם כשאין לכם זכות לשתף אותם;",
    "בן או בת הזוג רואים את היומנים שאתם משתפים איתם. אם תאפשרו, הם יוכלו גם לשנות אותם.",
    "אתם אחראים למה שאתם מוסיפים, כולל פרטים על הילדים שלכם, על בן או בת הזוג ועל בני משפחה אחרים. הוסיפו רק מידע שיש לכם זכות לשתף.",
  ],
  ru: [
    "Когда вы отправляете копию события: какое событие, когда вы его отправили, а после того как кто-то его скопирует, — кто это сделал и его копию.",
    "Когда вы копируете присланное вам событие, копия становится вашим событием, а мы сообщаем отправителю ваше имя — как оно было указано в вашем профиле Telegram, когда вы начали пользоваться ботом.",
    "он может отправить копию события из календарей, которыми вы с ним поделились, любому пользователю Telegram — с названием, временем и тем, как оно повторяется;",
    "копии отправленных вами событий, которые сделали другие люди: это их события;",
    "добавлять сведения о человеке, которыми вы не вправе делиться;",
    "Партнёр видит календари, которыми вы с ним поделились. Если вы разрешите, он сможет их и изменять.",
    "позволяет отправить копию события любому пользователю Telegram;",
    "Вы отвечаете за то, что добавляете, в том числе за сведения о ваших детях, партнёре и других членах семьи. Добавляйте только то, чем вы вправе делиться.",
  ],
};
