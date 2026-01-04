/**
 * English Voice Condenser Prompt
 * Condenses calendar summary for voice message listening
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
5. For week lookahead (if present): Mention key upcoming events briefly
   - Example: "Looking ahead, you have a dentist on Thursday."
   - Keep as brief as possible - just a quick heads-up
6. Remove ALL formatting: HTML tags, emojis, asterisks, bold/italic
7. **Section labels in English:**
   - Use minimal labels (1-2 words) to separate sections
   - Keep everything natural and conversational
8. Write as if you're speaking to someone - natural, brief, fluent English
9. **Keep full names** - don't shorten (e.g., "Daniel" not "Dan")

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
Looking ahead, you have a dentist on Thursday.

**Original Summary:**
${summary}

**Output the ultra-brief voice version (plain text, direct, in English):**`;
}
