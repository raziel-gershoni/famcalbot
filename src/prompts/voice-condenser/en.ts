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
2. **Write ALL times as spoken words, NEVER as digits. Use 12-hour with AM/PM. Examples: "nine in the morning", "twelve forty-five in the afternoon", "four thirty PM".**
3. **Weather comes IMMEDIATELY after date, BEFORE schedule.** Condense to 1-2 natural sentences with a practical tip.
4. Schedule items: Brief but natural sentences (e.g., "You have a meeting at nine in the morning")
5. Kids: Keep brief but natural (e.g., "Pick up Danny at two in the afternoon")
6. Week lookahead (if present): Mention key upcoming events briefly
7. Keep full names - don't shorten
8. Remove all formatting (HTML, emojis, markdown) for clean text output

**Original Summary:**
${summary}

Output the condensed voice-ready version (plain text, in English):`;
}
