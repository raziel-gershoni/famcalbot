// Live evaluation of the Hebrew two-host show. Costs money: an LLM call or two and up
// to about a minute of Gemini TTS audio per fixture (roughly $0.02 each).
//
// Run: npx tsx -r dotenv/config scripts/eval-voice-show.ts <outDir> [--model gemini-3.8-flash]
//
// Needs GEMINI_API_KEY. For each fixture: writes the script with the real writer; checks facts survive, forbidden
// phrases are absent, the opening leads where it should, no digits are left, sounds
// stay in budget and genders are right (an LLM judge); synthesizes the
// show locally with Flash TTS and checks its length. Then runs tts-service's
// /api/dialogue handler in-process once. Scripts, results and audio go to outDir.

import fs from 'fs/promises';
import path from 'path';
import type { UserConfig } from '../src/types';
import type { ShowKind, ShowTurn } from '../src/services/voice-show/types';
import type { ShowPromptContext } from '../src/prompts/voice-show/types';

interface Fixture {
  name: string;
  /** Defaults to Hebrew. */
  language?: 'he' | 'en' | 'ru';
  kind: ShowKind;
  isNextWeek?: boolean;
  user: Record<string, unknown>;
  summary: string;
  /** Each group is satisfied when any of its strings appears in the script, ignoring case. */
  facts: string[][];
  /** Checked like facts, but the check fails when any of these appears. */
  forbidden?: string[];
  /** One of `any` must appear within the first `within` turns (what the show leads with). */
  leads?: { within: number; any: string[] };
  seconds: [number, number];
}

// /weather input in formatWeatherAI's shape (src/services/weather/formatter.ts): a
// greeting with the name and date, then three bold sections in flowing prose written
// around the local time it was asked for.
const WEATHER_WEEK = `<b>השבוע</b>
בשבת וביום ראשון החום נמשך, עם 29-31 מעלות ולחות גבוהה, ממש סוף שבוע של ים 🏖️. מיום שני מגיעה הקלה: הטמפרטורות יירדו ל-24-25 מעלות, ויש סיכוי של 40% לממטרים ראשונים ביום שלישי בבוקר 🌦️. ביום רביעי חוזרים לשמיים בהירים ולמזג אוויר יבש ונעים, סביב 25 מעלות.

<b>תחזית מורחבת</b>
בשבוע שאחרי צפויה מגמה של התקררות הדרגתית, עם טמפרטורות של 21-24 מעלות ביום. ייתכנו ימים גשומים נוספים, אבל זו הערכה כללית בלבד ועוד מוקדם לדעת בוודאות 🍂.`;

const FIXTURES: Fixture[] = [
  {
    name: 'daily-male-busy',
    kind: 'daily',
    user: {
      name: 'דני', gender: 'male', culture: 'jewish',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'נועה', color: '', personName: 'נועה', personGender: 'female' },
        { calendarId: 'k1', labels: ['kids'], name: 'איתי', color: '', personName: 'איתי', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'תמר', color: '', personName: 'תמר', personGender: 'female' },
      ],
    },
    summary: `<b>בוקר טוב, דני! ☀️</b>

<b>היום - יום ראשון, 18 באוקטובר (ט״ז בתשרי)</b>

<b>לוח הזמנים שלך:</b>
• 08:30 - ישיבת צוות בזום
• 10:15 - פגישה עם עו"ד לוי
• 13:00 - ארוחת צהריים עם אבא

<b>לוח הזמנים של נועה:</b>
• 11:00 - רופא שיניים

<b>סדר איסוף:</b>
• 14:00 - נועה אוספת את איתי מהגן
• 16:30 - חוג שחייה לתמר

<b>מזג אוויר:</b> ☀️ 28°/19°, בהיר, בלי גשם. לחות גבוהה בצהריים.

<b>מבט לשבוע:</b>
• יום רביעי - יום ההולדת של סבתא רחל`,
    facts: [['דני'], ['צוות'], ['לוי'], ['אבא'], ['שיניים'], ['איתי'], ['תמר'], ['שחייה'], ['רחל'], ['ורבע'], ['אחת עשרה'], ['ארבע וחצי', 'שש עשרה ושלושים']],
    seconds: [35, 85],
  },
  {
    name: 'daily-female-empty',
    kind: 'daily',
    user: { name: 'מיכל', gender: 'female', culture: 'default', calendarAssignments: [] },
    summary: `<b>בוקר טוב, מיכל!</b>

<b>היום - יום שלישי, 20 באוקטובר</b>

אין אירועים ביומן היום 🎉

<b>מזג אוויר:</b> 🌧️ 22°/14°, סיכוי לגשם 60% אחר הצהריים. כדאי לקחת מטרייה.`,
    facts: [['מיכל'], ['גשם', 'מטרייה'], ['פנוי', 'אין אירועים', 'ריק', 'חופשי']],
    seconds: [15, 70],
  },
  {
    // A female listener with a spouse of unknown gender (plan Review Focus 3).
    name: 'daily-female-busy',
    kind: 'daily',
    user: {
      name: 'נועה', gender: 'female', culture: 'default',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'שי', color: '', personName: 'שי' },
        { calendarId: 'k1', labels: ['kids'], name: 'יואב', color: '', personName: 'יואב', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'מאיה', color: '', personName: 'מאיה', personGender: 'female' },
      ],
    },
    summary: `<b>בוקר טוב, נועה! ☀️</b>

<b>היום - יום רביעי, 21 באוקטובר</b>

<b>לוח הזמנים שלך:</b>
• 08:00-09:00 - ישיבת הנהלה
• 12:15 - ארוחת צהריים עם דנה
• 17:45 - פילאטיס

<b>לוח הזמנים של שי:</b>
• 10:30 - ראיון עבודה
• 19:00 - משחק כדורגל

<b>סדר איסוף:</b>
• 13:30 - יואב: איסוף מבית הספר (שי)
• 16:00 - מאיה: חוג בלט

<b>מזג אוויר:</b> 🌤️ 25°/16°, נעים עם רוח קלה. הערב מתקרר, כדאי ז׳קט דק.`,
    facts: [['נועה'], ['הנהלה'], ['דנה'], ['פילאטיס'], ['שי'], ['ראיון'], ['כדורגל'], ['יואב'], ['מאיה'], ['בלט'], ['עשר וחצי'], ['ורבע']],
    seconds: [35, 90],
  },
  {
    name: 'weekly-busy',
    kind: 'weekly',
    isNextWeek: false,
    user: {
      name: 'רזיאל', gender: 'male', culture: 'jewish',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'שי', color: '', personName: 'שי' },
        { calendarId: 'k1', labels: ['kids'], name: 'אורי', color: '', personName: 'אורי', personGender: 'male' },
      ],
    },
    summary: `<b>השבוע שלך 📅</b>

<b>יום ראשון (ט״ז בתשרי)</b>
• 09:00 - פגישת תכנון רבעונית
• 17:00 - שי: יוגה

<b>יום שני</b>
• 08:00 - אורי: טיול שנתי
• 12:30 - ארוחת צהריים עם הצוות
• 19:00 - אסיפת הורים

<b>יום שלישי</b>
• 10:00 - דוקטור כהן
• 15:45 - אורי: חוג רובוטיקה

<b>יום רביעי</b>
• 07:30 - טיסה לאילת
• 21:00 - שי: הופעה

<b>יום חמישי</b>
• 11:15 - שיחת משקיעים
• 18:00 - יום ההולדת של סבא משה

<b>יום שישי</b>
• 13:00 - ארוחת שישי אצל ההורים`,
    facts: [['תכנון'], ['יוגה'], ['טיול'], ['אסיפת הורים'], ['כהן'], ['רובוטיקה'], ['אילת'], ['הופעה'], ['משקיעים'], ['משה'], ['שישי']],
    seconds: [40, 100],
  },
  {
    name: 'weather-morning',
    kind: 'weather',
    user: { name: 'יוסי', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `בוקר טוב יוסי! ☀️ היום יום חמישי, 22 באוקטובר 2026.

<b>היום ומחר</b>
כרגע בתל אביב 19 מעלות ושמיים בהירים, והבוקר עוד נעים ☀️. במהלך היום הטמפרטורה תטפס עד 28 מעלות בצהריים, עם לחות גבוהה שתורגש במיוחד בין 12:00 ל-15:00 💧. מדד ה-UV יגיע ל-8, אז אם יוצאים החוצה כדאי קרם הגנה וכובע. הערב יתקרר ל-22 מעלות, ובלילה הטמפרטורה תרד ל-20. מחר, יום שישי, יהיה עוד קצת חם יותר: עד 30 מעלות, שמיים בהירים ובלי גשם, עם רוח מערבית קלה אחר הצהריים 🌬️.

${WEATHER_WEEK}`,
    facts: [['מחר'], ['עשרים ושמונה'], ['שלושים'], ['קרם', 'כובע'], ['גשם', 'ממטרים', 'ממטר'], ['שבת', 'סוף שבוע', 'סוף השבוע', 'סופ"ש']],
    forbidden: ['ערב טוב'],
    seconds: [25, 65],
  },
  {
    // Asked at nine in the evening: what is left of today is the night, so the show
    // should lead with tomorrow.
    name: 'weather-evening',
    kind: 'weather',
    user: { name: 'יוסי', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `ערב טוב יוסי! 🌙 היום יום חמישי, 22 באוקטובר 2026.

<b>היום ומחר</b>
הערב כבר נעים ומתקרר: כרגע 22 מעלות, שמיים בהירים ורוח מערבית חלשה 🌙. בלילה הטמפרטורה תרד ל-19 מעלות. מחר, יום שישי, הבוקר יתחיל ב-20 מעלות והטמפרטורה תטפס עד 30 מעלות בצהריים ☀️. השמיים יישארו בהירים ובלי גשם, אבל מדד ה-UV יגיע ל-9 בין 11:00 ל-14:00, אז כדאי קרם הגנה וכובע. אחר הצהריים תנשוב רוח מערבית קלה שתקל קצת על החום 🌬️.

${WEATHER_WEEK}`,
    facts: [['מחר'], ['שלושים'], ['קרם', 'כובע'], ['גשם', 'ממטרים', 'ממטר'], ['שבת', 'סוף שבוע', 'סוף השבוע', 'סופ"ש']],
    forbidden: ['בוקר טוב'],
    leads: { within: 2, any: ['מחר'] },
    seconds: [25, 65],
  },
  {
    name: 'tomorrow-male',
    kind: 'tomorrow',
    user: { name: 'עומר', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `<b>ערב טוב, עומר! 🌙</b>

<b>מחר - יום שני, 19 באוקטובר</b>

<b>לוח הזמנים שלך:</b>
• 07:00 - חדר כושר
• 11:00 - תור לרופא
• 18:30 - ארוחת ערב עם חברים

<b>מזג אוויר:</b> ⛅ 26°/18°, מעונן חלקית.`,
    facts: [['מחר'], ['עומר'], ['רופא'], ['ספורט', 'כושר', 'חדר כושר'], ['אחת עשרה']],
    forbidden: ['בוקר טוב', 'היום יום'],
    leads: { within: 2, any: ['מחר'] },
    seconds: [30, 85],
  },
];

// English and Russian: the same families and days as the Hebrew fixtures. Facts match
// word stems, since Russian declines names and times (Итай -> Итая).
const WEATHER_WEEK_EN = `<b>This week</b>
Saturday and Sunday stay hot, 29-31° with high humidity, a real beach weekend 🏖️. Monday brings relief: temperatures drop to 24-25°, with a 40% chance of the first showers on Tuesday morning 🌦️. Wednesday is back to clear skies, dry and pleasant, around 25°.

<b>Extended outlook</b>
The week after looks set to cool gradually, with daytime highs of 21-24°. More rainy days are possible, but this is only a general outlook and it is too early to be sure 🍂.`;

const WEATHER_WEEK_RU = `<b>На этой неделе</b>
В субботу и воскресенье жара сохранится, 29-31° и высокая влажность, настоящие пляжные выходные 🏖️. С понедельника станет легче: температура опустится до 24-25°, а во вторник утром 40% вероятность первых ливней 🌦️. В среду снова ясно, сухо и приятно, около 25°.

<b>Расширенный прогноз</b>
На следующей неделе ожидается постепенное похолодание, днём 21-24°. Возможны новые дождливые дни, но это лишь общая оценка и пока рано говорить наверняка 🍂.`;

const FIXTURES_EN_RU: Fixture[] = [
  {
    name: 'en-daily-male-busy',
    language: 'en',
    kind: 'daily',
    user: {
      name: 'Danny', gender: 'male', culture: 'default',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'Noa', color: '', personName: 'Noa', personGender: 'female' },
        { calendarId: 'k1', labels: ['kids'], name: 'Itai', color: '', personName: 'Itai', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'Tamar', color: '', personName: 'Tamar', personGender: 'female' },
      ],
    },
    summary: `<b>Good morning, Danny! ☀️</b>

<b>Today - Sunday, October 18</b>

<b>Your schedule:</b>
• 08:30 - Team meeting on Zoom
• 10:15 - Meeting with attorney Levy
• 13:00 - Lunch with Dad

<b>Noa's schedule:</b>
• 11:00 - Dentist

<b>Pickups:</b>
• 14:00 - Noa picks up Itai from kindergarten
• 16:30 - Swimming class for Tamar

<b>Weather:</b> ☀️ 28°/19°, clear, no rain. Humid around noon.

<b>Week ahead:</b>
• Wednesday - Grandma Rachel's birthday`,
    facts: [['danny'], ['team'], ['levy'], ['dad'], ['dentist'], ['itai'], ['tamar'], ['swim'], ['rachel'], ['ten fifteen', 'quarter past ten'], ['eleven'], ['four thirty', 'half past four']],
    seconds: [35, 85],
  },
  {
    // A female listener with a spouse of unknown gender: no "he" or "she" for Shai.
    name: 'en-daily-female-busy',
    language: 'en',
    kind: 'daily',
    user: {
      name: 'Noa', gender: 'female', culture: 'default',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'Shai', color: '', personName: 'Shai' },
        { calendarId: 'k1', labels: ['kids'], name: 'Yoav', color: '', personName: 'Yoav', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'Maya', color: '', personName: 'Maya', personGender: 'female' },
      ],
    },
    summary: `<b>Good morning, Noa! ☀️</b>

<b>Today - Wednesday, October 21</b>

<b>Your schedule:</b>
• 08:00-09:00 - Management meeting
• 12:15 - Lunch with Dana
• 17:45 - Pilates

<b>Shai's schedule:</b>
• 10:30 - Job interview
• 19:00 - Football game

<b>Pickups:</b>
• 13:30 - Yoav: school pickup (Shai)
• 16:00 - Maya: ballet class

<b>Weather:</b> 🌤️ 25°/16°, pleasant with a light breeze. Cooler this evening, bring a light jacket.`,
    facts: [['noa'], ['management'], ['dana'], ['pilates'], ['shai'], ['interview'], ['football', 'soccer'], ['yoav'], ['maya'], ['ballet'], ['ten thirty', 'half past ten'], ['twelve fifteen', 'quarter past twelve']],
    seconds: [35, 90],
  },
  {
    name: 'en-tomorrow-male',
    language: 'en',
    kind: 'tomorrow',
    user: { name: 'Omer', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `<b>Good evening, Omer! 🌙</b>

<b>Tomorrow - Monday, October 19</b>

<b>Your schedule:</b>
• 07:00 - Gym
• 11:00 - Doctor's appointment
• 18:30 - Dinner with friends

<b>Weather:</b> ⛅ 26°/18°, partly cloudy.`,
    facts: [['tomorrow'], ['omer'], ['doctor'], ['gym', 'workout'], ['eleven'], ['six thirty', 'half past six']],
    forbidden: ['good morning', 'today is'],
    leads: { within: 2, any: ['tomorrow'] },
    seconds: [30, 85],
  },
  {
    name: 'en-weekly-busy',
    language: 'en',
    kind: 'weekly',
    isNextWeek: false,
    user: {
      name: 'Raziel', gender: 'male', culture: 'default',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'Shai', color: '', personName: 'Shai' },
        { calendarId: 'k1', labels: ['kids'], name: 'Uri', color: '', personName: 'Uri', personGender: 'male' },
      ],
    },
    summary: `<b>Your week 📅</b>

<b>Sunday</b>
• 09:00 - Quarterly planning meeting
• 17:00 - Shai: yoga

<b>Monday</b>
• 08:00 - Uri: school trip
• 12:30 - Team lunch
• 19:00 - Parent-teacher meeting

<b>Tuesday</b>
• 10:00 - Dr. Cohen
• 15:45 - Uri: robotics club

<b>Wednesday</b>
• 07:30 - Flight to Eilat
• 21:00 - Shai: concert

<b>Thursday</b>
• 11:15 - Investor call
• 18:00 - Grandpa Moshe's birthday

<b>Friday</b>
• 13:00 - Friday lunch at the parents'`,
    facts: [['planning'], ['yoga'], ['trip'], ['parent'], ['cohen'], ['robotics'], ['eilat'], ['concert'], ['investor'], ['moshe'], ['friday']],
    seconds: [40, 100],
  },
  {
    name: 'en-weather-evening',
    language: 'en',
    kind: 'weather',
    user: { name: 'Joe', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `Good evening, Joe! 🌙 Today is Thursday, October 22, 2026.

<b>Today and tomorrow</b>
The evening is already pleasant and cooling: 22° right now, clear skies and a weak westerly wind 🌙. Overnight it drops to 19°. Tomorrow, Friday, the morning starts at 20° and climbs to 30° by noon ☀️. Skies stay clear with no rain, but the UV index reaches 9 between 11:00 and 14:00, so sunscreen and a hat are a good idea. In the afternoon a light westerly breeze takes a little edge off the heat 🌬️.

${WEATHER_WEEK_EN}`,
    facts: [['tomorrow'], ['thirty'], ['sunscreen', 'hat'], ['rain', 'shower'], ['weekend', 'saturday']],
    forbidden: ['good morning'],
    leads: { within: 2, any: ['tomorrow'] },
    seconds: [25, 65],
  },
  {
    name: 'ru-daily-male-busy',
    language: 'ru',
    kind: 'daily',
    user: {
      name: 'Денис', gender: 'male', culture: 'default',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'Ноа', color: '', personName: 'Ноа', personGender: 'female' },
        { calendarId: 'k1', labels: ['kids'], name: 'Итай', color: '', personName: 'Итай', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'Тамар', color: '', personName: 'Тамар', personGender: 'female' },
      ],
    },
    summary: `<b>Доброе утро, Денис! ☀️</b>

<b>Сегодня - воскресенье, 18 октября</b>

<b>Твоё расписание:</b>
• 08:30 - Планёрка в Зуме
• 10:15 - Встреча с адвокатом Леви
• 13:00 - Обед с папой

<b>Расписание Ноа:</b>
• 11:00 - Стоматолог

<b>Кого забрать:</b>
• 14:00 - Ноа забирает Итая из садика
• 16:30 - Тамар: плавание

<b>Погода:</b> ☀️ 28°/19°, ясно, без осадков. В полдень влажно.

<b>Взгляд на неделю:</b>
• Среда - День рождения бабушки Рахель`,
    facts: [['денис'], ['планёр', 'планер', 'совещ', 'команд'], ['леви'], ['пап'], ['стоматолог', 'зубн'], ['ита'], ['тамар'], ['плава'], ['рахел'], ['десять пятнадцать', 'четверть одиннадцатого'], ['одиннадцат'], ['четыре тридцать', 'половин', 'шестнадцать тридцать']],
    seconds: [35, 85],
  },
  {
    // A female listener with a spouse of unknown gender: Russian genders past-tense
    // verbs and short adjectives, so Шай must get neutral phrasing.
    name: 'ru-daily-female-busy',
    language: 'ru',
    kind: 'daily',
    user: {
      name: 'Ноа', gender: 'female', culture: 'default',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'Шай', color: '', personName: 'Шай' },
        { calendarId: 'k1', labels: ['kids'], name: 'Йоав', color: '', personName: 'Йоав', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'Майя', color: '', personName: 'Майя', personGender: 'female' },
      ],
    },
    summary: `<b>Доброе утро, Ноа! ☀️</b>

<b>Сегодня - среда, 21 октября</b>

<b>Твоё расписание:</b>
• 08:00-09:00 - Совещание руководства
• 12:15 - Обед с Даной
• 17:45 - Пилатес

<b>Расписание Шай:</b>
• 10:30 - Собеседование
• 19:00 - Футбольный матч

<b>Кого забрать:</b>
• 13:30 - Йоав: забрать из школы (Шай)
• 16:00 - Майя: балет

<b>Погода:</b> 🌤️ 25°/16°, приятно, лёгкий ветер. К вечеру прохладнее, возьми лёгкую куртку.`,
    facts: [['ноа'], ['руковод', 'совещ'], ['дан'], ['пилатес'], ['шай'], ['собеседов'], ['футбол'], ['йоав'], ['май'], ['балет'], ['десять тридцать', 'половин'], ['двенадцать пятнадцать', 'четверть первого']],
    seconds: [35, 90],
  },
  {
    name: 'ru-tomorrow-male',
    language: 'ru',
    kind: 'tomorrow',
    user: { name: 'Омер', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `<b>Добрый вечер, Омер! 🌙</b>

<b>Завтра - понедельник, 19 октября</b>

<b>Твоё расписание:</b>
• 07:00 - Спортзал
• 11:00 - Приём у врача
• 18:30 - Ужин с друзьями

<b>Погода:</b> ⛅ 26°/18°, переменная облачность.`,
    facts: [['завтра'], ['омер'], ['врач'], ['спортзал', 'зал', 'трениров'], ['одиннадцат'], ['шесть тридцать', 'половин', 'восемнадцать тридцать']],
    forbidden: ['доброе утро', 'сегодня понедельник'],
    leads: { within: 2, any: ['завтра'] },
    seconds: [30, 85],
  },
  {
    name: 'ru-weekly-busy',
    language: 'ru',
    kind: 'weekly',
    isNextWeek: false,
    user: {
      name: 'Рафаэль', gender: 'male', culture: 'default',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'Шай', color: '', personName: 'Шай' },
        { calendarId: 'k1', labels: ['kids'], name: 'Ури', color: '', personName: 'Ури', personGender: 'male' },
      ],
    },
    summary: `<b>Твоя неделя 📅</b>

<b>Воскресенье</b>
• 09:00 - Квартальное планирование
• 17:00 - Шай: йога

<b>Понедельник</b>
• 08:00 - Ури: школьная экскурсия
• 12:30 - Обед с командой
• 19:00 - Родительское собрание

<b>Вторник</b>
• 10:00 - Доктор Коэн
• 15:45 - Ури: кружок робототехники

<b>Среда</b>
• 07:30 - Рейс в Эйлат
• 21:00 - Шай: концерт

<b>Четверг</b>
• 11:15 - Звонок с инвесторами
• 18:00 - День рождения дедушки Моше

<b>Пятница</b>
• 13:00 - Пятничный обед у родителей`,
    facts: [['планиров'], ['йог'], ['экскурс'], ['собрани'], ['коэн'], ['робототехн'], ['эйлат'], ['концерт'], ['инвестор'], ['моше'], ['пятниц']],
    seconds: [40, 100],
  },
  {
    name: 'ru-weather-evening',
    language: 'ru',
    kind: 'weather',
    user: { name: 'Иосиф', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `Добрый вечер, Иосиф! 🌙 Сегодня четверг, 22 октября 2026.

<b>Сегодня и завтра</b>
Вечер уже приятный и становится прохладнее: сейчас 22°, ясно, слабый западный ветер 🌙. Ночью до 19°. Завтра, в пятницу, утро начнётся с 20°, а к полудню до 30° ☀️. Небо останется ясным, без дождя, но УФ-индекс дойдёт до 9 с 11:00 до 14:00, так что пригодятся солнцезащитный крем и шляпа. Днём лёгкий западный ветер немного смягчит жару 🌬️.

${WEATHER_WEEK_RU}`,
    facts: [['завтра'], ['тридцат'], ['крем', 'шляп', 'панам'], ['дожд', 'ливн', 'ливен'], ['выходн', 'суббот']],
    forbidden: ['доброе утро'],
    leads: { within: 2, any: ['завтра'] },
    seconds: [25, 65],
  },
];

const SOUND = /<(chuckle|laugh|sigh|gasp|whispers|throat-clearing)>/g;
const JUDGE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } },
  required: ['ok', 'problems'],
};

type Check = { name: string; ok: boolean; detail: string };

function describePeople(context: ShowPromptContext): string {
  const lines = [`Listener: ${context.listener.name}, ${context.listener.gender}.`];
  if (context.spouse) {
    lines.push(`Spouse: ${context.spouse.name}, ${context.spouse.gender ?? 'gender unknown - must get name and neutral phrasing, never a gendered pronoun or verb'}.`);
  }
  for (const kid of context.kids) lines.push(`Child: ${kid.name}, ${kid.gender ?? 'gender unknown'}.`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const modelFlag = args.indexOf('--model');
  const modelId = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  // --lang en,ru runs only those languages' fixtures.
  const langFlag = args.indexOf('--lang');
  const langs = langFlag >= 0 ? args[langFlag + 1].split(',') : ['he', 'en', 'ru'];
  const outDirArg = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--model' && args[i - 1] !== '--lang')[0];

  // Production runs Flash TTS (admin setting); locally there is no admin setting.
  process.env.GEMINI_TTS_MODEL ||= 'gemini-3.8-flash-tts';
  // Synthesize here, not on a deployed tts-service.
  delete process.env.TTS_SERVICE_URL;
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

  // @hebcal/core is ESM-only (exports has only an "import" condition) and tsx loads src/
  // as CommonJS, so point require() at its ESM entry (Node 22+ can require ESM).
  const Module = (await import('module')).default as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };

  const { buildShowContext } = await import('../src/services/voice-show/context');
  const { writeShowScript } = await import('../src/services/voice-show/writer');
  const { toShowLines } = await import('../src/services/voice-show/script');
  const { generateShowVoice, getShowVoices } = await import('../src/services/voice-generator');
  const { generateAICompletion } = await import('../src/services/ai-provider');

  const outDir = outDirArg ?? 'eval-voice-show-out';
  await fs.mkdir(outDir, { recursive: true });
  const report: Array<{ name: string; checks: Check[] }> = [];
  let firstTurns: ShowTurn[] = [];
  let firstLanguage = 'he';

  for (const fixture of [...FIXTURES, ...FIXTURES_EN_RU].filter(f => langs.includes(f.language ?? 'he'))) {
    console.log(`\n=== ${fixture.name} ===`);
    const checks: Check[] = [];
    const language = fixture.language ?? 'he';
    const user = { id: 1, language, isAdmin: true, ...fixture.user } as unknown as UserConfig;
    const context = buildShowContext(fixture.summary, user, fixture.kind, fixture.isNextWeek);
    const record: Record<string, unknown> = { fixture: fixture.name, model: modelId ?? '(admin default)' };

    try {
      const written = await writeShowScript(context, { modelId });
      const turns = written.script.turns;
      if (!firstTurns.length) { firstTurns = turns; firstLanguage = language; }
      const text = turns.map(t => t.text).join('\n');
      const lower = text.toLowerCase();
      Object.assign(record, { attempts: written.attempts, warnings: written.script.warnings, turns, writerMs: written.completion.durationMs, writerUsage: written.completion.usage });

      const missing = fixture.facts.filter(group => !group.some(fact => lower.includes(fact.toLowerCase())));
      checks.push({ name: 'facts', ok: missing.length === 0, detail: missing.length ? `missing ${missing.map(g => g.join('|')).join(', ')}` : `${fixture.facts.length} groups found` });
      if (fixture.forbidden) {
        const present = fixture.forbidden.filter(word => lower.includes(word.toLowerCase()));
        checks.push({ name: 'forbidden', ok: present.length === 0, detail: present.length ? `contains ${present.join(', ')}` : `none of ${fixture.forbidden.join(', ')}` });
      }
      if (fixture.leads) {
        const { within, any } = fixture.leads;
        const opening = turns.slice(0, within).map(t => t.text).join('\n').toLowerCase();
        const found = any.filter(word => opening.includes(word.toLowerCase()));
        checks.push({ name: 'leads with', ok: found.length > 0, detail: found.length ? `${found.join(', ')} in the first ${within} turns` : `none of ${any.join('|')} in the first ${within} turns` });
      }
      checks.push({ name: 'no digits', ok: !/\d/.test(text), detail: (text.match(/\S*\d\S*/g) ?? []).join(' ') || 'none' });
      const sounds = text.match(SOUND) ?? [];
      checks.push({ name: 'sounds <= 2', ok: sounds.length <= 2, detail: sounds.join(' ') || 'none' });
      checks.push({ name: 'shape', ok: true, detail: `${turns.length} turns, ${new Set(turns.map(t => t.mood)).size} moods (${[...new Set(turns.map(t => t.mood))].join(', ')}), attempts ${written.attempts}` });

      const judge = await generateAICompletion(
        `You check a ${{ he: 'Hebrew', en: 'English', ru: 'Russian' }[language]} radio script for grammatical gender agreement.\n` +
        `The two hosts (A and B) are men and must speak of themselves in the masculine.\n${describePeople(context)}\n` +
        `Report every place where the listener is addressed with the wrong gender (second-person verbs, adjectives, pronouns), ` +
        `a family member is referred to with the wrong gender, a person of unknown gender is given one, or a host speaks of himself in the feminine. ` +
        `Return JSON {"ok": boolean, "problems": [string]}.\n\nScript:\n${turns.map(t => `${t.host}: ${t.text}`).join('\n')}`,
        modelId,
        { responseJsonSchema: JUDGE_SCHEMA },
      );
      const verdict = JSON.parse(judge.text) as { ok: boolean; problems: string[] };
      checks.push({ name: 'gender', ok: verdict.ok, detail: verdict.problems.join(' / ') || 'ok' });

      const lines = toShowLines(turns, language, context.listener.gender);
      const show = await generateShowVoice(lines, language);
      const [min, max] = fixture.seconds;
      checks.push({ name: 'length', ok: show.audioSeconds >= min && show.audioSeconds <= max, detail: `${show.audioSeconds.toFixed(1)}s (want ${min}-${max}), TTS ${(show.ttsMs / 1000).toFixed(1)}s, ${show.audioTokens} tokens, ${show.ttsModel}` });
      await fs.copyFile(show.filePath, path.join(outDir, `${fixture.name}.ogg`));
      await fs.unlink(show.filePath).catch(() => {});
      Object.assign(record, { lines, show: { ...show, filePath: undefined } });
    } catch (error) {
      checks.push({ name: 'run', ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }

    record.checks = checks;
    await fs.writeFile(path.join(outDir, `${fixture.name}.json`), JSON.stringify(record, null, 2));
    for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
    report.push({ name: fixture.name, checks });
  }

  // The tts-service endpoint, in-process, with the first fixture's opening lines.
  {
    console.log('\n=== tts-service /api/dialogue (in-process) ===');
    const endpointChecks: Check[] = [];
    try {
      if (!firstTurns.length) throw new Error('no script to send (every fixture failed)');
      process.env.TTS_API_KEY = 'eval-key';
      // Through a variable, so TypeScript does not follow it into tts-service: its
      // @vercel/node types are not installed for the app, and next build checks scripts/.
      const handlerPath = '../tts-service/api/dialogue';
      const { default: handler } = (await import(handlerPath)) as { default: (req: unknown, res: unknown) => Promise<void> };
      const { toShowLines } = await import('../src/services/voice-show/script');
      const out = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0), json: undefined as unknown };
      const res = {
        status(code: number) { out.status = code; return res; },
        json(value: unknown) { out.json = value; return res; },
        send(body: Buffer) { out.body = Buffer.from(body); return res; },
        setHeader(name: string, value: string) { out.headers[name] = String(value); return res; },
      };
      await handler({
        method: 'POST',
        headers: { authorization: 'Bearer eval-key' },
        body: { language: firstLanguage, model: 'gemini-3.8-flash-tts', voices: getShowVoices(firstLanguage), lines: toShowLines(firstTurns.slice(0, 4), firstLanguage, 'male') },
      } as never, res as never);
      const ok = out.status === 200 && out.body.subarray(0, 4).toString('ascii') === 'OggS' && Number(out.headers['X-TTS-Audio-Seconds']) > 0;
      endpointChecks.push({ name: 'endpoint', ok, detail: `status ${out.status}, ${out.headers['X-TTS-Audio-Seconds']}s, ${out.headers['X-TTS-Audio-Tokens']} tokens ${out.json ? JSON.stringify(out.json) : ''}` });
      if (out.status === 200) await fs.writeFile(path.join(outDir, 'endpoint.ogg'), out.body);
    } catch (error) {
      endpointChecks.push({ name: 'endpoint', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    for (const c of endpointChecks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
    report.push({ name: 'endpoint', checks: endpointChecks });
  }

  const failed = report.flatMap(r => r.checks.filter(c => !c.ok).map(c => `${r.name}/${c.name}`));
  console.log(`\n${failed.length ? `FAILED: ${failed.join(', ')}` : 'All checks passed'}  (output in ${outDir})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
