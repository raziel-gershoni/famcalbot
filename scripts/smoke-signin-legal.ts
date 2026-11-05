// Smoke test for web sign-in's changes to the Privacy Policy and the Terms (spec 2026-11-02-web-sign-in §7; plan
// Task 11a). The texts are binding, owner-approved wording (CLAUDE.md): they change in all three languages at once,
// with a new LEGAL_UPDATED.
//
//  - L1 the Privacy Policy and the Terms hold the same legal.* leaves in en, he and ru: every key and every list
//    position, so no language has a line the others lack (the i18n parity check counts an array as one key).
//  - L2 each language says what spec §7 adds, in the approved wording: who we are (the web app after signing in on the
//    site), what we keep to sign a person in (the Google account id and address, the email address, when each was
//    added and last used, the calendar account's scrambled address), the sign-in counters, Google sign-in in "Google
//    user data", Telegram's line, Google and Resend among the providers, Resend among those bound by their terms and in
//    the US transfers line, the cookies (`__Host-famcal_session` 30 days on famcal.bot and 24 hours from a WhatsApp
//    link, `famcal_signin` 10 minutes), how long sign-in data is kept, the session cookie check, removing a way and
//    deleting the ways with the account; the Terms' account security names the Google account and the mailbox. The
//    old WhatsApp-only cookie line and "keep that account safe" are gone. The owner's approval of lawyer findings 2, 3b, 7,
//    8 and 9 (2026-11-02) is pinned too: when the primary calendar id is read (at connect or Turn on, and at sign-in), the
//    chat notice among the uses, the legal grounds naming the sign-in methods and counters, what stays after deletion
//    (the counters, Resend's copies), and Telegram's and Google's sign-in pages seeing the IP address.
//  - L3 LEGAL_UPDATED moved to the day each text last changed (the Privacy Policy's follow-up wording, 2026-11-05, and
//    the Terms' web sign-up, 2026-11-04, or later), and is not a day that has not come yet in Israel.
//  - L5 each language says what web sign-up (spec 2026-11-03-web-sign-up §7, approved by the owner 2026-11-04) adds:
//    an account made on famcal.bot with Google or an email address and used only in the browser, the one way to sign in
//    an account needs, the name kept, the sign-up's 10 minutes and the connect link's, the new accounts counted, the
//    age confirmed at sign-up, the no-chat notice by email, Cloudflare's Turnstile (what it reads, the script it loads,
//    its signals for Cloudflare's own detection), the FamCal id on feedback, a confirmation from the sign-in address, the
//    last way kept, the ban's four identifiers; the Terms' browser account, its eligibility, a lost last way, paying
//    after connecting Telegram, a suspension's sign-in, and blocking the bot only if you use it. The sentences they
//    replace are gone.
//  - L4 the cookies the Policy names are the code's, with the code's lengths: SESSION_COOKIE_NAME and SESSION_TTL_SEC
//    (src/lib/session-auth.ts: 30 days on famcal.bot, 24 hours from a WhatsApp link), SIGNIN_COOKIE_NAME and
//    FLOW_TTL_SEC (src/services/web-signin/flow.ts: 10 minutes), read as text, in every language.
//
// Real: the messages and src/site/legal.ts; session-auth.ts and flow.ts are read as text. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/6b/run-smoke.sh smoke-signin-legal

import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Locale = 'en' | 'he' | 'ru';
type Doc = 'privacy' | 'terms';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`))])) as Record<Locale, Row>;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

/** Every string under a node, with its path (keys and list positions). */
function leaves(node: unknown, at: string): [string, string][] {
  if (typeof node === 'string') return [[at, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Row).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
}
/** A legal page's whole text in one language, Russian's no-break spaces read as plain ones (smoke-site-truth T6). */
const text = (locale: Locale, doc: Doc) => leaves(messages[locale].legal[doc], doc).map(([, s]) => s).join(' ').replace(/ /g, ' ');

/** What each language must say now (spec §7), page by page. */
const SAYS: Record<Locale, [Doc, string][]> = {
  en: [
    ['privacy', 'through a web app that opens from the bot or when you sign in on our website'],
    ['privacy', 'if you create your account with Google, add Google sign-in, or sign in with the Google account your calendar is connected from: your Google account id and its email address;'],
    ['privacy', 'if you create your account with an email address, or add email sign-in: that email address;'],
    ['privacy', 'for each, when you added it and last used it;'],
    ['privacy', 'if you connected Google Calendar: a scrambled form of that Google account’s address, so we can recognise it when you sign in with it.'],
    ['privacy', 'We use them only to sign you in, to send you sign-in codes, to tell you when a way to sign in is added (in your chat, or by email if your account has no chat) and, if we ban the account, to stop it signing up again.'],
    ['privacy', 'To stop misuse of sign-in, we also count sign-in attempts and new accounts in Upstash per IP address, per email address and, when you add an email, per account, under scrambled keys, for up to a day.'],
    ['privacy', '**Signing in.** If you sign in with Google, FamCal asks Google only for your account id and email address.'],
    ['privacy', 'we read your primary calendar’s id (its address) with the calendar permission you gave: when you connect Google Calendar, or turn this on in Settings, to keep its scrambled form, and when you sign in, to check it is the same account.'],
    ['privacy', 'To run FamCal for you (your account and its sign-in methods, calendar, settings,'],
    ['privacy', 'the activity log, the sign-in counters, the bot check on the email-code form (Turnstile), and the record of banned accounts): our legitimate interest'],
    ['privacy', 'cache copies, until they expire (up to 30 days);'],
    ['privacy', 'sign-in counters, until they expire (up to a day), and copies of sign-in emails at Resend (up to 30 days);'],
    ['privacy', 'When you sign in with Telegram or Google, your browser opens that service’s sign-in page. Like any site you visit, Telegram and Google see your IP address and browser.'],
    ['privacy', 'We use these only to sign you in, to email you when a way to sign in is added if your account has no chat, and, if we ban the account, to stop it signing up again. We never share them with anyone else, and delete them when you remove Google sign-in, disconnect Google Calendar (the scrambled address) or delete your account, except what a ban keeps (see “What stays after that”).'],
    ['privacy', 'What we keep to sign you in with Google is under “Your account”, and “Signing in” above says when we delete it.'],
    ['privacy', 'the web app’s sign-in, signing in to famcal.bot with Telegram, and Stars payments.'],
    ['privacy', '**Google,** if you sign in or create your account with Google: your Google account id and email address, to sign you in.'],
    ['privacy', '**Resend:** your email address and the sign-in code or notice we email you. Resend keeps a copy of each email for up to 30 days.'],
    ['privacy', 'Railway, Sentry, Cloudflare (except Turnstile’s signals, below) and Resend handle data for us.'],
    ['privacy', 'such as the US, where Resend keeps the data of the sign-in emails, we rely'],
    ['privacy', '`__Host-famcal_session` keeps you signed in to the web app:'],
    ['privacy', 'after you sign in on famcal.bot with Telegram, Google or an email code, it lasts about 30 days from your last visit to the web app;'],
    ['privacy', 'after you open the web app from a WhatsApp link, it lasts 24 hours.'],
    ['privacy', 'While you sign in or create an account, `famcal_signin` holds a one-time check for 10 minutes.'],
    ['privacy', '**Sign-in methods:** until you remove them or your account is deleted.'],
    ['privacy', '**Sign-in codes:** 10 minutes, with the address they were sent to.'],
    ['privacy', '**Sign-in counters:** up to a day.'],
    ['privacy', 'On famcal.bot it checks the session cookie set when you signed in.'],
    ['privacy', 'remove a sign-in method in Settings, under “Sign in on the web”, except your only one;'],
    ['privacy', '(deleted ones too), your sign-in methods, your plan,'],
    ['terms', 'Anyone who can use your Telegram or WhatsApp account, the Google account your calendar is connected from, or a Google account or mailbox you created your account with or added for signing in, can use FamCal as you. Keep those accounts safe.'],
  ],
  he: [
    ['privacy', 'דרך אפליקציית רשת שנפתחת מתוך הבוט או אחרי כניסה באתר שלנו'],
    ['privacy', 'אם פתחתם את החשבון עם Google, הוספתם כניסה עם Google, או נכנסתם עם חשבון ה־Google שהיומן שלכם מחובר ממנו: המזהה של חשבון ה־Google שלכם וכתובת המייל שלו;'],
    ['privacy', 'אם פתחתם את החשבון עם כתובת מייל, או הוספתם כניסה עם מייל: כתובת המייל הזו;'],
    ['privacy', 'לכל אחת מדרכי הכניסה: מתי הוספתם אותה ומתי השתמשתם בה לאחרונה;'],
    ['privacy', 'אם חיברתם את יומן Google: הכתובת של חשבון ה־Google הזה בצורה מעורבלת (hash), כדי שנזהה אותו כשתיכנסו איתו.'],
    ['privacy', 'אנחנו משתמשים בהם רק כדי להכניס אתכם, לשלוח לכם קודי כניסה, להודיע לכם כשנוספת דרך כניסה (בצ׳אט, או במייל אם לחשבון שלכם אין צ׳אט), ואם חסמנו את החשבון, כדי שלא יוכל להירשם שוב.'],
    ['privacy', 'כדי למנוע שימוש לרעה בכניסה, אנחנו גם סופרים ב־Upstash את ניסיונות הכניסה ואת החשבונות החדשים מכל כתובת IP, לכל כתובת מייל ולכל חשבון (כשמוסיפים כתובת מייל), למשך יום לכל היותר, והמזהים נשמרים שם רק בצורה מעורבלת (hash).'],
    ['privacy', '**כניסה.** אם נכנסים עם Google, FamCal מבקש מ־Google רק את המזהה של החשבון שלכם ואת כתובת המייל שלו.'],
    ['privacy', 'אנחנו קוראים את המזהה של היומן הראשי שלכם (הכתובת שלו) בעזרת ההרשאה ליומן שנתתם: כשמחברים את יומן Google, או מפעילים את זה בהגדרות, כדי לשמור אותו בצורה מעורבלת, וכשנכנסים, כדי לוודא שזה אותו חשבון.'],
    ['privacy', 'להפעלת FamCal בשבילכם (החשבון ודרכי הכניסה אליו, היומן, ההגדרות,'],
    ['privacy', 'רישום הפעילות, ספירת ניסיונות הכניסה והחשבונות החדשים, בדיקת הבוטים בטופס הקוד במייל (Turnstile), ורשימת החשבונות החסומים): האינטרס הלגיטימי שלנו'],
    ['privacy', 'עותקים בזיכרון המטמון, עד שתוקפם פג (עד 30 יום);'],
    ['privacy', 'ספירת ניסיונות הכניסה והחשבונות החדשים, עד שתוקפה פג (יום לכל היותר), והעותקים של מיילי הכניסה אצל Resend (עד 30 יום);'],
    ['privacy', 'כשנכנסים עם טלגרם או עם Google, הדפדפן שלכם פותח את דף הכניסה שלהם. כמו כל אתר שנכנסים אליו, טלגרם ו־Google רואות את כתובת ה־IP ואת הדפדפן שלכם.'],
    ['privacy', 'אנחנו משתמשים במידע הזה רק כדי להכניס אתכם, אם לחשבון שלכם אין צ׳אט גם כדי להודיע לכם במייל כשנוספת דרך כניסה, ואם חסמנו את החשבון, כדי שלא יוכל להירשם שוב. אנחנו לא מעבירים אותו לאף אחד אחר, ומוחקים אותו כשמסירים את הכניסה עם Google, כשמנתקים את יומן Google (את הכתובת המעורבלת) או כשמוחקים את החשבון, חוץ ממה שנשמר אחרי חסימה (ראו ״מה נשאר אחרי זה״).'],
    ['privacy', 'מה אנחנו שומרים כדי להכניס אתכם עם Google מפורט תחת ״החשבון שלכם״, ובסעיף ״כניסה״ למעלה מפורט מתי אנחנו מוחקים אותו.'],
    ['privacy', 'ההתחברות לאפליקציית הרשת, הכניסה ל־famcal.bot עם טלגרם, ותשלומים בכוכבים.'],
    ['privacy', '**Google,** אם נכנסים או פותחים חשבון עם Google: המזהה של חשבון ה־Google שלכם וכתובת המייל שלו, כדי להכניס אתכם.'],
    ['privacy', '**Resend:** כתובת המייל שלכם וקוד הכניסה או ההודעה שאנחנו שולחים לכם במייל. Resend שומרת עותק של כל מייל עד 30 יום.'],
    ['privacy', 'Railway, Sentry, Cloudflare (חוץ מהנתונים ש־Turnstile אוסף, ראו בהמשך) ו־Resend מטפלים במידע בשבילנו.'],
    ['privacy', 'כמו ארצות הברית, שבה Resend שומרת את המידע של מיילי הכניסה, אנחנו מסתמכים'],
    ['privacy', '`__Host-famcal_session` שומרת על ההתחברות שלכם לאפליקציית הרשת:'],
    ['privacy', 'אחרי כניסה ב־famcal.bot עם טלגרם, עם Google או עם קוד במייל, היא תקפה כ־30 יום מהביקור האחרון שלכם באפליקציית הרשת;'],
    ['privacy', 'אחרי שפותחים את אפליקציית הרשת מקישור בוואטסאפ, היא תקפה 24 שעות.'],
    ['privacy', 'בזמן הכניסה או פתיחת החשבון, `famcal_signin` שומרת בדיקה חד־פעמית למשך 10 דקות.'],
    ['privacy', '**דרכי הכניסה:** עד שמסירים אותן או עד שהחשבון נמחק.'],
    ['privacy', '**קודי כניסה:** 10 דקות, יחד עם הכתובת שאליה נשלחו.'],
    ['privacy', '**ספירת ניסיונות הכניסה והחשבונות החדשים:** יום לכל היותר.'],
    ['privacy', 'ב־famcal.bot היא בודקת את עוגיית ההתחברות שנשמרה כשנכנסתם.'],
    ['privacy', 'להסיר דרך כניסה בהגדרות, תחת ״כניסה מהדפדפן״, אלא אם זו דרך הכניסה היחידה שלכם;'],
    ['privacy', '(גם אירועים שנמחקו), את דרכי הכניסה, את המסלול,'],
    ['terms', 'כל מי שיכול להשתמש בחשבון הטלגרם או הוואטסאפ שלכם, בחשבון ה־Google שהיומן שלכם מחובר ממנו, או בחשבון Google או בתיבת מייל שאיתם פתחתם את החשבון או שהוספתם לכניסה, יכול להשתמש ב־FamCal בשמכם. שמרו היטב על החשבונות האלה.'],
  ],
  ru: [
    ['privacy', 'через веб-приложение, которое открывается из бота или после входа на нашем сайте'],
    ['privacy', 'если вы создали аккаунт через Google, добавили вход через Google или вошли через аккаунт Google, с которого подключён ваш календарь: идентификатор вашего аккаунта Google и его адрес электронной почты;'],
    ['privacy', 'если вы создали аккаунт по адресу электронной почты или добавили вход по электронной почте: этот адрес;'],
    ['privacy', 'для каждого способа входа: когда вы его добавили и когда в последний раз им пользовались;'],
    ['privacy', 'если вы подключили Google Календарь: адрес этого аккаунта Google в преобразованном виде (хеш), чтобы мы узнали этот аккаунт, когда вы войдёте через него.'],
    ['privacy', 'Мы используем эти данные только для входа, для отправки вам кодов входа, для уведомления о том, что добавлен способ входа (в вашем чате или по электронной почте, если у вашего аккаунта нет чата), и — если мы заблокировали аккаунт — чтобы с ними нельзя было зарегистрироваться снова.'],
    ['privacy', 'Чтобы не допустить злоупотреблений при входе, мы также считаем в Upstash попытки входа и новые аккаунты с каждого IP-адреса, для каждого адреса электронной почты и — при добавлении адреса — для каждого аккаунта, не дольше суток, причём сами идентификаторы хранятся там только в преобразованном виде (хеш).'],
    ['privacy', '**Вход.** Если вы входите через Google, FamCal запрашивает у Google только идентификатор вашего аккаунта и адрес электронной почты.'],
    ['privacy', 'мы читаем идентификатор вашего основного календаря (его адрес) с помощью разрешения на доступ к календарю, которое вы дали: при подключении Google Календаря или при включении этого входа в «Настройках» — чтобы сохранить его в преобразованном виде, и при входе — чтобы убедиться, что это тот же аккаунт.'],
    ['privacy', 'Чтобы FamCal работал для вас (ваш аккаунт и способы входа в него, календарь, настройки,'],
    ['privacy', 'журнал действий, счётчики попыток входа и новых аккаунтов, проверка на ботов в форме запроса кода по почте (Turnstile) и записи о заблокированных аккаунтах): наш законный интерес'],
    ['privacy', 'копии в кеше — до истечения их срока (до 30 дней);'],
    ['privacy', 'счётчики попыток входа и новых аккаунтов — до истечения их срока (не дольше суток) и копии писем, связанных со входом, у Resend (до 30 дней);'],
    ['privacy', 'Когда вы входите через Telegram или Google, ваш браузер открывает их страницу входа. Как и любой сайт, который вы посещаете, Telegram и Google видят ваш IP-адрес и данные о браузере.'],
    ['privacy', 'Мы используем эти данные только для входа, для уведомления по электронной почте о том, что добавлен способ входа (если у вашего аккаунта нет чата), и — если мы заблокировали аккаунт — чтобы с ними нельзя было зарегистрироваться снова. Мы никому их не передаём и удаляем их, когда вы удаляете вход через Google, отключаете Google Календарь (адрес в преобразованном виде) или удаляете аккаунт, кроме того, что сохраняется после блокировки (см. «Что остаётся после этого»).'],
    ['privacy', 'Что мы храним для входа через Google, описано в разделе «Ваш аккаунт», а когда мы это удаляем — выше, в пункте «Вход».'],
    ['privacy', 'вход в веб-приложение, вход на famcal.bot через Telegram и платежи звёздами.'],
    ['privacy', '**Google,** если вы входите или создаёте аккаунт через Google: идентификатор вашего аккаунта Google и адрес электронной почты — чтобы вы могли войти.'],
    ['privacy', '**Resend:** ваш адрес электронной почты и код для входа или уведомление, которые мы отправляем вам письмом. Resend хранит копию каждого письма до 30 дней.'],
    ['privacy', 'Railway, Sentry, Cloudflare (кроме данных, которые собирает Turnstile, — см. ниже) и Resend обрабатывают данные по нашему поручению.'],
    ['privacy', 'например в США, где Resend хранит данные писем, связанных со входом, мы опираемся'],
    ['privacy', '`__Host-famcal_session` сохраняет вход в веб-приложение:'],
    ['privacy', 'если вы вошли на famcal.bot через Telegram, Google или по коду из письма — около 30 дней с вашего последнего визита в веб-приложение;'],
    ['privacy', 'если вы открыли веб-приложение по ссылке из WhatsApp — 24 часа.'],
    ['privacy', 'Пока вы входите или создаёте аккаунт, `famcal_signin` хранит одноразовую проверку в течение 10 минут.'],
    ['privacy', '**Способы входа:** пока вы их не удалите или пока не будет удалён ваш аккаунт.'],
    ['privacy', '**Коды для входа:** 10 минут — вместе с адресом, на который они отправлены.'],
    ['privacy', '**Счётчики попыток входа и новых аккаунтов:** не дольше суток.'],
    ['privacy', 'На famcal.bot оно проверяет сеансовый cookie, который ваш браузер получил при входе.'],
    ['privacy', 'удалить способ входа в «Настройках», в разделе «Вход через браузер», если он у вас не единственный;'],
    ['privacy', '(в том числе удалённые), способы входа, ваш тариф,'],
    ['terms', 'Любой, кто может пользоваться вашим аккаунтом Telegram или WhatsApp, аккаунтом Google, с которого подключён ваш календарь, а также аккаунтом Google или почтовым ящиком, с которыми вы создали аккаунт или которые добавили для входа, может пользоваться FamCal от вашего имени. Берегите эти аккаунты.'],
  ],
};

/** What web sign-up's spec §7 adds, page by page (the text it replaced is in GONE_SIGNUP). */
const SAYS_SIGNUP: Record<Locale, [Doc, string][]> = {
  en: [
    ['privacy', 'FamCal is a family-calendar assistant. You use it by chatting with our bot on Telegram or WhatsApp, through a web app that opens from the bot or when you sign in on our website, and on the website itself, famcal.bot. You can also create an account on famcal.bot with Google or an email address, and use FamCal only in your browser. FamCal is built and run by {sellerName} in Israel (“we”, “us”). He decides how FamCal uses your data and is responsible for it.'],
    ['privacy', 'No law requires you to give us anything. An account needs one way for you to sign in: your Telegram user id or WhatsApp number, which is also how the bot talks to you, or the Google account or email address you created it with on famcal.bot. Everything else is up to you.'],
    ['privacy', 'If you create your account on famcal.bot: the name you give us.'],
    ['privacy', 'a note that the bot already asked whether a name is one of your children, kept for 30 days;'],
    ['privacy', 'while you create an account on famcal.bot, the address (and Google account id) you’re signing up with, for 10 minutes;'],
    ['privacy', 'a one-time link to connect Telegram to your account, for 10 minutes.'],
    ['privacy', 'We don’t ask anyone’s age, except that creating an account on famcal.bot asks you to confirm you’re 18 or older. If you think'],
    ['privacy', '**Cloudflare:** our domain’s DNS, forwarding the mail you send to {email} to our mailbox, and Turnstile, which checks that a person, not a program, asks for an email code on famcal.bot. Turnstile reads your IP address and browser details, not what you type.'],
    ['privacy', 'When you open the web app, your browser loads Telegram’s web-app script from telegram.org. When you ask for an email code, your browser loads Cloudflare’s Turnstile check from challenges.cloudflare.com. When you sign in'],
    ['privacy', 'Google Gemini, Neon, Upstash, Railway, Sentry, Cloudflare (except Turnstile’s signals, below) and Resend handle data for us.'],
    ['privacy', 'Cloudflare also uses Turnstile’s signals to improve its own bot detection, under its Turnstile Privacy Addendum.'],
    ['privacy', 'Feedback and payment questions you send also reach us as Telegram messages, with your name and your FamCal id, and your Telegram id if you have one.'],
    ['privacy', 'We may ask you to confirm the request from the bot, or from the email address you sign in with, so we know it comes from you.'],
    ['privacy', 'Among the copies we keep:'],
    ['privacy', '**Google,** if you sign in or create your account with Google: your Google account id and email address, to sign you in.'],
    ['privacy', 'if we banned the account: its Telegram id, WhatsApp number, sign-in email address, Google account id and that Google account’s email address, and the reason, so it can’t sign up again;'],
    ['terms', 'An account made on famcal.bot works in your browser without Telegram or WhatsApp. In the browser you add events yourself; FamCal’s assistant (voice notes, photos and messages) works in the bots. Briefings and reminders reach you once you connect Telegram in Settings.'],
    ['terms', 'and you need your own Telegram or WhatsApp account, or your own Google account or email address to create an account on famcal.bot. A partner'],
    ['terms', 'If you lose every way you sign in, we may not be able to give the account back.'],
    ['terms', 'You pay for Basic and Pro in the Telegram bot, with Telegram Stars. You can’t pay on WhatsApp or on famcal.bot yet. An account made on famcal.bot pays after you connect Telegram.'],
    ['terms', 'We may suspend an account, which means the bot stops answering it and it can’t sign in on famcal.bot.'],
    ['terms', 'You can stop using FamCal any time: block the bot if you use it, and ask us to delete your account'],
  ],
  he: [
    ['privacy', 'ובאתר עצמו, famcal.bot. אפשר גם לפתוח חשבון ב־famcal.bot עם Google או עם כתובת מייל, ולהשתמש ב־FamCal רק בדפדפן. את FamCal בונה'],
    ['privacy', 'לכל חשבון צריכה להיות דרך אחת שבה נכנסים אליו: מזהה המשתמש שלכם בטלגרם או מספר הוואטסאפ שלכם, שדרכם גם הבוט מדבר איתכם, או חשבון ה־Google או כתובת המייל שאיתם פתחתם אותו ב־famcal.bot.'],
    ['privacy', 'אם פתחתם את החשבון ב־famcal.bot: השם שמסרתם לנו.'],
    ['privacy', 'רישום שהבוט כבר שאל אם שם מסוים הוא של אחד הילדים שלכם, שנשמר 30 יום;'],
    ['privacy', 'בזמן פתיחת חשבון ב־famcal.bot, הכתובת (ומזהה חשבון ה־Google) שאיתה נרשמים, למשך 10 דקות;'],
    ['privacy', 'קישור חד־פעמי לחיבור טלגרם לחשבון שלכם, למשך 10 דקות.'],
    ['privacy', 'אנחנו לא שואלים אף אחד לגילו, מלבד בפתיחת חשבון ב־famcal.bot, שבה מבקשים מכם לאשר שמלאו לכם 18. אם נראה לכם'],
    ['privacy', '**Cloudflare:** ה־DNS של הדומיין שלנו, העברת המייל שאתם שולחים ל־{email} לתיבת הדואר שלנו, ו־Turnstile, שבודק שמי שמבקש קוד במייל ב־famcal.bot הוא אדם ולא תוכנה. Turnstile קורא את כתובת ה־IP ואת פרטי הדפדפן שלכם, לא את מה שאתם מקלידים.'],
    ['privacy', 'את הסקריפט של טלגרם לאפליקציות רשת. כשמבקשים קוד במייל, הדפדפן שלכם טוען מ־challenges.cloudflare.com את בדיקת Turnstile של Cloudflare. כשנכנסים'],
    ['privacy', 'Google Gemini, Neon, Upstash, Railway, Sentry, Cloudflare (חוץ מהנתונים ש־Turnstile אוסף, ראו בהמשך) ו־Resend מטפלים במידע בשבילנו.'],
    ['privacy', 'Cloudflare משתמשת בנתונים ש־Turnstile אוסף גם כדי לשפר את זיהוי הבוטים שלה, לפי נספח הפרטיות של Turnstile (Turnstile Privacy Addendum).'],
    ['privacy', 'משוב ושאלות על תשלומים ששולחים מגיעים אלינו גם כהודעות בטלגרם, עם השם שלכם ומזהה ה־FamCal שלכם, ומזהה הטלגרם שלכם אם יש לכם.'],
    ['privacy', 'ייתכן שנבקש מכם לאשר את הבקשה מתוך הבוט, או מכתובת המייל שאיתה אתם נכנסים, כדי לדעת שהיא באה מכם.'],
    ['privacy', 'בין העותקים שאנחנו שומרים:'],
    ['privacy', '**Google,** אם נכנסים או פותחים חשבון עם Google: המזהה של חשבון ה־Google שלכם וכתובת המייל שלו, כדי להכניס אתכם.'],
    ['privacy', 'אם חסמנו את החשבון: מזהה הטלגרם, מספר הוואטסאפ וכתובת המייל לכניסה שלו, מזהה חשבון ה־Google וכתובת המייל של אותו חשבון Google, והסיבה, כדי שלא יוכל להירשם שוב;'],
    ['terms', 'חשבון שנפתח ב־famcal.bot פועל בדפדפן בלי טלגרם ובלי וואטסאפ. בדפדפן אתם מוסיפים את האירועים בעצמכם; העוזר של FamCal (הודעות קוליות, תמונות והודעות כתובות) פועל בבוטים. סיכומים ותזכורות מגיעים אליכם אחרי שמחברים את טלגרם בהגדרות.'],
    ['terms', 'ולהחזיק חשבון טלגרם או וואטסאפ משלכם, או חשבון Google או כתובת מייל משלכם כדי לפתוח חשבון ב־famcal.bot. גם בן או בת הזוג'],
    ['terms', 'אם תאבדו את הגישה לכל דרכי הכניסה שלכם, ייתכן שלא נוכל להחזיר לכם את החשבון.'],
    ['terms', 'משלמים על בסיסי ועל Pro בבוט בטלגרם, בכוכבים של טלגרם. בוואטסאפ וב־famcal.bot עדיין אי אפשר לשלם. בחשבון שנפתח ב־famcal.bot משלמים אחרי שמחברים את טלגרם.'],
    ['terms', 'אנחנו רשאים להשעות חשבון, כלומר הבוט מפסיק לענות לו ואי אפשר להיכנס אליו ב־famcal.bot.'],
    ['terms', 'אפשר להפסיק להשתמש ב־FamCal בכל עת: לחסום את הבוט, אם אתם משתמשים בו, ולבקש'],
  ],
  ru: [
    ['privacy', 'и на самом сайте famcal.bot. Также можно создать аккаунт на famcal.bot через Google или по адресу электронной почты и пользоваться FamCal только в браузере. FamCal создаёт'],
    ['privacy', 'Для аккаунта нужен один способ входа: ваш идентификатор пользователя Telegram или номер WhatsApp, через которые с вами также общается бот, либо аккаунт Google или адрес электронной почты, с которыми вы создали аккаунт на famcal.bot.'],
    ['privacy', 'Если вы создали аккаунт на famcal.bot: имя, которое вы нам указали.'],
    ['privacy', 'отметка о том, что бот уже спрашивал, не принадлежит ли имя одному из ваших детей, — 30 дней;'],
    ['privacy', 'адрес (и идентификатор аккаунта Google), с которым вы создаёте аккаунт на famcal.bot, — 10 минут, пока идёт регистрация;'],
    ['privacy', 'одноразовая ссылка для подключения Telegram к вашему аккаунту — 10 минут.'],
    ['privacy', 'Мы ни у кого не спрашиваем возраст, кроме одного случая: при создании аккаунта на famcal.bot мы просим подтвердить, что вам исполнилось 18 лет. Если вы считаете,'],
    ['privacy', '**Cloudflare:** DNS нашего домена, пересылка писем, которые вы отправляете на {email}, в наш почтовый ящик, и Turnstile, который проверяет, что код по электронной почте на famcal.bot запрашивает человек, а не программа. Turnstile считывает ваш IP-адрес и данные о браузере, но не то, что вы вводите.'],
    ['privacy', 'скрипт Telegram для веб-приложений. Когда вы запрашиваете код по электронной почте, ваш браузер загружает с challenges.cloudflare.com проверку Turnstile от Cloudflare. Когда вы входите'],
    ['privacy', 'Google Gemini, Neon, Upstash, Railway, Sentry, Cloudflare (кроме данных, которые собирает Turnstile, — см. ниже) и Resend обрабатывают данные по нашему поручению.'],
    ['privacy', 'Cloudflare также использует данные, которые собирает Turnstile, чтобы улучшать собственное распознавание ботов, в соответствии с Дополнением о конфиденциальности Turnstile (Turnstile Privacy Addendum).'],
    ['privacy', 'приходят нам и в виде сообщений в Telegram — с вашим именем и идентификатором FamCal, а также идентификатором Telegram, если он у вас есть.'],
    ['privacy', 'Мы можем попросить вас подтвердить запрос из бота или с адреса электронной почты, с которым вы входите, чтобы убедиться,'],
    ['privacy', 'Среди этих копий:'],
    ['privacy', '**Google,** если вы входите или создаёте аккаунт через Google: идентификатор вашего аккаунта Google и адрес электронной почты — чтобы вы могли войти.'],
    ['privacy', 'если мы заблокировали аккаунт: его идентификатор Telegram, номер WhatsApp, идентификатор аккаунта Google, адрес электронной почты этого аккаунта Google и адрес электронной почты для входа, а также причина — чтобы с ними нельзя было зарегистрироваться снова;'],
    ['terms', 'Аккаунт, созданный на famcal.bot, работает в браузере без Telegram и WhatsApp. В браузере вы добавляете события сами; помощник FamCal (голосовые и текстовые сообщения, фото) работает в ботах. Сводки и напоминания начнут приходить, когда вы подключите Telegram в «Настройках».'],
    ['terms', 'и у вас должен быть собственный аккаунт Telegram или WhatsApp либо собственный аккаунт Google или адрес электронной почты, чтобы создать аккаунт на famcal.bot. Партнёру,'],
    ['terms', 'Если вы потеряете доступ ко всем способам входа, мы, возможно, не сможем вернуть вам аккаунт.'],
    ['terms', 'Тарифы «Базовый» и Pro оплачиваются в боте Telegram звёздами Telegram. В WhatsApp и на famcal.bot оплатить тариф пока нельзя. Если аккаунт создан на famcal.bot, тариф можно оплатить после подключения Telegram.'],
    ['terms', 'Мы можем приостановить аккаунт — тогда бот перестаёт ему отвечать, а войти в него на famcal.bot нельзя.'],
    ['terms', 'заблокируйте бота, если вы им пользуетесь, и попросите нас удалить ваш аккаунт'],
  ],
};

/** What web sign-up's §7 replaced, in each language. */
const GONE_SIGNUP: Record<Locale, [Doc, string][]> = {
  en: [
    ['privacy', 'FamCal can’t work without your Telegram user id or your WhatsApp number'],
    ['privacy', 'We don’t ask anyone’s age. If'],
    ['privacy', 'with your name and Telegram id.'],
    ['terms', 'You can’t pay on WhatsApp yet.'],
    ['privacy', 'The longest are:'],
    ['privacy', 'if you sign in with Google: your Google account id'],
    ['privacy', 'Google account id and sign-in email address'],
    ['privacy', 'that Google account and its sign-in email address'],
    ['terms', 'You can stop using FamCal any time: block the bot, and'],
    ['privacy', 'and to tell you when a way to sign in is added: in your chat'],
    ['privacy', 'We use these only to sign you in and, if your account has no chat'],
  ],
  he: [
    ['privacy', 'FamCal לא יכול לעבוד בלי מזהה המשתמש שלכם בטלגרם'],
    ['privacy', 'אנחנו לא שואלים אף אחד לגילו. אם'],
    ['privacy', 'עם השם שלכם ומזהה הטלגרם שלכם.'],
    ['terms', 'בוואטסאפ עדיין אי אפשר לשלם.'],
    ['privacy', 'הארוכים ביותר:'],
    ['privacy', 'אם נכנסים עם Google: המזהה של חשבון'],
    ['privacy', 'מזהה חשבון ה־Google וכתובת המייל לכניסה שלו'],
    ['privacy', 'של חשבון ה־Google וכתובת המייל לכניסה שלו'],
    ['terms', 'לחסום את הבוט, ולבקש'],
    ['terms', 'את כל הדרכים שבהן אתם נכנסים'],
    ['terms', 'להיכנס איתו ב־famcal.bot'],
    ['terms', 'בדפדפן מוסיפים את האירועים'],
    ['privacy', 'ולהודיע לכם כשנוספת דרך כניסה: בצ׳אט'],
    ['privacy', 'רק כדי להכניס אתכם, ואם לחשבון שלכם אין צ׳אט, גם'],
  ],
  ru: [
    ['privacy', 'FamCal не может работать без вашего идентификатора пользователя Telegram'],
    ['privacy', 'Мы ни у кого не спрашиваем возраст. Если'],
    ['privacy', 'с вашим именем и идентификатором Telegram.'],
    ['terms', 'В WhatsApp оплатить тариф пока нельзя.'],
    ['privacy', 'Дольше всего хранятся:'],
    ['privacy', 'если вы входите через Google: идентификатор вашего аккаунта Google'],
    ['privacy', 'идентификатор аккаунта Google и адрес электронной почты для входа'],
    ['privacy', 'адрес почты этого аккаунта Google'],
    ['terms', 'заблокируйте бота и попросите'],
    ['privacy', 'по своему приложению'],
    ['privacy', 'писем с кодами для входа'],
    ['terms', 'Аккаунт, созданный на famcal.bot, можно оплатить'],
    ['privacy', 'и для уведомления о том, что добавлен способ входа: в вашем чате'],
    ['privacy', 'только для входа и — если у вашего аккаунта нет чата — для уведомления'],
  ],
};

/** What no language may still say: the cookie's old name, the WhatsApp-only cookie line, the one account to keep safe. */
const GONE: Record<Locale, [Doc, RegExp][]> = {
  en: [['privacy', /(?<!__Host-)famcal_session/], ['privacy', /after you open it from WhatsApp/], ['terms', /Keep that account safe/]],
  he: [['privacy', /(?<!__Host-)famcal_session/], ['privacy', /אחרי שפותחים אותה מוואטסאפ/], ['terms', /שמרו היטב על החשבון הזה/]],
  ru: [['privacy', /(?<!__Host-)famcal_session/], ['privacy', /после того, как вы открыли его из WhatsApp/], ['terms', /Берегите этот аккаунт/]],
};

async function main() {
  await check('L1 the Privacy Policy and the Terms hold the same legal.* leaves (every key and list position) in en, he and ru', () => {
    const paths = (l: Locale) => leaves(messages[l].legal, 'legal').map(([at]) => at);
    const en = new Set(paths('en'));
    for (const locale of ['he', 'ru'] as const) {
      const other = new Set(paths(locale));
      const missing = [...en].filter((p) => !other.has(p));
      const extra = [...other].filter((p) => !en.has(p));
      assert(missing.length === 0 && extra.length === 0, `${locale}: missing ${show(missing.slice(0, 8))}, extra ${show(extra.slice(0, 8))}`);
    }
  });

  await check('L2 each language says what spec §7 adds (who, what we keep, the counters, Google sign-in, the providers, Resend bound and in the US, the cookies, retention, the cookie check, removing and deleting the ways, the Terms\' account security), and none still says the old cookie line or "keep that account safe"', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      for (const [doc, sentence] of SAYS[locale]) if (!text(locale, doc).includes(sentence)) problems.push(`${locale} ${doc}: no "${sentence}"`);
      for (const [doc, old] of GONE[locale]) if (old.test(text(locale, doc))) problems.push(`${locale} ${doc}: still ${old}`);
    }
    assert(problems.length === 0, problems.join('\n'));
  });

  await check('L5 each language says what web sign-up\'s spec §7 adds (the browser account, the one way in, the name, the sign-up\'s and the connect link\'s 10 minutes, the new accounts counted, the age, the no-chat notice, Turnstile, the FamCal id, the last way, the ban\'s identifiers and its use of the sign-in ways; the Terms\' browser account, eligibility, a lost last way, paying, suspension), and none still says what it replaced', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      for (const [doc, sentence] of SAYS_SIGNUP[locale]) if (!text(locale, doc).includes(sentence)) problems.push(`${locale} ${doc}: no "${sentence}"`);
      for (const [doc, old] of GONE_SIGNUP[locale]) if (text(locale, doc).includes(old)) problems.push(`${locale} ${doc}: still "${old}"`);
    }
    assert(problems.length === 0, problems.join('\n'));
  });

  await check('L3 LEGAL_UPDATED moved to the day each text last changed (the Privacy Policy 2026-11-05, the Terms 2026-11-04, or later; not in the future)', async () => {
    const { LEGAL_UPDATED } = (await import(path.join(ROOT, 'src/site/legal.ts'))) as Row;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    assert(LEGAL_UPDATED.privacy >= '2026-11-05' && LEGAL_UPDATED.terms >= '2026-11-04', `LEGAL_UPDATED ${show(LEGAL_UPDATED)}`);
    assert(LEGAL_UPDATED.privacy <= today && LEGAL_UPDATED.terms <= today, `LEGAL_UPDATED ${show(LEGAL_UPDATED)} is after today in Israel (${today})`);
  });

  await check('L4 the cookies the Policy names are the code\'s, with its lengths (the session 30 days on famcal.bot and 24 hours from a WhatsApp link, the sign-in check 10 minutes), in en, he and ru', () => {
    const session = read('src/lib/session-auth.ts');
    const flow = read('src/services/web-signin/flow.ts');
    const product = (s: string) => s.split('*').reduce((n, f) => n * Number(f.trim()), 1);
    const sessionName = /export const SESSION_COOKIE_NAME = '([^']+)'/.exec(session)?.[1];
    const ttl = /export const SESSION_TTL_SEC = \{ wa: ([\d\s*]+), web: ([\d\s*]+) \}/.exec(session);
    const signinName = /export const SIGNIN_COOKIE_NAME = '([^']+)'/.exec(flow)?.[1];
    const flowTtl = /const FLOW_TTL_SEC = ([\d\s*]+);/.exec(flow)?.[1];
    assert(sessionName && ttl && signinName && flowTtl, `not found: ${show({ sessionName, ttl: ttl?.[0], signinName, flowTtl })}`);
    assert(product(ttl[1]) === 24 * 60 * 60 && product(ttl[2]) === 30 * 24 * 60 * 60, `SESSION_TTL_SEC is ${ttl[0]}: the Policy says 24 hours and 30 days`);
    assert(product(flowTtl) === 10 * 60, `FLOW_TTL_SEC is ${flowTtl}: the Policy says 10 minutes`);
    for (const locale of LOCALES) {
      const policy = text(locale, 'privacy');
      for (const name of [sessionName, signinName]) assert(policy.includes(`\`${name}\``), `${locale}: the Policy does not name \`${name}\``);
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
