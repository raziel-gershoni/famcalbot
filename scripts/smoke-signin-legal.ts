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
//    old WhatsApp-only cookie line and "keep that account safe" are gone.
//  - L3 LEGAL_UPDATED moved for both pages to the day the text changed (2026-11-02 or later), and is not a day that has
//    not come yet in Israel.
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
    ['privacy', 'if you add Google sign-in, or sign in with the Google account your calendar is connected from: your Google account id and its email address;'],
    ['privacy', 'if you add email sign-in: that email address;'],
    ['privacy', 'for each, when you added it and last used it;'],
    ['privacy', 'if you connected Google Calendar: a scrambled form of that Google account’s address, so we can recognise it when you sign in with it.'],
    ['privacy', 'We use them only to sign you in and to send you sign-in codes.'],
    ['privacy', 'To stop misuse of sign-in, we also count sign-in attempts in Upstash per IP address, per email address and, when you add an email, per account, under scrambled keys, for up to a day.'],
    ['privacy', '**Signing in.** If you sign in with Google, FamCal asks Google only for your account id and email address.'],
    ['privacy', 'we check it is the same account by reading your primary calendar’s id (its address) with the calendar permission you gave.'],
    ['privacy', 'We use these only to sign you in, never share them with anyone else, and delete them when you remove Google sign-in, disconnect Google Calendar (the scrambled address) or delete your account.'],
    ['privacy', 'What we keep to sign you in with Google is under “Your account”, and “Signing in” above says when we delete it.'],
    ['privacy', 'the web app’s sign-in, signing in to famcal.bot with Telegram, and Stars payments.'],
    ['privacy', '**Google,** if you sign in with Google: your Google account id and email address, to sign you in.'],
    ['privacy', '**Resend:** your email address and the sign-in code, to email you the code. Resend keeps a copy of each email for up to 30 days.'],
    ['privacy', 'Railway, Sentry, Cloudflare and Resend handle data for us.'],
    ['privacy', 'such as the US, where Resend keeps the data of the sign-in emails, we rely'],
    ['privacy', '`__Host-famcal_session` keeps you signed in to the web app:'],
    ['privacy', 'after you sign in on famcal.bot with Telegram, Google or an email code, it lasts about 30 days from your last visit to the web app;'],
    ['privacy', 'after you open the web app from a WhatsApp link, it lasts 24 hours.'],
    ['privacy', 'While you sign in, `famcal_signin` holds a one-time check for 10 minutes.'],
    ['privacy', '**Sign-in methods:** until you remove them or your account is deleted.'],
    ['privacy', '**Sign-in codes:** 10 minutes, with the address they were sent to.'],
    ['privacy', '**Sign-in counters:** up to a day.'],
    ['privacy', 'On famcal.bot it checks the session cookie set when you signed in.'],
    ['privacy', 'remove a sign-in method in Settings, under “Sign in on the web”;'],
    ['privacy', '(deleted ones too), your sign-in methods, your plan,'],
    ['terms', 'Anyone who can use your Telegram or WhatsApp account, the Google account your calendar is connected from, or a Google account or mailbox you added for signing in, can use FamCal as you. Keep those accounts safe.'],
  ],
  he: [
    ['privacy', 'דרך אפליקציית רשת שנפתחת מתוך הבוט או אחרי כניסה באתר שלנו'],
    ['privacy', 'אם הוספתם כניסה עם Google, או נכנסתם עם חשבון ה־Google שהיומן שלכם מחובר ממנו: המזהה של חשבון ה־Google שלכם וכתובת המייל שלו;'],
    ['privacy', 'אם הוספתם כניסה עם מייל: כתובת המייל הזו;'],
    ['privacy', 'לכל אחת מדרכי הכניסה: מתי הוספתם אותה ומתי השתמשתם בה לאחרונה;'],
    ['privacy', 'אם חיברתם את יומן Google: הכתובת של חשבון ה־Google הזה בצורה מעורבלת (hash), כדי שנזהה אותו כשתיכנסו איתו.'],
    ['privacy', 'אנחנו משתמשים בהם רק כדי להכניס אתכם ולשלוח לכם קודי כניסה.'],
    ['privacy', 'כדי למנוע שימוש לרעה בכניסה, אנחנו גם סופרים ב־Upstash את ניסיונות הכניסה מכל כתובת IP, לכל כתובת מייל ולכל חשבון (כשמוסיפים כתובת מייל), למשך יום לכל היותר, והמזהים נשמרים שם רק בצורה מעורבלת (hash).'],
    ['privacy', '**כניסה.** אם נכנסים עם Google, FamCal מבקש מ־Google רק את המזהה של החשבון שלכם ואת כתובת המייל שלו.'],
    ['privacy', 'אנחנו קוראים את המזהה של היומן הראשי שלכם (הכתובת שלו) בעזרת ההרשאה ליומן שנתתם.'],
    ['privacy', 'אנחנו משתמשים במידע הזה רק כדי להכניס אתכם, לא מעבירים אותו לאף אחד אחר, ומוחקים אותו כשמסירים את הכניסה עם Google, כשמנתקים את יומן Google (את הכתובת המעורבלת) או כשמוחקים את החשבון.'],
    ['privacy', 'מה אנחנו שומרים כדי להכניס אתכם עם Google מפורט תחת ״החשבון שלכם״, ובסעיף ״כניסה״ למעלה מפורט מתי אנחנו מוחקים אותו.'],
    ['privacy', 'ההתחברות לאפליקציית הרשת, הכניסה ל־famcal.bot עם טלגרם, ותשלומים בכוכבים.'],
    ['privacy', '**Google,** אם נכנסים עם Google: המזהה של חשבון ה־Google שלכם וכתובת המייל שלו, כדי להכניס אתכם.'],
    ['privacy', '**Resend:** כתובת המייל שלכם וקוד הכניסה, כדי לשלוח לכם את הקוד במייל. Resend שומרת עותק של כל מייל עד 30 יום.'],
    ['privacy', 'Railway, Sentry, Cloudflare ו־Resend מטפלים במידע בשבילנו.'],
    ['privacy', 'כמו ארצות הברית, שבה Resend שומרת את המידע של מיילי הכניסה, אנחנו מסתמכים'],
    ['privacy', '`__Host-famcal_session` שומרת על ההתחברות שלכם לאפליקציית הרשת:'],
    ['privacy', 'אחרי כניסה ב־famcal.bot עם טלגרם, עם Google או עם קוד במייל, היא תקפה כ־30 יום מהביקור האחרון שלכם באפליקציית הרשת;'],
    ['privacy', 'אחרי שפותחים את אפליקציית הרשת מקישור בוואטסאפ, היא תקפה 24 שעות.'],
    ['privacy', 'בזמן הכניסה, `famcal_signin` שומרת בדיקה חד־פעמית למשך 10 דקות.'],
    ['privacy', '**דרכי הכניסה:** עד שמסירים אותן או עד שהחשבון נמחק.'],
    ['privacy', '**קודי כניסה:** 10 דקות, יחד עם הכתובת שאליה נשלחו.'],
    ['privacy', '**ספירת ניסיונות הכניסה:** יום לכל היותר.'],
    ['privacy', 'ב־famcal.bot היא בודקת את עוגיית ההתחברות שנשמרה כשנכנסתם.'],
    ['privacy', 'להסיר דרך כניסה בהגדרות, תחת ״כניסה מהדפדפן״;'],
    ['privacy', '(גם אירועים שנמחקו), את דרכי הכניסה, את המסלול,'],
    ['terms', 'כל מי שיכול להשתמש בחשבון הטלגרם או הוואטסאפ שלכם, בחשבון ה־Google שהיומן שלכם מחובר ממנו, או בחשבון Google או בתיבת מייל שהוספתם לכניסה, יכול להשתמש ב־FamCal בשמכם. שמרו היטב על החשבונות האלה.'],
  ],
  ru: [
    ['privacy', 'через веб-приложение, которое открывается из бота или после входа на нашем сайте'],
    ['privacy', 'если вы добавили вход через Google или вошли через аккаунт Google, с которого подключён ваш календарь: идентификатор вашего аккаунта Google и его адрес электронной почты;'],
    ['privacy', 'если вы добавили вход по электронной почте: этот адрес;'],
    ['privacy', 'для каждого способа входа: когда вы его добавили и когда в последний раз им пользовались;'],
    ['privacy', 'если вы подключили Google Календарь: адрес этого аккаунта Google в преобразованном виде (хеш), чтобы мы узнали этот аккаунт, когда вы войдёте через него.'],
    ['privacy', 'Мы используем эти данные только для входа и для отправки вам кодов входа.'],
    ['privacy', 'Чтобы не допустить злоупотреблений при входе, мы также считаем в Upstash попытки входа с каждого IP-адреса, для каждого адреса электронной почты и — при добавлении адреса — для каждого аккаунта, не дольше суток, причём сами идентификаторы хранятся там только в преобразованном виде (хеш).'],
    ['privacy', '**Вход.** Если вы входите через Google, FamCal запрашивает у Google только идентификатор вашего аккаунта и адрес электронной почты.'],
    ['privacy', 'мы читаем идентификатор вашего основного календаря (его адрес) с помощью разрешения на доступ к календарю, которое вы дали.'],
    ['privacy', 'Мы используем эти данные только для входа, больше никому их не передаём и удаляем их, когда вы удаляете вход через Google, отключаете Google Календарь (адрес в преобразованном виде) или удаляете аккаунт.'],
    ['privacy', 'Что мы храним для входа через Google, описано в разделе «Ваш аккаунт», а когда мы это удаляем — выше, в пункте «Вход».'],
    ['privacy', 'вход в веб-приложение, вход на famcal.bot через Telegram и платежи звёздами.'],
    ['privacy', '**Google,** если вы входите через Google: идентификатор вашего аккаунта Google и адрес электронной почты — чтобы вы могли войти.'],
    ['privacy', '**Resend:** ваш адрес электронной почты и код для входа — чтобы отправить вам код. Resend хранит копию каждого письма до 30 дней.'],
    ['privacy', 'Railway, Sentry, Cloudflare и Resend обрабатывают данные по нашему поручению.'],
    ['privacy', 'например в США, где Resend хранит данные писем с кодами для входа, мы опираемся'],
    ['privacy', '`__Host-famcal_session` сохраняет вход в веб-приложение:'],
    ['privacy', 'если вы вошли на famcal.bot через Telegram, Google или по коду из письма — около 30 дней с вашего последнего визита в веб-приложение;'],
    ['privacy', 'если вы открыли веб-приложение по ссылке из WhatsApp — 24 часа.'],
    ['privacy', 'Пока вы входите, `famcal_signin` хранит одноразовую проверку в течение 10 минут.'],
    ['privacy', '**Способы входа:** пока вы их не удалите или пока не будет удалён ваш аккаунт.'],
    ['privacy', '**Коды для входа:** 10 минут — вместе с адресом, на который они отправлены.'],
    ['privacy', '**Счётчики попыток входа:** не дольше суток.'],
    ['privacy', 'На famcal.bot оно проверяет сеансовый cookie, который ваш браузер получил при входе.'],
    ['privacy', 'удалить способ входа в «Настройках», в разделе «Вход через браузер»;'],
    ['privacy', '(в том числе удалённые), способы входа, ваш тариф,'],
    ['terms', 'Любой, кто может пользоваться вашим аккаунтом Telegram или WhatsApp, аккаунтом Google, с которого подключён ваш календарь, а также аккаунтом Google или почтовым ящиком, добавленными для входа, может пользоваться FamCal от вашего имени. Берегите эти аккаунты.'],
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

  await check('L3 LEGAL_UPDATED moved for both pages to the day the text changed (2026-11-02 or later, not in the future)', async () => {
    const { LEGAL_UPDATED } = (await import(path.join(ROOT, 'src/site/legal.ts'))) as Row;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    assert(LEGAL_UPDATED.privacy >= '2026-11-02' && LEGAL_UPDATED.terms >= '2026-11-02', `LEGAL_UPDATED ${show(LEGAL_UPDATED)}`);
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
