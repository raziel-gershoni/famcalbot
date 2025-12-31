/**
 * English Voice Condenser Prompt
 * Condenses calendar summary for voice message listening
 */

import { VoiceCondenserContext } from './types';

export function buildVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const { summary, userName, spouseName, hasKidsCalendars, globalRules } = context;

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

  return `You are condensing a calendar summary for voice message listening (target: 30-45 seconds) in English.

**CONTEXT:**
${familyContext}
${rulesSection}
**CRITICAL: This is for VOICE listening - make it sound NATURAL and FLUENT like human speech, not robotic. Be brief but conversational.**

**RULES:**
1. Keep ONLY date with weekday
2. **IMPORTANT: Weather comes IMMEDIATELY after date, BEFORE schedule**
   - Write as natural, flowing sentences (smooth and conversational, NOT choppy)
   - Include conditions, timing, and practical tip naturally
   - Example: "It'll rain in the afternoon, so bring an umbrella" NOT "Rain afternoon, bring umbrella"
3. For schedule items: Write as brief but natural sentences
   - Use natural connectors and flow
   - Example: "You have a meeting at 09:00" NOT "09:00 meeting"
4. For kids: Keep brief but natural
   - Example: "Pick up Danny at 14:00" NOT "14:00 Danny"
5. Remove ALL formatting: HTML tags, emojis, asterisks, bold/italic
6. **Section labels in English:**
   - Use minimal labels (1-2 words) to separate sections
   - Keep everything natural and conversational
7. Write as if you're speaking to someone - natural, brief, fluent English
8. **Keep full names** - don't shorten (e.g., "Daniel" not "Dan")

**Example of WRONG output (robotic and choppy):**
Monday, December 28
Weather: Rain afternoon, bring umbrella
For you: 09:00 meeting
Pickup: 14:00 Danny

**Example of CORRECT output (natural and fluent):**
Monday, December 28
It'll rain in the afternoon, so bring an umbrella.
You have a meeting at 09:00.
Pick up Danny at 14:00.

**Original Summary:**
${summary}

**Output the ultra-brief voice version (plain text, direct, in English):**`;
}
