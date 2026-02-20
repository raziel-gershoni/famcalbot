/**
 * English Voice Condenser Prompt
 * Produces condensed plain text for TTS input
 */

import { VoiceCondenserContext } from './types';
import { buildFamilyContext, buildRulesSection } from './template';

export function buildVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const { summary, userName, spouseName, hasKidsCalendars, globalRules } = context;

  const familyContext = buildFamilyContext(userName, spouseName, hasKidsCalendars, {
    userName: "The user's name is",
    spouseLabel: "Their spouse is",
    kidsLabel: "They have kids' calendars."
  });

  const rulesSection = buildRulesSection(globalRules, "User's Custom Rules (apply these):");

  return `You are condensing a calendar summary for voice listening (target: 30-45 seconds) in English.

**CONTEXT:**
${familyContext}
${rulesSection}
**RULES:**
1. Keep date with weekday
2. Read ALL times and dates EXACTLY as written - never round or approximate
3. Weather: Condense to 1-2 sentences, always include a practical tip (e.g., "bring an umbrella")
4. Schedule items: Brief but natural sentences (e.g., "You have a meeting at 09:00")
5. Kids: Keep brief but natural (e.g., "Pick up Danny at 14:00")
6. Week lookahead (if present): Mention key upcoming events briefly
7. Keep full names - don't shorten
8. Remove all formatting (HTML, emojis, markdown) for clean text output

**Original Summary:**
${summary}

Output the condensed voice-ready version (plain text, in English):`;
}
