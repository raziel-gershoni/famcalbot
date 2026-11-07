// What the Privacy Policy and the Terms say about browser notifications (spec 2026-11-05-web-push §8, approved by the
// owner 2026-11-06): where each sentence goes in messages/<lang>.json and what it says. smoke-signin-legal L6 holds the
// messages to it. scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).
// T2 carries the trial-ended notice the B features added to that sentence (spec 2026-11-07-b-features §B1, approved 2026-11-07).
// P2 and T2 sit one place on since asking FamCal in another chat put an item and a paragraph before them (spec
// 2026-11-07-ask-in-chat §9, scripts/lib/legal-ask.ts).
//
// The texts are binding, owner-approved wording (CLAUDE.md): they change only on the owner's word, in all three languages
// at once, with a new LEGAL_UPDATED (src/site/legal.ts). Russian is written here with plain spaces; messages/ru.json
// binds a one-letter word and a dash with a no-break space (smoke-site-truth T6), so every comparison reads U+00A0 as a
// plain space (`plain`).

export type Locale = 'en' | 'he' | 'ru';
export type LegalDoc = 'privacy' | 'terms';

/** One edit: where it goes (`legal.<doc>.sections.<path>`, list items by position) and what the text there says after it. */
export type PushLegalOp = { id: string; doc: LegalDoc; path: string } & (
  /** A new list item at that position. `shifts` (only when it goes inside the list) starts the item that moves one place on. */
  | { kind: 'item'; text: string; shifts?: string }
  /** The string there is exactly this. */
  | { kind: 'whole'; text: string }
  /** This sentence ends the string there. */
  | { kind: 'append'; text: string }
  /** This sentence stands in the string there, just before `before`. */
  | { kind: 'insert'; before: string; text: string }
  /** The string there holds `to` where it held `from`. */
  | { kind: 'swap'; from: string; to: string }
);

/** A string with its no-break spaces read as plain spaces (the same length, so a position in one is a position in the other). */
export const plain = (s: string): string => s.replace(/ /g, ' ');

/** The node at a dotted path (list positions are numbers) under a value. */
export function nodeAt(root: unknown, dotted: string): unknown {
  let node = root;
  for (const key of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Why the messages don't say what the op approves, or null when they do. `sections` is `messages.legal[op.doc].sections`. */
export function problem(op: PushLegalOp, sections: unknown): string | null {
  const node = nodeAt(sections, op.path);
  if (typeof node !== 'string') return `${op.id} ${op.path}: ${node === undefined ? 'nothing there' : 'not a string'}`;
  const text = plain(node);
  switch (op.kind) {
    case 'whole':
    case 'item': {
      if (text !== op.text) return `${op.id} ${op.path}: says "${text.slice(0, 90)}"`;
      if (op.kind === 'item' && op.shifts) {
        const next = nodeAt(sections, op.path.replace(/\d+$/, (n) => String(Number(n) + 1)));
        if (typeof next !== 'string' || !plain(next).startsWith(op.shifts)) return `${op.id} ${op.path}: the item after it is not the one that starts "${op.shifts}"`;
      }
      return null;
    }
    case 'append':
      return text.endsWith(` ${op.text}`) ? null : `${op.id} ${op.path}: does not end with "${op.text.slice(0, 60)}…"`;
    case 'insert':
      return text.includes(`${op.text} ${op.before}`) ? null : `${op.id} ${op.path}: lacks "${op.text.slice(0, 60)}…" before "${op.before}"`;
    case 'swap':
      return text.includes(op.to) && !text.includes(op.from) ? null : `${op.id} ${op.path}: lacks "${op.to.slice(0, 60)}…" or still says "${op.from.slice(0, 60)}…"`;
  }
}

/**
 * The twenty edits in each language, in the spec's order: the Privacy Policy's P1-P15, then the Terms' T1-T5. P12 is the only
 * item that goes inside a list (the ban item moves one place on, and the payment record after it); every other new item ends
 * its list.
 */
export const PUSH_LEGAL: Record<Locale, PushLegalOp[]> = {
  en: [
    { id: 'P1', doc: 'privacy', path: 'keep.blocks.1.6', kind: 'item', text: 'If you turn on notifications in a browser: for each phone or computer, the address its push service gave that browser for FamCal’s notifications, two keys that encrypt them so only that browser can read them, and when you turned them on there.' },
    { id: 'P2', doc: 'privacy', path: 'notKeep.blocks.0.6', kind: 'item', text: '**Notifications in your browser.** We write each one when we send it, and don’t store it. It stays on your device until it’s cleared there, and your device’s settings decide whether it shows on the lock screen.' },
    { id: 'P3', doc: 'privacy', path: 'use.blocks.0.0', kind: 'whole', text: 'To run the features you use: your calendar, reminders, briefings and the voice show, notifications in your browser, weather, Hebrew dates and zmanim, the Shabbat and Yom Tov pause, sharing with your partner, and your Google connection.' },
    { id: 'P4', doc: 'privacy', path: 'google.blocks.1.0.items.2', kind: 'whole', text: 'send event alerts on Telegram or in your browser;' },
    { id: 'P5', doc: 'privacy', path: 'google.blocks.1.3', kind: 'append', text: 'If you turn on notifications in your browser, an event’s title, time and place can be in a notification, encrypted on its way so that only your browser can read it, not the push service that carries it.' },
    { id: 'P6', doc: 'privacy', path: 'processors.blocks.1.14', kind: 'item', text: '**Your browser’s push service,** if you turn on notifications: the push service your browser uses (its maker picks it, for example Apple’s, Google’s, Mozilla’s or Microsoft’s) delivers FamCal’s notifications to your browser. For each notification, it gets your browser’s notification address, our server’s IP address, and the notification’s time, size and delivery settings, such as how long it may wait. The content is encrypted for your browser, so the push service can’t read it. Which service it is depends on your browser, and it runs under its operator’s own privacy policy.' },
    { id: 'P7', doc: 'privacy', path: 'processors.blocks.3.3', kind: 'whole', text: 'Telegram, Meta and Google run their own apps under their own privacy policies, and the push service your browser uses runs under its operator’s own.' },
    { id: 'P8', doc: 'privacy', path: 'cookies.blocks.1', kind: 'whole', text: 'The web app also saves a few view choices in your browser, such as which tab you were on. If you turn notifications on, it also installs a small FamCal program in your browser (a service worker): it only shows FamCal’s notifications and opens the app when you tap one, and it saves no pages. Your browser then keeps the subscription its push service made for FamCal. All of these are needed for the site and the app to work. We use no ad or tracking cookies.' },
    { id: 'P9', doc: 'privacy', path: 'retention.blocks.0.9', kind: 'item', text: '**Notifications in your browser:** each device until you turn them off or sign out there; until you sign out on all devices, or remove a way to sign in (the device you remove it on stays); until your account gets a chat (Telegram or WhatsApp), is suspended or banned, or is deleted. If the browser or its push service ends them, we delete the device at the next notification. We keep up to 10 devices: turning on an 11th removes the oldest. A notification waiting at a push service for a device that’s off is dropped there within a day.' },
    { id: 'P10', doc: 'privacy', path: 'rights.blocks.5.1', kind: 'insert', before: 'You can also ask us to stop them', text: 'To stop notifications in a browser, turn them off in Settings in that browser, or block FamCal’s notifications in your browser’s or device’s settings.' },
    { id: 'P11', doc: 'privacy', path: 'rights.blocks.7.0', kind: 'swap', from: 'your plan, your activity log', to: 'your plan, the list of devices you get notifications on, your activity log' },
    { id: 'P12', doc: 'privacy', path: 'rights.blocks.9.5', kind: 'item', shifts: 'if we banned the account', text: 'a notification still waiting at a push service for a device that’s off, until it’s delivered or dropped (within a day);' },
    { id: 'P13', doc: 'privacy', path: 'euUk.blocks.2.0', kind: 'whole', text: 'To run FamCal for you (your account and its sign-in methods, calendar, settings, Google connection, partner sharing, briefings, notifications in your browser, and reading what you send the bot): our agreement with you.' },
    { id: 'P14', doc: 'privacy', path: 'security.blocks.0.5', kind: 'item', text: 'Each notification to a browser is encrypted for that browser alone, so the push service that carries it can’t read it.' },
    { id: 'P15', doc: 'privacy', path: 'euUk.blocks.4', kind: 'append', text: 'A notification reaches your browser’s push service, wherever it is, because you turned notifications on, so that it can be delivered to you.' },
    { id: 'T1', doc: 'terms', path: 'service.blocks.4.0', kind: 'whole', text: 'reminders and event alerts (an account made on famcal.bot can get them as notifications in the browser until it connects Telegram);' },
    { id: 'T2', doc: 'terms', path: 'service.blocks.6', kind: 'swap', from: 'Briefings and reminders reach you once you connect Telegram in Settings.', to: 'Reminders, event alerts, a short notification that lists the day’s events and a notice when your trial ends reach you on each phone or computer where you turn notifications on (on iPhone and iPad, after you add FamCal to the Home Screen). Once you connect Telegram, they come in Telegram instead, and the notifications stop.' },
    { id: 'T3', doc: 'terms', path: 'delivery.blocks.0', kind: 'whole', text: 'A reminder or a briefing can arrive late, or not at all, for example when Telegram, WhatsApp, your browser’s push service or one of our providers has a problem, or when your device is off or blocks notifications. A notification waiting for a device that’s off is dropped after a while (within a day) and isn’t sent again.' },
    { id: 'T4', doc: 'terms', path: 'account.blocks.0.5', kind: 'item', text: 'Notifications show your reminders’ and events’ titles, times and places on each device where you turn them on and, depending on its settings, on its lock screen. Anyone who can see that device can read them, so turn them off on a device others use.' },
    { id: 'T5', doc: 'terms', path: 'liability.blocks.3', kind: 'whole', text: 'Telegram, WhatsApp, Google, your browser’s push service and our providers run their own services under their own terms, and we aren’t responsible for them.' },
  ],
  he: [
    { id: 'P1', doc: 'privacy', path: 'keep.blocks.1.6', kind: 'item', text: 'אם מפעילים התראות בדפדפן: לכל טלפון או מחשב, הכתובת ששירות ההתראות (push) של הדפדפן נתן לדפדפן הזה בשביל ההתראות של FamCal, שני מפתחות שמצפינים את ההתראות כך שרק הדפדפן הזה יכול לקרוא אותן, ומתי הפעלתם שם את ההתראות.' },
    { id: 'P2', doc: 'privacy', path: 'notKeep.blocks.0.6', kind: 'item', text: '**התראות בדפדפן.** אנחנו מנסחים כל התראה ברגע השליחה, ולא שומרים אותה. היא נשארת במכשיר שלכם עד שהיא נמחקת ממנו, וההגדרות של המכשיר קובעות אם היא תוצג גם במסך הנעילה.' },
    { id: 'P3', doc: 'privacy', path: 'use.blocks.0.0', kind: 'whole', text: 'כדי להפעיל את התכונות שבהן אתם משתמשים: היומן, התזכורות, הסיכומים והתוכנית הקולית, ההתראות בדפדפן, מזג האוויר, התאריכים העבריים וזמני היום, ההשהיה בשבת ובחג, השיתוף עם בן או בת הזוג, והחיבור ל־Google.' },
    { id: 'P4', doc: 'privacy', path: 'google.blocks.1.0.items.2', kind: 'whole', text: 'לשלוח התראות לפני אירועים בטלגרם או בדפדפן;' },
    { id: 'P5', doc: 'privacy', path: 'google.blocks.1.3', kind: 'append', text: 'אם מפעילים התראות בדפדפן, הכותרת, השעה והמקום של אירוע יכולים להופיע בהתראה. ההתראה מוצפנת בדרך, כך שרק הדפדפן שלכם יכול לקרוא אותה, ולא שירות ההתראות שמעביר אותה.' },
    { id: 'P6', doc: 'privacy', path: 'processors.blocks.1.14', kind: 'item', text: '**שירות ההתראות (push) של הדפדפן שלכם,** אם מפעילים התראות: את ההתראות של FamCal מעביר לדפדפן שלכם שירות ההתראות שהדפדפן משתמש בו, לפי בחירת החברה שיצרה אותו (למשל השירות של Apple, של Google, של Mozilla או של Microsoft). על כל התראה, השירות מקבל את כתובת ההתראות של הדפדפן שלכם, את כתובת ה־IP של השרת שלנו, ואת השעה, הגודל והגדרות המסירה של ההתראה, כמו כמה זמן היא יכולה לחכות. התוכן מוצפן בשביל הדפדפן שלכם, ולכן שירות ההתראות לא יכול לקרוא אותו. איזה שירות זה תלוי בדפדפן שלכם, והוא פועל לפי מדיניות הפרטיות של החברה שמפעילה אותו.' },
    { id: 'P7', doc: 'privacy', path: 'processors.blocks.3.3', kind: 'whole', text: 'טלגרם, Meta ו־Google מפעילות את האפליקציות שלהן לפי מדיניות הפרטיות שלהן, וגם שירות ההתראות שהדפדפן שלכם משתמש בו פועל לפי מדיניות הפרטיות של החברה שמפעילה אותו.' },
    { id: 'P8', doc: 'privacy', path: 'cookies.blocks.1', kind: 'whole', text: 'אפליקציית הרשת שומרת בדפדפן שלכם גם כמה העדפות תצוגה, כמו הלשונית שבה הייתם. אם מפעילים התראות, היא מתקינה בדפדפן גם תוכנה קטנה של FamCal (service worker), שרק מציגה את ההתראות של FamCal ופותחת את האפליקציה כשמקישים על אחת מהן, ולא שומרת דפים. הדפדפן שומר אז גם את המינוי ששירות ההתראות שלו יצר בשביל FamCal. כל אלה נחוצים כדי שהאתר והאפליקציה יעבדו. אנחנו לא משתמשים בעוגיות פרסום או מעקב.' },
    { id: 'P9', doc: 'privacy', path: 'retention.blocks.0.9', kind: 'item', text: '**התראות בדפדפן:** כל מכשיר נשמר עד שמכבים בו את ההתראות או יוצאים בו מהחשבון; עד שיוצאים מהחשבון בכל המכשירים, או מסירים דרך כניסה (המכשיר שבו מסירים אותה נשאר); עד שמחברים לחשבון צ׳אט (טלגרם או וואטסאפ), עד שהחשבון מושעה או נחסם, או עד שהוא נמחק. אם הדפדפן או שירות ההתראות שלו מבטלים את ההתראות, אנחנו מוחקים את המכשיר בהתראה הבאה. אנחנו שומרים עד 10 מכשירים: הפעלה במכשיר ה־11 מוחקת את הוותיק שבהם. התראה שמחכה בשירות ההתראות למכשיר כבוי נמחקת שם תוך יום לכל היותר.' },
    { id: 'P10', doc: 'privacy', path: 'rights.blocks.5.1', kind: 'insert', before: 'אפשר גם לבקש מאיתנו להפסיק לשלוח אותן', text: 'כדי להפסיק התראות בדפדפן, מכבים אותן בהגדרות באותו דפדפן, או חוסמים את ההתראות של FamCal בהגדרות של הדפדפן או של המכשיר.' },
    { id: 'P11', doc: 'privacy', path: 'rights.blocks.7.0', kind: 'swap', from: 'את המסלול, את רישום הפעילות', to: 'את המסלול, את רשימת המכשירים שבהם הופעלו התראות, את רישום הפעילות' },
    { id: 'P12', doc: 'privacy', path: 'rights.blocks.9.5', kind: 'item', shifts: 'אם חסמנו את החשבון', text: 'התראה שעדיין מחכה בשירות ההתראות למכשיר כבוי, עד שהיא נמסרת או נמחקת (תוך יום לכל היותר);' },
    { id: 'P13', doc: 'privacy', path: 'euUk.blocks.2.0', kind: 'whole', text: 'להפעלת FamCal בשבילכם (החשבון ודרכי הכניסה אליו, היומן, ההגדרות, החיבור ל־Google, השיתוף עם בן או בת הזוג, הסיכומים, ההתראות בדפדפן, וקריאת מה ששולחים לבוט): ההסכם שלנו איתכם.' },
    { id: 'P14', doc: 'privacy', path: 'security.blocks.0.5', kind: 'item', text: 'כל התראה לדפדפן מוצפנת בשביל הדפדפן הזה בלבד, כך ששירות ההתראות שמעביר אותה לא יכול לקרוא אותה.' },
    { id: 'P15', doc: 'privacy', path: 'euUk.blocks.4', kind: 'append', text: 'התראה מגיעה לשירות ההתראות של הדפדפן שלכם, בכל מדינה שבה הוא נמצא, כי הפעלתם התראות, וכדי שתגיע אליכם.' },
    { id: 'T1', doc: 'terms', path: 'service.blocks.4.0', kind: 'whole', text: 'תזכורות והתראות לפני אירועים (חשבון שנפתח ב־famcal.bot יכול לקבל אותן כהתראות בדפדפן, עד שמחברים אליו את טלגרם);' },
    { id: 'T2', doc: 'terms', path: 'service.blocks.6', kind: 'swap', from: 'סיכומים ותזכורות מגיעים אליכם אחרי שמחברים את טלגרם בהגדרות.', to: 'תזכורות, התראות לפני אירועים, התראה קצרה עם רשימת האירועים של היום והודעה כשתקופת הניסיון נגמרת מגיעות אליכם בכל טלפון או מחשב שבו מפעילים התראות (באייפון ובאייפד, אחרי שמוסיפים את FamCal למסך הבית). אחרי שמחברים את טלגרם, הן מגיעות בטלגרם, וההתראות בדפדפן נפסקות.' },
    { id: 'T3', doc: 'terms', path: 'delivery.blocks.0', kind: 'whole', text: 'תזכורת או סיכום יכולים להגיע באיחור, או לא להגיע בכלל, למשל כשיש תקלה בטלגרם, בוואטסאפ, בשירות ההתראות של הדפדפן או אצל אחד הספקים שלנו, או כשהמכשיר כבוי או חוסם התראות. התראה שמחכה למכשיר כבוי נמחקת אחרי זמן מה (תוך יום לכל היותר), ולא נשלחת שוב.' },
    { id: 'T4', doc: 'terms', path: 'account.blocks.0.5', kind: 'item', text: 'התראות מציגות את הכותרות, השעות והמקומות של התזכורות והאירועים שלכם בכל מכשיר שבו הפעלתם אותן, ולפי ההגדרות של המכשיר גם במסך הנעילה. כל מי שרואה את המכשיר יכול לקרוא אותן, ולכן כדאי לכבות אותן במכשיר שגם אחרים משתמשים בו.' },
    { id: 'T5', doc: 'terms', path: 'liability.blocks.3', kind: 'whole', text: 'טלגרם, וואטסאפ, Google, שירות ההתראות של הדפדפן שלכם והספקים שלנו מפעילים את השירותים שלהם לפי התנאים שלהם, ואנחנו לא אחראים להם.' },
  ],
  ru: [
    { id: 'P1', doc: 'privacy', path: 'keep.blocks.1.6', kind: 'item', text: 'Если вы включили уведомления в браузере: для каждого телефона или компьютера — адрес, который служба push-уведомлений выдала этому браузеру для FamCal, два ключа, которыми уведомления шифруются так, что прочитать их может только этот браузер, и когда вы включили там уведомления.' },
    { id: 'P2', doc: 'privacy', path: 'notKeep.blocks.0.6', kind: 'item', text: '**Уведомления в браузере.** Мы составляем каждое уведомление в момент отправки и не храним его. Оно остаётся на вашем устройстве, пока его оттуда не уберут. Показывать ли его на экране блокировки, решают настройки устройства.' },
    { id: 'P3', doc: 'privacy', path: 'use.blocks.0.0', kind: 'whole', text: 'Чтобы работали функции, которыми вы пользуетесь: календарь, напоминания, сводки и радиошоу, уведомления в браузере, погода, еврейские даты и зманим, пауза в Шаббат и праздники, общий доступ для партнёра и подключение Google.' },
    { id: 'P4', doc: 'privacy', path: 'google.blocks.1.0.items.2', kind: 'whole', text: 'присылать уведомления о событиях в Telegram или в браузере;' },
    { id: 'P5', doc: 'privacy', path: 'google.blocks.1.3', kind: 'append', text: 'Если вы включили уведомления в браузере, название, время и место события могут оказаться в уведомлении. Оно передаётся в зашифрованном виде: прочитать его может только ваш браузер, а не служба push-уведомлений, которая его доставляет.' },
    { id: 'P6', doc: 'privacy', path: 'processors.blocks.1.14', kind: 'item', text: '**Служба push-уведомлений вашего браузера,** если вы включили уведомления: уведомления FamCal доставляет в ваш браузер служба, которую выбрал его разработчик (например, служба Apple, Google, Mozilla или Microsoft). О каждом уведомлении она получает адрес уведомлений вашего браузера, IP-адрес нашего сервера, время отправки, размер и параметры доставки, например сколько уведомление может ждать. Содержание зашифровано для вашего браузера, поэтому служба не может его прочитать. Какая это служба, зависит от вашего браузера; она работает по политике конфиденциальности компании, которая ею управляет.' },
    { id: 'P7', doc: 'privacy', path: 'processors.blocks.3.3', kind: 'whole', text: 'Telegram, Meta и Google управляют собственными приложениями по своим политикам конфиденциальности, а служба push-уведомлений, которой пользуется ваш браузер, работает по политике конфиденциальности компании, которая ею управляет.' },
    { id: 'P8', doc: 'privacy', path: 'cookies.blocks.1', kind: 'whole', text: 'Веб-приложение также сохраняет в вашем браузере несколько настроек вида, например какая вкладка была открыта. Если вы включили уведомления, оно также устанавливает в браузер небольшую программу FamCal (service worker): она только показывает уведомления FamCal и открывает приложение, когда вы нажимаете на уведомление, и не сохраняет страниц. Тогда браузер также хранит подписку, которую его служба push-уведомлений создала для FamCal. Всё это нужно для работы сайта и приложения. Рекламных и отслеживающих cookie мы не используем.' },
    { id: 'P9', doc: 'privacy', path: 'retention.blocks.0.9', kind: 'item', text: '**Уведомления в браузере:** каждое устройство — пока вы не выключите на нём уведомления или не выйдете на нём из аккаунта; пока вы не выйдете из аккаунта на всех устройствах или не удалите способ входа (устройство, на котором вы его удаляете, остаётся); пока вы не подключите к аккаунту чат (Telegram или WhatsApp), пока аккаунт не будет приостановлен или заблокирован или пока он не будет удалён. Если браузер или его служба push-уведомлений отменит уведомления, мы удалим устройство при следующем уведомлении. Мы храним не больше 10 устройств: при включении на 11-м самое старое удаляется. Уведомление, которое ждёт выключенное устройство в службе push-уведомлений, удаляется там не позже чем через сутки.' },
    { id: 'P10', doc: 'privacy', path: 'rights.blocks.5.1', kind: 'insert', before: 'Можно также попросить нас прекратить их отправку', text: 'Чтобы прекратить уведомления в браузере, выключите их в «Настройках» в этом браузере или запретите уведомления FamCal в настройках браузера или устройства.' },
    { id: 'P11', doc: 'privacy', path: 'rights.blocks.7.0', kind: 'swap', from: 'ваш тариф, журнал действий', to: 'ваш тариф, список устройств, на которые приходят уведомления, журнал действий' },
    { id: 'P12', doc: 'privacy', path: 'rights.blocks.9.5', kind: 'item', shifts: 'если мы заблокировали аккаунт', text: 'уведомление, которое ещё ждёт выключенное устройство в службе push-уведомлений, — пока его не доставят или не удалят (не позже чем через сутки);' },
    { id: 'P13', doc: 'privacy', path: 'euUk.blocks.2.0', kind: 'whole', text: 'Чтобы FamCal работал для вас (ваш аккаунт и способы входа в него, календарь, настройки, подключение Google, общий доступ для партнёра, сводки, уведомления в браузере и распознавание того, что вы присылаете боту): наш договор с вами.' },
    { id: 'P14', doc: 'privacy', path: 'security.blocks.0.5', kind: 'item', text: 'Каждое уведомление в браузер шифруется только для этого браузера, поэтому служба push-уведомлений, которая его доставляет, не может его прочитать.' },
    { id: 'P15', doc: 'privacy', path: 'euUk.blocks.4', kind: 'append', text: 'Уведомление попадает в службу push-уведомлений вашего браузера, в какой бы стране она ни находилась, потому что вы включили уведомления, — чтобы его можно было вам доставить.' },
    { id: 'T1', doc: 'terms', path: 'service.blocks.4.0', kind: 'whole', text: 'напоминания и уведомления о событиях (аккаунт, созданный на famcal.bot, может получать их в браузере, пока к нему не подключён Telegram);' },
    { id: 'T2', doc: 'terms', path: 'service.blocks.6', kind: 'swap', from: 'Сводки и напоминания начнут приходить, когда вы подключите Telegram в «Настройках».', to: 'Напоминания, уведомления о событиях, краткое уведомление со списком событий дня и сообщение об окончании пробного периода приходят на каждый телефон или компьютер, где вы включили уведомления (на iPhone и iPad — после того как вы добавите FamCal на экран «Домой»). Когда вы подключите Telegram, они начнут приходить в Telegram, а уведомления в браузере прекратятся.' },
    { id: 'T3', doc: 'terms', path: 'delivery.blocks.0', kind: 'whole', text: 'Напоминание или сводка могут прийти с опозданием или не прийти вовсе, например если у Telegram, WhatsApp, службы push-уведомлений вашего браузера или одного из наших поставщиков возникла проблема, а также если ваше устройство выключено или уведомления на нём запрещены. Уведомление, которое ждёт выключенное устройство, через некоторое время (не позже чем через сутки) удаляется и повторно не отправляется.' },
    { id: 'T4', doc: 'terms', path: 'account.blocks.0.5', kind: 'item', text: 'Уведомления показывают названия, время и место ваших напоминаний и событий на каждом устройстве, где вы их включили, а в зависимости от его настроек — и на экране блокировки. Их может прочитать любой, кто видит это устройство, поэтому на устройстве, которым пользуются и другие, их лучше выключить.' },
    { id: 'T5', doc: 'terms', path: 'liability.blocks.3', kind: 'whole', text: 'Telegram, WhatsApp, Google, служба push-уведомлений вашего браузера и наши поставщики управляют своими сервисами на собственных условиях, и мы за них не отвечаем.' },
  ],
};
