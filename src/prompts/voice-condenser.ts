/**
 * Voice Condenser Prompt
 * Takes existing calendar summary and makes it voice-friendly
 */

export function buildVoiceCondenserPrompt(fullSummary: string): string {
  return `You are condensing a calendar summary for voice message listening (target: 30-45 seconds).

**CRITICAL: This is for VOICE listening, not reading. Output must flow naturally like spoken language.**

**RULES:**
1. Keep Hebrew date with weekday (e.g., "day name, Hebrew date")
2. For user & spouse events: Keep ONLY time + title (remove locations, remove descriptions)
3. For kids start times: Keep time + name (remove locations)
4. For special kids events: Keep as-is (time, name, activity, location)
5. For pickup order: Keep ONLY time + name(s) (remove locations)
6. **Weather: Keep weather summary and helpful tips** (e.g., "don't forget umbrella") - this is important
7. Remove ALL formatting: HTML tags, emojis, asterisks, bold/italic markers
8. **Transform section headers into natural conversational transitions:**
   - Instead of "Your Schedule:" → "You have..." or "Today you have..."
   - Instead of "Pickup Order:" → "Pick up..." or "To pick up..."
   - Instead of "Kids Start Times:" → "The kids start at..." or "Start times..."
   - Instead of "Weather:" → "About the weather..." or "Weather-wise..." or just integrate naturally
   - Headers should flow naturally like you're speaking to someone, not announcing categories
9. Output flows as a single narrative in Hebrew, like you're having a conversation

**Example of WRONG output (rigid headers):**
Monday, 28 Kislev
Your Schedule:
09:00 - Meeting
Pickup Order:
14:00 - Danny

**Example of CORRECT output (conversational flow):**
Monday, 28 Kislev
You have a meeting at 09:00.
Pick up Danny at 14:00.

**Original Summary:**
${fullSummary}

**Output the condensed voice-friendly version (plain text, natural flow, NO headers, Hebrew only):**`;
}
