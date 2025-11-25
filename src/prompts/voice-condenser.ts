/**
 * Voice Condenser Prompt
 * Takes existing calendar summary and makes it voice-friendly
 */

export function buildVoiceCondenserPrompt(fullSummary: string): string {
  return `You are condensing a calendar summary for voice message listening (target: 30-45 seconds).

**RULES:**
1. Keep Hebrew date with weekday (e.g., "יום שני, כ״ח בכסלו") - include day of week, day and month in Gematria
2. For user & spouse events: Keep ONLY time + title (remove locations, remove descriptions)
3. For kids start times: Keep time + name (remove locations)
4. For special kids events: Keep as-is (time, name, activity, location)
5. For pickup order: Keep ONLY time + name(s) (remove locations)
6. Remove ALL HTML tags (convert to plain text)
7. Remove ALL emojis
8. REMOVE ALL section headers (like "Your Schedule:", "Pickup Order:", etc.) - output should flow naturally without headers
9. Output ONLY in Hebrew

**Original Summary:**
${fullSummary}

**Output the condensed voice-friendly version (plain text, no HTML, no emojis, no section headers, Hebrew only):**`;
}
