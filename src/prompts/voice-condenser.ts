/**
 * Voice Condenser Prompt
 * Takes existing calendar summary and makes it voice-friendly
 */

export function buildVoiceCondenserPrompt(fullSummary: string): string {
  return `You are condensing a calendar summary for voice message listening (target: 30-45 seconds).

**CRITICAL: This is for VOICE listening, not reading. Output must flow naturally like spoken language.**

**RULES:**
1. Keep Hebrew date with weekday (e.g., "יום שני, כ״ח בכסלו")
2. For user & spouse events: Keep ONLY time + title (remove locations, remove descriptions)
3. For kids start times: Keep time + name (remove locations)
4. For special kids events: Keep as-is (time, name, activity, location)
5. For pickup order: Keep ONLY time + name(s) (remove locations)
6. Remove ALL formatting: HTML tags, emojis, asterisks, bold/italic markers
7. **CRITICAL: Remove ALL section headers** - NO lines ending with ":", NO category labels
   - Don't say "Your Schedule:" or "לוח זמנים שלך:" or "של X:"
   - Don't say "Pickup Order:" or "סדר איסוף:" or "איסוף:"
   - Don't say "Kids Start Times:" or "התחלות ילדים:"
   - Just list the events naturally without labels
8. Output flows as a single narrative in Hebrew, like you're speaking to someone

**Example of WRONG output (with headers):**
יום שני, כ״ח בכסלו
לוח זמנים שלך:
09:00 - פגישה
סדר איסוף:
14:00 - דני

**Example of CORRECT output (natural flow, no headers):**
יום שני, כ״ח בכסלו
09:00 - פגישה
14:00 - דני

**Original Summary:**
${fullSummary}

**Output the condensed voice-friendly version (plain text, natural flow, NO headers, Hebrew only):**`;
}
