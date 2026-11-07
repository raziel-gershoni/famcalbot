/**
 * English calm prompt: one calm, warm presenter reads what the two-host show covers (spec
 * docs/superpowers/specs/2026-11-07-calm-voice-design.md). The kind's content, the family lines, the facts rules and
 * the personal address are the show's own (./en.ts); only the energy lines and the shape are calm's.
 */

import { sanitizeForPrompt } from '../shared-builders';
import { buildRulesSection } from '../voice-condenser/template';
import { addressRule, factRules, familyLines, kindRules } from './en';
import type { ShowPromptContext } from './types';

export function buildCalmPrompt(context: ShowPromptContext): string {
  const { goal, content, length, turns: [minParagraphs, maxParagraphs] } = kindRules(context, 'calm');
  const listener = sanitizeForPrompt(context.listener.name);
  const rules = buildRulesSection(context.globalRules, "The user's own rules (apply these):");

  const allContent = [
    ...content,
    ...factRules(context),
    'The calm tone never adds or drops facts: no events, times, names or details that are not in the summary.',
  ];

  return `You are writing a short English text to be read aloud about ${goal}: one calm, warm radio presenter reading the summary.

**The family:**
${familyLines(context).join('\n')}
${rules}
**The presenter:**
- One presenter, ${context.presenterGender === 'female' ? 'a woman' : 'a man'}, with no name; don't invent one.
- One voice only: no dialogue, no second host, and no one is addressed but ${listener}.

**Content (required):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**Style:**
- Calm, warm and unhurried, at the even pace of quiet morning radio. No excitement, no exclamations like "Let's go!" or "What a day!", no jokes and no sports images.
- Talk naturally, with contractions ("it's", "here's", "you've got").
- ${addressRule(context)}
- Paragraphs: one to three sentences each, one topic per paragraph (the opening and the date, the weather, the events, the week ahead, the close).
- Length: ${length}
- A short opening and a short, quiet close.

**No sounds and no tags:**
- No sounds like <laugh> or <sigh>, and no other tags at all: no HTML, no emoji, no markdown, no stage directions like (smiles) or *softly*.
- Don't write "A:" or "B:" inside the text.

**Output:** JSON only, ${minParagraphs} to ${maxParagraphs} paragraphs:
{"turns":[{"text":"..."},{"text":"..."}]}

**The original summary (with formatting — ignore the formatting):**
${context.summary}`;
}
