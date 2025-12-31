/**
 * Russian Week Lookahead Prompt
 */

import { WeekLookaheadPromptData, LookaheadDayData } from './types';

function buildSpouseContext(data: WeekLookaheadPromptData): string {
  if (!data.hasSpouseCalendar) return '';

  const spouseLabel = data.spouseName || 'супруг(а)';
  return `
- **События супруга**: Принадлежат ${spouseLabel} - упоминайте как "У ${spouseLabel}..." или "из календаря ${spouseLabel}"`;
}

function buildKidsContext(data: WeekLookaheadPromptData): string {
  if (!data.hasKidsCalendars) return '';

  return `
- **События детей**: Определяйте детей по названию календаря или содержанию события - упоминайте как "У [имя ребёнка]..."`;
}

function buildHebrewDateContext(data: WeekLookaheadPromptData): string {
  if (data.culture !== 'jewish') return '';

  return `
## Еврейский календарь
- Включайте еврейские даты рядом с григорианскими
- Сегодня: ${data.todayHebrew}
- Конец недели: ${data.weekEndHebrew}`;
}

function buildGlobalRules(data: WeekLookaheadPromptData): string {
  if (!data.globalRules || data.globalRules.length === 0) return '';

  const rules = data.globalRules
    .filter(r => r.trim())
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');

  if (!rules) return '';

  return `
## Пользовательские правила (Применять при необходимости)
${rules}`;
}

function formatEventsForDay(day: LookaheadDayData): string {
  const lines = day.events.map(event => {
    const recurNote = event.isRecurring && event.recurrenceType
      ? ` [${event.recurrenceType === 'monthly' ? 'ежемесячно' : event.recurrenceType === 'yearly' ? 'ежегодно' : 'еженедельно'}]`
      : '';
    return `  - ${event.time} - ${event.summary} (${event.calendarName})${recurNote}`;
  });
  return lines.join('\n');
}

function buildEventsSection(data: WeekLookaheadPromptData): string {
  if (data.eventsByDay.length === 0) {
    return `**СОБЫТИЯ:**
Нет примечательных событий на этот период.`;
  }

  const days = data.eventsByDay.map(day => {
    const hebrewPart = day.hebrewDate ? ` (${day.hebrewDate})` : '';
    return `**${day.dayLabel}${hebrewPart}** - ${day.relativeLabel}
${formatEventsForDay(day)}`;
  });

  return `**СОБЫТИЯ ПО ДНЯМ:**

${days.join('\n\n')}`;
}

export function buildWeekLookaheadPrompt(data: WeekLookaheadPromptData): string {
  const spouseContext = buildSpouseContext(data);
  const kidsContext = buildKidsContext(data);
  const hebrewDateContext = buildHebrewDateContext(data);
  const globalRules = buildGlobalRules(data);
  const eventsSection = buildEventsSection(data);

  const hebrewRange = data.culture === 'jewish' && data.todayHebrew && data.weekEndHebrew
    ? `\nЕврейский: ${data.todayHebrew} - ${data.weekEndHebrew}`
    : '';

  return `# Обзор недели для ${data.userName}

Создай краткий обзор предстоящей недели на русском языке.

## Период недели
С: ${data.todayGregorian}
До: ${data.weekEndGregorian}${hebrewRange}
Всего: ${data.totalEvents} событий за ${data.totalDays} дней

## Принадлежность календарей
При упоминании событий всегда указывай, чей это календарь:
- **Твои события**: Это события ${data.userName} - говори "У тебя..." или "Твоё [событие]"${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}
## Формат вывода
Создай дружелюбный, разговорный обзор. Структура:

<b>Неделя вперёд</b>
<b>${data.todayGregorian} - ${data.weekEndGregorian}</b>${data.culture === 'jewish' ? `
<i>${data.todayHebrew} - ${data.weekEndHebrew}</i>` : ''}

[Для каждого дня с событиями создай краткую сводку с:]
- Днём и датой (с относительной ссылкой типа "Завтра" или "Через 3 дня")
- Ключевыми событиями со временем в формате HH:MM
- Источником календаря для каждого события
- Отметкой повторяющихся событий (ежемесячные проверки, ежегодные продления)

[Заверши кратким напоминанием о событиях, требующих подготовки]

## Рекомендации
- **Будь разговорным, но кратким** - это быстрый обзор, не детальная сводка
- **Всегда указывай источник календаря** - например, "из твоего рабочего календаря", "из календаря ${data.spouseName || 'супруга'}", "из календаря [ребёнка]"
- **Используй относительные ссылки** - "Завтра", "Через 3 дня" наряду с датами
- **Выделяй повторяющиеся события** - если что-то ежемесячное/ежегодное, отметь это
- **Формат времени**: Всегда используй HH:MM (24-часовой) - например, 08:00, 14:30
- **Форматирование**: Используй HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>
- **Если нет событий**: Будь краток - просто отметь, что неделя свободна

---

${eventsSection}

**ВАЖНО: Отвечай только на русском языке. Будь кратким и разговорным.**`;
}
