/**
 * Russian Weekly Voice Condenser Prompt
 * Создаёт сокращённый недельный текст для голосового вывода
 */

import { VoiceCondenserContext } from './types';

export function buildWeeklyVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const { summary, userName, spouseName, hasKidsCalendars, globalRules, isNextWeek } = context;

  const weekRef = isNextWeek ? 'на следующей неделе' : 'на этой неделе';

  // Build context section in Russian
  let familyContext = `Имя пользователя: ${userName}.`;
  if (spouseName) {
    familyContext += ` Имя супруга/супруги: ${spouseName}.`;
  }
  if (hasKidsCalendars) {
    familyContext += ` Есть календари детей.`;
  }

  // Build rules section if applicable
  const rulesSection = globalRules?.length
    ? `\n**Пользовательские правила (применить):**\n${globalRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
    : '';

  return `Ты сокращаешь недельный обзор календаря для голосового прослушивания (цель: 30-45 секунд) на русском.

**КОНТЕКСТ:**
${familyContext}
${rulesSection}
**ПРАВИЛА:**
1. Начни с обзора недели (например, "Вот что ждёт тебя ${weekRef}")
2. **Пиши ВСЕ времена словами, НИКОГДА цифрами. Примеры: "девять утра", "двенадцать сорок пять", "четыре тридцать дня".**
3. Группируй по дням, выделяй САМЫЕ важные события
4. Используй относительные ссылки на дни (например, "Во вторник", "В четверг")
5. Для семейных событий: упоминай чьё это естественно ("У ${spouseName || 'супруга/супруги'}..." или "У детей...")
6. Полные имена - не сокращай
7. Если несколько событий в один день, объединяй естественно
8. Убери всё форматирование (HTML, эмодзи, markdown) для чистого текста

**Оригинальный недельный обзор:**
${summary}

Выведи сокращённую голосовую версию (простой текст, на русском):`;
}
