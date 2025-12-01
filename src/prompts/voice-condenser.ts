/**
 * Voice Condenser Prompt
 * Takes existing calendar summary and makes it voice-friendly
 */

export function buildVoiceCondenserPrompt(fullSummary: string): string {
  return `You are condensing a calendar summary for voice message listening (target: 30-45 seconds).

**CRITICAL: BE EXTREMELY BRIEF. This is for VOICE - every word costs listening time. Remove ALL fluff.**

**RULES:**
1. Keep ONLY Hebrew date with weekday (remove all other date formats)
2. For user & spouse events: ONLY time + title (no locations, no descriptions)
3. For kids start times: ONLY time + name (no locations)
4. For special kids events: Keep time, name, activity
5. For pickup order: ONLY time + name(s) (no locations)
6. **Weather: Keep brief conditions + rain timing as single word**
   - Rain timing: ONE WORD only (night, morning, afternoon, evening, "early morning")
   - Keep helpful tips (umbrella, jacket, water)
7. Remove ALL formatting: HTML tags, emojis, asterisks, bold/italic
8. **BE DIRECT - minimize transitions:**
   - DON'T say "You have...", "Today you have...", "About the weather..."
   - Just list: "09:00 meeting, 14:00 pickup Danny"
   - Weather: "Rain afternoon, bring umbrella" NOT "Rain in the afternoon..."
9. Ultra-brief, direct, spoken Hebrew

**Example of WRONG output (too wordy):**
Monday, 28 Kislev
Today you have a meeting at 09:00.
For pickups, you need to pick up Danny at 14:00.
About the weather, it will rain today so don't forget your umbrella.

**Example of CORRECT output (ultra-brief):**
Monday, 28 Kislev
09:00 meeting
14:00 Danny
Rain afternoon, bring umbrella

**Original Summary:**
${fullSummary}

**Output the ultra-brief voice version (plain text, direct, Hebrew only):**`;
}
