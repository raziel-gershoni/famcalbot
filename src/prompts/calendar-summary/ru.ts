/**
 * Russian Calendar Summary Prompt
 * Все инструкции на русском языке для естественного понимания правил
 */

import { SummaryPromptData } from './types';

function buildSpouseContext(data: SummaryPromptData): string {
  if (!data.spouseName) return '';

  return `
2. **События супруга/супруги** - Это события супруга/супруги
   - При обращении по имени используйте: ${data.spouseName}
   - Персонализируйте с точки зрения пользователя (например: "У ${data.spouseName} встреча в...")
`;
}

function buildKidsContext(data: SummaryPromptData): string {
  if (!data.hasKidsCalendars) {
    return `
3. **Другие события** - Общие семейные события и другие календари
   - Включите их в раздел "Другие события", если они есть
`;
  }

  return `
3. **Другие события** - События детей и семейные события
   - **Определяйте имена детей из названий календарей или содержания событий** (например: если календарь называется "Шира" или событие "Стоматолог Ширы", ребёнка зовут Шира)
   - **ВАЖНО: Не путайте названия мест с именами людей**
   - Пример: Место, заканчивающееся на "детский сад" или "сад" - это МЕСТО, а не имя человека
   - **В порядке забора: используйте имя ребёнка, затем место в скобках**
`;
}

function buildHebrewDateContext(data: SummaryPromptData): string {
  if (data.culture !== 'jewish') return '';

  return `
## Еврейский календарь
- Включите еврейскую дату в заголовок сводки
- Еврейская дата: ${data.summaryHebrewDate}
- ${data.isRoshChodesh ? 'СЕГОДНЯ РОШ ХОДЕШ - упомяните это в заголовке' : ''}
- Отображайте еврейскую дату стандартными цифрами (например: "28 Кислев 5785")
`;
}

function buildGlobalRules(data: SummaryPromptData): string {
  if (!data.globalRules || data.globalRules.length === 0) return '';

  const rules = data.globalRules
    .filter(r => r.trim())
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');

  if (!rules) return '';

  return `
## Пользовательские правила (ВСЕГДА применяйте)
${rules}
`;
}

function buildCalendarRules(data: SummaryPromptData): string {
  if (!data.calendarRules || data.calendarRules.length === 0) return '';

  const rules = data.calendarRules
    .filter(r => r.rule?.trim())
    .map(r => `- **${r.calendarName}**: ${r.rule}`)
    .join('\n');

  if (!rules) return '';

  return `
## Правила для конкретных календарей
${rules}
`;
}

function buildDateInfo(data: SummaryPromptData): string {
  let dateInfo = `**ИНФОРМАЦИЯ О ДАТАХ:**
- Текущая дата (сегодня): ${data.currentGregorianDate}
- Дата сводки: ${data.summaryGregorianDate}`;

  if (data.culture === 'jewish') {
    dateInfo += `
- Еврейская дата (сводка): ${data.summaryHebrewDate}
- Рош Ходеш: ${data.isRoshChodesh ? 'ДА' : 'НЕТ'}`;
  }

  return dateInfo;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
  const kidsContext = buildKidsContext(data);
  const hebrewDateContext = buildHebrewDateContext(data);
  const globalRules = buildGlobalRules(data);
  const calendarRules = buildCalendarRules(data);
  const dateInfo = buildDateInfo(data);

  const genderRu = data.userGender === 'male' ? 'мужской род' : 'женский род';
  const spouseGenderRu = data.spouseGender === 'male' ? 'мужской род' : 'женский род';

  const spouseNameLine = data.spouseName
    ? `- Супруг/супруга: ${data.spouseName} (${spouseGenderRu} - используйте соответствующие грамматические формы)`
    : '';

  const spouseScheduleHeader = data.spouseName
    ? `<b>Расписание ${data.spouseEnglishName || data.spouseName}:</b> [Только если у ${data.spouseName} есть события]
- HH:MM-HH:MM - [Активность/Работа] ([Место, если есть])
[Хронологический порядок по времени начала, включайте место когда есть]

`
    : '';

  const kidsScheduleSection = data.hasKidsCalendars
    ? `<b>Время начала для детей:</b>
- HH:MM - [Имя1] ([Место1]), [Имя2] ([Место2])
[Группируйте детей с одинаковым временем начала в одну строку, сортировка по времени]

<b>Особые события:</b> [Только если у детей есть особые события в течение дня]
- HH:MM-HH:MM - [Имя] [Активность] ([Место])

<b>Порядок забора:</b> [ТОЛЬКО ДЕТИ - НЕ включайте супруга/супругу]

**КРИТИЧНО: ВСЕ дети ДОЛЖНЫ появиться в этом разделе - НЕ помещайте заборы детей в раздел примечаний!**

**АЛГОРИТМ:**
1. Извлеките ВСЕ времена окончания забора детей из событий (каждый ребёнок должен быть включён)
2. Отсортируйте времена по возрастанию (например: 13:50 < 14:00 < 16:00)
3. Для каждого временного слота (в отсортированном порядке) перечислите всех детей с этим временем в одной строке
4. Выводите в отсортированном порядке
5. НЕ пропускайте детей - ВСЕ должны быть в списке

- HH:MM - [Имя] ([Место])
- HH:MM - [Имя1] ([Место1]), [Имя2] ([Место2])

`
    : '';

  const insightSection = data.hasKidsCalendars
    ? `<b>Наблюдение:</b> [ОДНО краткое предложение (максимум 10-15 слов) с полезным наблюдением, например:]
- Логистика забора: Кто свободен исходя из рабочего расписания
- Непрерывное пребывание: Если у ребёнка подряд события в одном месте
- Конфликты: Если заборы пересекаются или время ограничено
- ПРОПУСТИТЕ этот раздел, если нет значимых наблюдений

`
    : '';

  const spouseEventsSection = data.spouseName && data.spouseEventsText
    ? `**СОБЫТИЯ СУПРУГА/СУПРУГИ:**
${data.spouseEventsText}

`
    : '';

  const otherEventsHeader = data.hasKidsCalendars
    ? '**ДРУГИЕ СОБЫТИЯ (Дети и семья):**'
    : '**ДРУГИЕ СОБЫТИЯ:**';

  return `# Сводка календаря для ${data.userName}

Создайте персонализированную сводку расписания на день на русском языке.

**ВАЖНО: Имена и грамматика:**
- Пользователь: ${data.userName} (${genderRu} - используйте соответствующие грамматические формы)
${spouseNameLine}

## Категории событий и персонализация
События предварительно разделены на группы:

1. **Ваши события** - Это ВАШИ события (личные и рабочие календари)
   - Обращайтесь к ним как "У вас..." или "Ваш/Ваша..."
   - При упоминании по имени используйте: ${data.userName}
${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}${calendarRules}
## Формат вывода
**ВАЖНО: Пишите ВСЁ на русском языке.**

<b>${data.greeting}</b>

<b>[МЕТКА ДНЯ] - [День], [Григорианская дата]${data.culture === 'jewish' ? ' ([Еврейская дата])' : ''}</b>
(Сравните текущую дату с датой сводки, используйте подходящую метку)

<b>Ваше расписание:</b> [Только если у ${data.userName} есть события]
- HH:MM-HH:MM - [Активность] ([Место, если есть])
[Хронологический порядок по времени начала, включайте место когда есть]

${spouseScheduleHeader}${kidsScheduleSection}${insightSection}<b>Погода:</b> [ТОЛЬКО если ниже предоставлены данные о погоде]
**Создайте содержательную, практичную сводку погоды (2-4 предложения), интегрированную с расписанием дня:**

СТРУКТУРА:
1. Текущие условия и обзор дня (диапазон температур, условия)
2. **КРИТИЧНО: Если ожидается дождь, укажите КОНКРЕТНЫЕ часы (например: "Дождь 14:00-18:00")**
3. Практические рекомендации с учётом времени событий

**Будьте конкретны по времени и температурам. Соотнесите погоду с событиями расписания. Сделайте это полезным для планирования дня.**

## Рекомендации
- **КРИТИЧНО: ВСЁ должно быть на русском языке**
- **КРИТИЧНО: Всегда используйте формат HH:MM (24 часа, без AM/PM) - например: 08:00, 13:45, 20:15**
${data.hasKidsCalendars ? `- **КРИТИЧНО: Порядок забора ДОЛЖЕН быть отсортирован хронологически (сначала самое раннее время)**
- **КРИТИЧНО: Порядок забора: Группируйте детей с ОДИНАКОВЫМ временем забора в ОДНУ строку**
` : ''}- Используйте HTML-теги Telegram для форматирования: <b>жирный</b>, <i>курсив</i>, <u>подчёркнутый</u>

---

${dateInfo}

**СОБЫТИЯ ${data.userName}:**
${data.userEventsText}

${spouseEventsSection}${otherEventsHeader}
${data.otherEventsText}
${data.weatherSummary ? `
**ИНФОРМАЦИЯ О ПОГОДЕ:**
${data.weatherSummary}` : ''}

**КРИТИЧНО: Отвечайте только на русском языке. Напишите всю сводку на русском.**`;
}
