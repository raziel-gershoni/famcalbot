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
2. **Пиши ВСЕ времена словами, НИКОГДА цифрами. Примеры: "девять утра", "двенадцать сорок пять", "четыре тридцать дня".**
3. **Погода идёт СРАЗУ после даты, ПЕРЕД расписанием.** Сократи до 1-2 естественных предложений с практическим советом.
4. Пункты расписания: Краткие, но естественные предложения (например, "У тебя встреча в девять утра")
5. Дети: Кратко, но естественно (например, "Забрать Даню в два часа дня")
6. Обзор недели (если есть): Кратко упомяни ключевые предстоящие события
7. Полные имена - не сокращай
8. Убери всё форматирование (HTML, эмодзи, markdown) для чистого текста

**Оригинальная сводка:**
${summary}

Выведи сокращённую голосовую версию (простой текст, на русском):`;
}
