/**
 * English Weekly Voice Condenser Prompt
 * Condenses week lookahead for voice message listening
 */

import { VoiceCondenserContext } from './types';

export function buildWeeklyVoiceCondenserPrompt(context: VoiceCondenserContext): string {
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

  return `You are condensing a WEEKLY calendar preview for voice message listening (target: 30-45 seconds) in English.

**CONTEXT:**
${familyContext}
${rulesSection}
**CRITICAL: This is for VOICE listening - make it sound NATURAL and FLUENT like human speech, not robotic. Be brief but conversational.**

**RULES:**
1. Start with the week overview (e.g., "Here's what's coming up this week" or "Looking ahead to next week")
2. Group by day, but keep it conversational - don't just list times robotically
3. Highlight the MOST important events - not every detail
   - Focus on appointments, meetings, deadlines, special events
   - Skip routine recurring events unless notable
4. Use relative day references naturally (e.g., "On Tuesday", "This Thursday", "Sunday")
5. For family events: mention whose it is naturally
   - "${spouseName || 'Your spouse'} has..." or "The kids have..."
6. Remove ALL formatting: HTML tags, emojis, asterisks, bold/italic
7. Write as if briefing someone verbally - natural, flowing English
8. **Keep full names** - don't shorten (e.g., "Daniel" not "Dan")
9. If multiple events on same day, combine naturally

**Example of WRONG output (robotic and choppy):**
Week overview
Monday: 09:00 meeting, 14:00 dentist
Tuesday: Kids school event
Wednesday: Nothing
Thursday: 10:00 call

**Example of CORRECT output (natural and fluent):**
Looking ahead at your week. Monday you have a meeting in the morning and a dentist appointment at 14:00. Tuesday the kids have a school event. Thursday there's a call at 10:00.

**Original Weekly Summary:**
${summary}

**Output the condensed voice version (plain text, natural speech, in English):**`;
}
