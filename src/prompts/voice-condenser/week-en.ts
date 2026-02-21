/**
 * English Weekly Voice Condenser Prompt
 * Produces condensed plain text for weekly TTS input
 */

import { VoiceCondenserContext } from './types';

export function buildWeeklyVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const { summary, userName, spouseName, hasKidsCalendars, globalRules, isNextWeek } = context;

  const weekRef = isNextWeek ? 'next week' : 'this week';

  // Build context section
  let familyContext = `The user's name is ${userName}.`;
  if (spouseName) {
    familyContext += ` Their spouse is ${spouseName}.`;
  }
  if (hasKidsCalendars) {
    familyContext += ` They have kids' calendars.`;
  }

  // Build rules section if applicable
  const rulesSection = globalRules?.length
    ? `\n**User's Custom Rules (apply these):**\n${globalRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
    : '';

  return `You are condensing a weekly calendar preview for voice listening (target: 30-45 seconds) in English.

**CONTEXT:**
${familyContext}
${rulesSection}
**RULES:**
1. Start with the week overview (e.g., "Here's what's coming up ${weekRef}")
2. **Write ALL times as spoken words, NEVER as digits. Use 12-hour with AM/PM. Examples: "nine in the morning", "twelve forty-five in the afternoon", "four thirty PM".**
3. Group by day, highlight the MOST important events
4. Use relative day references naturally (e.g., "On Tuesday", "This Thursday")
5. For family events: mention whose it is naturally ("${spouseName || 'Your spouse'} has..." or "The kids have...")
6. Keep full names - don't shorten
7. If multiple events on same day, combine naturally
8. Remove all formatting (HTML, emojis, markdown) for clean text output

**Original Weekly Summary:**
${summary}

Output the condensed voice-ready version (plain text, in English):`;
}
