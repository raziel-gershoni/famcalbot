/**
 * Russian Voice Condenser Prompt
 * Создаёт сокращённый текст для голосового вывода
 */

import { VoiceCondenserContext } from './types';
import { buildFamilyContext, buildRulesSection } from './template';

export function buildVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const { summary, userName, spouseName, hasKidsCalendars, globalRules } = context;

  const familyContext = buildFamilyContext(userName, spouseName, hasKidsCalendars, {
    userName: "Имя пользователя:",
    spouseLabel: "Имя супруга/супруги:",
    kidsLabel: "Есть календари детей."
  });

  const rulesSection = buildRulesSection(globalRules, "Пользовательские правила (применить):");

  return `Ты сокращаешь сводку календаря для голосового прослушивания (цель: 30-45 секунд) на русском.

**КОНТЕКСТ:**
${familyContext}
${rulesSection}
**ПРАВИЛА:**
1. Оставь дату с днём недели
2. Читай ВСЕ времена и даты ТОЧНО как написано - не округляй и не аппроксимируй
3. Погода: Сократи до 1-2 предложений, всегда включай практический совет (например, "возьми зонт")
4. Пункты расписания: Краткие, но естественные предложения (например, "У тебя встреча в 09:00")
5. Дети: Кратко, но естественно (например, "Забрать Даню в 14:00")
6. Обзор недели (если есть): Кратко упомяни ключевые предстоящие события
7. Полные имена - не сокращай
8. Убери всё форматирование (HTML, эмодзи, markdown) для чистого текста

**Оригинальная сводка:**
${summary}

Выведи сокращённую голосовую версию (простой текст, на русском):`;
}
