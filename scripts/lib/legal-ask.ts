// What the Privacy Policy and the Terms say about asking FamCal in another chat (spec
// docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §9, the wording waiting for the owner's OK): where each sentence
// goes in messages/<lang>.json and what it says. smoke-ask-in-chat-legal holds the messages to it. scripts/lib/ is not a
// smoke (ci-smokes.sh runs scripts/smoke-*.ts only).
//
// The texts are binding, owner-approved wording (CLAUDE.md): they change only on the owner's word, in all three languages
// at once, with a new LEGAL_UPDATED (src/site/legal.ts). A wording change is an edit here and in messages/, nothing else.
// Russian is written here with plain spaces; messages/ru.json binds a one-letter word and a dash with a no-break space
// (smoke-site-truth T6), and `problem` (legal-push.ts) reads U+00A0 as a plain space.

import type { Locale, PushLegalOp } from './legal-push';

/**
 * The seven edits in each language, in the spec's order: Privacy (a)-(d) (A1-A4), then the Terms' (e) (an item, A5, and a paragraph, A6) and (f) (A7).
 * Three are new entries inside their lists (the entry after each moves one place on); four replace a whole string.
 */
export const ASK_LEGAL: Record<Locale, PushLegalOp[]> = {
  en: [
    { id: 'A1', doc: 'privacy', path: 'notKeep.blocks.0.2', kind: 'item', shifts: '**Audio we make for you**', text: '**A message you ask about in another chat** (Telegram only). When you reply to a message in another Telegram chat and mention our bot, Telegram sends us that message, which someone else may have written, and your mention. We send both to the AI only to find the day and time you’re asking about, and we keep neither. The bot then answers in that chat, where everyone in it can see the answer: it shows only when you’re busy and when you’re free, never what your events are.' },
    { id: 'A2', doc: 'privacy', path: 'use.blocks.0.1', kind: 'whole', text: 'To understand what you send the bot: voice notes, photos, PDFs, forwarded messages, typed reminders, and the message you ask about when you mention the bot in another chat.' },
    { id: 'A3', doc: 'privacy', path: 'processors.blocks.1.0.items.0', kind: 'whole', text: 'your voice notes, photos, PDFs, forwarded messages and typed reminders, and a message you ask about in another chat with your mention, so it can understand them;' },
    { id: 'A4', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'whole', text: '**Telegram:** every message between you and the bot; when you mention the bot in another chat, the message you ask about, your mention and the bot’s answer there; the web app’s sign-in, signing in to famcal.bot with Telegram, and Stars payments.' },
    { id: 'A5', doc: 'terms', path: 'service.blocks.4.2', kind: 'item', shifts: 'paying for a plan.', text: 'asking when you’re free from another chat;' },
    { id: 'A6', doc: 'terms', path: 'service.blocks.5', kind: 'item', shifts: 'An account made on famcal.bot', text: 'When you mention the bot in another Telegram chat, it answers in that chat, and everyone in it sees the answer: when you’re busy and when you’re free on the day you asked about, from all the calendars you chose in FamCal. It never shows your events’ names. Mention it only where you’re happy for the people there to see that.' },
    { id: 'A7', doc: 'terms', path: 'ai.blocks.1.0', kind: 'whole', text: 'understand voice notes, photos, PDFs and forwarded messages, and the day you ask about in another chat;' },
  ],
  he: [
    { id: 'A1', doc: 'privacy', path: 'notKeep.blocks.0.2', kind: 'item', shifts: '**קטעי שמע שאנחנו מכינים לכם**', text: '**הודעה שאתם שואלים עליה בצ׳אט אחר** (בטלגרם בלבד). כשעונים להודעה בצ׳אט אחר בטלגרם ומתייגים בתשובה את הבוט שלנו, טלגרם שולחת אלינו את ההודעה הזו, שאולי כתב מישהו אחר, ואת התיוג שלכם. אנחנו שולחים את שתיהן לבינה המלאכותית רק כדי להבין על איזה יום ושעה אתם שואלים, ולא שומרים אף אחת מהן. אחר כך הבוט עונה באותו צ׳אט, וכל מי שנמצא בו רואה את התשובה: היא מראה רק מתי אתם עסוקים ומתי אתם פנויים, ואף פעם לא מה האירועים שלכם.' },
    { id: 'A2', doc: 'privacy', path: 'use.blocks.0.1', kind: 'whole', text: 'כדי להבין מה שולחים לבוט: הודעות קוליות, תמונות, קובצי PDF, הודעות מועברות, תזכורות שמקלידים, וההודעה שאתם שואלים עליה כשמתייגים את הבוט בצ׳אט אחר.' },
    { id: 'A3', doc: 'privacy', path: 'processors.blocks.1.0.items.0', kind: 'whole', text: 'את ההודעות הקוליות, התמונות, קובצי ה־PDF, ההודעות המועברות והתזכורות שאתם מקלידים, וגם הודעה שאתם שואלים עליה בצ׳אט אחר יחד עם התיוג שלכם, כדי שיוכל להבין אותם;' },
    { id: 'A4', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'whole', text: '**טלגרם:** כל הודעה בינכם לבין הבוט; כשמתייגים את הבוט בצ׳אט אחר, ההודעה שאתם שואלים עליה, התיוג שלכם והתשובה של הבוט שם; ההתחברות לאפליקציית הרשת, הכניסה ל־famcal.bot עם טלגרם, ותשלומים בכוכבים.' },
    { id: 'A5', doc: 'terms', path: 'service.blocks.4.2', kind: 'item', shifts: 'תשלום על מסלול.', text: 'שאלה מתוך צ׳אט אחר מתי אתם פנויים;' },
    { id: 'A6', doc: 'terms', path: 'service.blocks.5', kind: 'item', shifts: 'חשבון שנפתח ב־famcal.bot', text: 'כשמתייגים את הבוט בצ׳אט אחר בטלגרם, הוא עונה באותו צ׳אט, וכל מי שנמצא בו רואה את התשובה: מתי אתם עסוקים ומתי אתם פנויים ביום ששאלתם עליו, לפי כל היומנים שבחרתם ב־FamCal. שמות האירועים שלכם לא מוצגים אף פעם. תייגו אותו רק בצ׳אט שבו מתאים לכם שהמשתתפים יראו את זה.' },
    { id: 'A7', doc: 'terms', path: 'ai.blocks.1.0', kind: 'whole', text: 'להבין הודעות קוליות, תמונות, קובצי PDF והודעות מועברות, ואת היום שאתם שואלים עליו בצ׳אט אחר;' },
  ],
  ru: [
    { id: 'A1', doc: 'privacy', path: 'notKeep.blocks.0.2', kind: 'item', shifts: '**Аудио, которое мы создаём', text: '**Сообщение, о котором вы спрашиваете в другом чате** (только в Telegram). Когда вы отвечаете на сообщение в другом чате Telegram и упоминаете в ответе нашего бота, Telegram передаёт нам это сообщение (его мог написать кто-то другой) и ваше упоминание. Мы отправляем их ИИ только для того, чтобы понять, о каком дне и времени вы спрашиваете, и не храним ни то, ни другое. Затем бот отвечает в том же чате, и ответ видят все его участники: в нём указано только, когда вы заняты и когда свободны, но никогда не сказано, что это за события.' },
    { id: 'A2', doc: 'privacy', path: 'use.blocks.0.1', kind: 'whole', text: 'Чтобы понять, что вы присылаете боту: голосовые сообщения, фото, PDF, пересланные сообщения, напоминания, введённые текстом, и сообщение, о котором вы спрашиваете, упомянув бота в другом чате.' },
    { id: 'A3', doc: 'privacy', path: 'processors.blocks.1.0.items.0', kind: 'whole', text: 'ваши голосовые сообщения, фото, PDF, пересланные сообщения и напоминания, введённые текстом, а также сообщение, о котором вы спрашиваете в другом чате, вместе с вашим упоминанием, — чтобы их понять;' },
    { id: 'A4', doc: 'privacy', path: 'processors.blocks.1.1', kind: 'whole', text: '**Telegram:** все сообщения между вами и ботом; если вы упоминаете бота в другом чате, то сообщение, о котором вы спрашиваете, ваше упоминание и ответ бота там; вход в веб-приложение, вход на famcal.bot через Telegram и платежи звёздами.' },
    { id: 'A5', doc: 'terms', path: 'service.blocks.4.2', kind: 'item', shifts: 'оплата тарифа.', text: 'вопрос из другого чата о том, когда вы свободны;' },
    { id: 'A6', doc: 'terms', path: 'service.blocks.5', kind: 'item', shifts: 'Аккаунт, созданный на famcal.bot', text: 'Когда вы упоминаете бота в другом чате Telegram, он отвечает в этом чате, и ответ видят все его участники: когда вы заняты и когда свободны в день, о котором вы спросили, по всем календарям, выбранным в FamCal. Названия ваших событий он не показывает никогда. Упоминайте его только там, где вы готовы показать это участникам чата.' },
    { id: 'A7', doc: 'terms', path: 'ai.blocks.1.0', kind: 'whole', text: 'понимать голосовые сообщения, фото, PDF и пересланные сообщения, а также день, о котором вы спрашиваете в другом чате;' },
  ],
};

/** The strings each 'whole' edit replaces, as the messages held them before (spec §9 "Current"), so none survives. */
export const ASK_LEGAL_REPLACED: Record<Locale, string[]> = {
  en: [
    'To understand what you send the bot: voice notes, photos, PDFs, forwarded messages and typed reminders.',
    'your voice notes, photos, PDFs, forwarded messages and typed reminders, so it can understand them;',
    '**Telegram:** every message between you and the bot, the web app’s sign-in, signing in to famcal.bot with Telegram, and Stars payments.',
    'understand voice notes, photos, PDFs and forwarded messages;',
  ],
  he: [
    'כדי להבין מה שולחים לבוט: הודעות קוליות, תמונות, קובצי PDF, הודעות מועברות ותזכורות שמקלידים.',
    'את ההודעות הקוליות, התמונות, קובצי ה־PDF, ההודעות המועברות והתזכורות שאתם מקלידים, כדי שיוכל להבין אותם;',
    '**טלגרם:** כל הודעה בינכם לבין הבוט, ההתחברות לאפליקציית הרשת, הכניסה ל־famcal.bot עם טלגרם, ותשלומים בכוכבים.',
    'להבין הודעות קוליות, תמונות, קובצי PDF והודעות מועברות;',
  ],
  ru: [
    'Чтобы понять, что вы присылаете боту: голосовые сообщения, фото, PDF, пересланные сообщения и напоминания, введённые текстом.',
    'ваши голосовые сообщения, фото, PDF, пересланные сообщения и напоминания, введённые текстом, — чтобы их понять;',
    '**Telegram:** все сообщения между вами и ботом, вход в веб-приложение, вход на famcal.bot через Telegram и платежи звёздами.',
    'понимать голосовые сообщения, фото, PDF и пересланные сообщения;',
  ],
};
