/**
 * Russian Week Lookahead Prompt
 */

import { WeekLookaheadPromptData, LookaheadDayData } from './types';
import { buildGlobalRulesSection } from '../shared-builders';

function buildSpouseContext(data: WeekLookaheadPromptData): string {
  if (!data.hasSpouseCalendar) return '';

  const spouseLabel = data.spouseName || 'супруг(а)';
  return `
- **События супруга**: Принадлежат ${spouseLabel} - упоминайте как "У ${spouseLabel}..." (не добавляйте "из календаря" - это уже понятно из контекста)`;
}

function buildKidsContext(data: WeekLookaheadPromptData): string {
  if (!data.hasKidsCalendars) return '';

  return `
- **События детей**: События с названием календаря начинающимся с "Child:" принадлежат этому ребёнку
- **КРИТИЧНО: Название события — это ПОЛНОЕ название учреждения/события — используйте как есть.** Например: "Тала Ган Гилад середина года" → "мероприятие середины года в Тала Ган Гилад" (НЕ "мероприятие в саду")`;
}

function buildHebrewDateContext(data: WeekLookaheadPromptData): string {
  if (data.culture !== 'jewish') return '';

  // Use weekStartHebrew for next week summaries, todayHebrew for regular lookahead
  const startHebrew = data.weekStartHebrew || data.todayHebrew;
  return `
## Еврейский календарь
- Включайте еврейские даты рядом с григорианскими
- Начало недели: ${startHebrew}
- Конец недели: ${data.weekEndHebrew}`;
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
  const globalRules = buildGlobalRulesSection(data.globalRules, '## Пользовательские правила (Применять при необходимости)');
  const eventsSection = buildEventsSection(data);

  // Use weekStartGregorian for next week summaries, todayGregorian for regular lookahead
  const rangeStart = data.weekStartGregorian || data.todayGregorian;
  const rangeStartHebrew = data.weekStartHebrew || data.todayHebrew;
  const isNextWeek = !!data.weekStartGregorian;
  const title = isNextWeek ? 'Обзор следующей недели' : 'Обзор недели';
  const headerTitle = isNextWeek ? 'Следующая неделя' : 'Неделя вперёд';

  return `# ${title} для ${data.userName}

Создай краткий обзор ${isNextWeek ? 'следующей недели' : 'предстоящей недели'} на русском языке.
${isNextWeek ? `\n**ВАЖНО**: Это расписание на СЛЕДУЮЩУЮ неделю (${rangeStart} - ${data.weekEndGregorian}), НЕ текущую неделю. Сегодня ${data.todayGregorian}.\n` : ''}
## Период недели
С: ${rangeStart} до ${data.weekEndGregorian}
Всего: ${data.totalEvents} событий за ${data.totalDays} дней

## Принадлежность календарей
При упоминании событий всегда указывай, чей это календарь:
- **Твои события**: Это события ${data.userName} - говори "У тебя..." или "Твоё [событие]"${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}
## Формат вывода
Создай дружелюбный, разговорный обзор. Структура:

<b>${headerTitle}</b>
<b>${rangeStart} - ${data.weekEndGregorian}</b>${data.culture === 'jewish' ? `
<i>${rangeStartHebrew} - ${data.weekEndHebrew}</i>` : ''}

[Для каждого дня с событиями создай краткую сводку с:]
- Днём и датой
- Ключевыми событиями со временем в формате HH:MM
- Источником календаря для каждого события
- Отметкой повторяющихся событий (ежемесячные проверки, ежегодные продления)

[Заверши кратким напоминанием о событиях, требующих подготовки]

## Рекомендации
- **Будь разговорным, но кратким** - это быстрый обзор, не детальная сводка
- **Атрибуция календаря** - Для твоих событий указывай источник (например, "из твоего рабочего календаря"). Для супруга/детей имя уже подразумевает источник - не повторяй.
- **Выделяй повторяющиеся события** - если что-то ежемесячное/ежегодное, отметь это
- **Формат времени**: Всегда используй HH:MM (24-часовой) - например, 08:00, 14:30
- **Форматирование**: Используй HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>
- **Если нет событий**: Будь краток - просто отметь, что неделя свободна
${isNextWeek ? '- **НЕ говори "сегодня"** - называй дни по их названиям (понедельник, вторник и т.д.)' : '- **Используй относительные ссылки** - "Завтра", "Через 3 дня" наряду с датами'}

---

${eventsSection}

**ВАЖНО: Отвечай только на русском языке. Будь кратким и разговорным.**`;
}
