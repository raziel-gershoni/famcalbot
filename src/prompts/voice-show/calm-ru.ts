/**
 * Russian calm prompt: one calm, warm presenter reads what the two-host show covers (spec
 * docs/superpowers/specs/2026-11-07-calm-voice-design.md). The kind's content, the family lines (with "ты" and the
 * unknown-gender rule), the facts rules and the personal address are the show's own (./ru.ts); only the energy
 * lines and the shape are calm's. The presenter's gender sets how they speak of themself.
 */

import { buildRulesSection } from '../voice-condenser/template';
import { addressRule, factRules, familyLines, kindRules } from './ru';
import type { ShowPromptContext } from './types';

export function buildCalmPrompt(context: ShowPromptContext): string {
  const woman = context.presenterGender === 'female';
  const listener = context.listener.gender === 'female' ? 'слушательницы' : 'слушателя';
  const { goal, content, length, turns: [minParagraphs, maxParagraphs] } = kindRules(context, 'calm');
  const rules = buildRulesSection(context.globalRules, 'Личные правила пользователя (применить):');

  const allContent = [
    ...content,
    ...factRules(context),
    'Спокойный тон не добавляет и не убирает факты: никаких событий, времени, имён или деталей, которых нет в сводке.',
  ];

  return `Вы пишете короткий текст для чтения вслух на русском. Тема: ${goal}. Читает ${woman ? 'одна ведущая' : 'один ведущий'} спокойной радиопрограммы, тепло и неторопливо.

**Семья:**
${familyLines(context).join('\n')}
${rules}
**${woman ? 'Ведущая' : 'Ведущий'}:**
- ${woman ? 'Одна ведущая, женщина, говорит о себе в женском роде. Имени у неё нет, не придумывайте.' : 'Один ведущий, мужчина, говорит о себе в мужском роде. Имени у него нет, не придумывайте.'}
- Голос один: без диалога, без второго ведущего и без обращений к кому-либо, кроме ${listener}.

**Содержание (обязательно):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**Стиль:**
- Спокойно, тепло и неторопливо, в ровном темпе спокойного радио. Без азарта, без восклицаний вроде "Поехали!" или "Вот это день!", без шуток и без спортивных образов.
- ${addressRule(context)}
- Абзацы: в каждом от одного до трёх предложений, не длиннее примерно 350 знаков, на одну тему (начало и дата, погода, события, взгляд на неделю, финал). Если событий много, раскладывайте их по нескольким абзацам, по одному-два в каждом, а не все в одном.
- Длина: ${length}
- Короткое начало и короткий спокойный финал.

**Без звуков и без тегов:**
- Никаких звуков вроде <laugh> или <sigh> и никаких других тегов: ни HTML, ни эмодзи, ни markdown, ни ремарок вроде (улыбается) или *тихо*.
- Не пишите "A:" или "B:" внутри текста.

**Вывод:** только JSON, от ${minParagraphs} до ${maxParagraphs} абзацев:
{"turns":[{"text":"..."},{"text":"..."}]}

**Исходная сводка (с форматированием — игнорируйте форматирование):**
${context.summary}`;
}
