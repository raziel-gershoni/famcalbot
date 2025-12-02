/**
 * Voice Condenser Prompt
 * Takes existing calendar summary and makes it voice-friendly
 */

export function buildVoiceCondenserPrompt(fullSummary: string, language: string = 'English'): string {
  const dateFormat = language === 'Hebrew'
    ? 'Hebrew date with weekday (remove Gregorian date, remove Hebrew year)'
    : 'Date with weekday';

  return `You are condensing a calendar summary for voice message listening (target: 30-45 seconds) in ${language}.

**CRITICAL: BE EXTREMELY BRIEF. This is for VOICE - every word costs listening time. Remove ALL fluff.**

**RULES:**
1. Keep ONLY ${dateFormat}
2. **IMPORTANT: Weather comes IMMEDIATELY after date, BEFORE schedule**
   - Write as natural, flowing sentence (brief but fluent, not choppy)
   - Include conditions, timing, and practical tip in one smooth sentence
   - Example: "Rainy afternoon, bring an umbrella" or "Hot day, drink water"
3. For user & spouse events: ONLY time + title (no locations, no descriptions)
4. For kids start times: ONLY time + name (no locations)
5. For special kids events: Keep time, name, activity
6. For pickup order: ONLY time + name(s) (no locations)
7. Remove ALL formatting: HTML tags, emojis, asterisks, bold/italic
8. **Add minimal section labels (2-3 words max) before each content type:**
   - Weather: "Weather:" (MUST come right after date, before schedule)
   - User/spouse schedule: "For you:" or "Your schedule:"
   - Kids activities: "Kids:"
   - Pickups: "Pickup:"
   - Labels provide structure, keep everything else ultra-brief
9. Ultra-brief, direct, spoken ${language} with minimal structure labels

**Example of WRONG output (too wordy):**
Monday, 28 Kislev 5785
Today you have a meeting at 09:00.
For pickups, you need to pick up Danny at 14:00.
About the weather, it will rain today so don't forget your umbrella.

**Example of CORRECT output (brief with minimal labels):**
Monday, 28 Kislev
Weather: Rainy afternoon, bring an umbrella
For you: 09:00 meeting
Pickup: 14:00 Danny

**Original Summary:**
${fullSummary}

**Output the ultra-brief voice version (plain text, direct, in ${language}):**`;
}
