/**
 * Voice Condenser Prompt
 * Takes existing calendar summary and makes it voice-friendly
 */

export function buildVoiceCondenserPrompt(fullSummary: string, language: string = 'English'): string {
  const dateFormat = language === 'Hebrew'
    ? 'Hebrew date with weekday (remove Gregorian date, remove Hebrew year)'
    : 'Date with weekday';

  return `You are condensing a calendar summary for voice message listening (target: 30-45 seconds) in ${language}.

**CRITICAL: This is for VOICE listening - make it sound NATURAL and FLUENT like human speech, not robotic. Be brief but conversational.**

**RULES:**
1. Keep ONLY ${dateFormat}
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
6. **Section labels in ${language}:**
   - Use minimal labels (1-2 words) to separate sections
   - Labels MUST be in ${language}, not English
   - Keep everything natural and conversational
7. Write as if you're speaking to someone - natural, brief, fluent ${language}

**Example of WRONG output (robotic and choppy):**
Monday, 28 Kislev
Weather: Rain afternoon, bring umbrella
For you: 09:00 meeting
Pickup: 14:00 Danny

**Example of CORRECT output (natural and fluent):**
Monday, 28 Kislev
It'll rain in the afternoon, so bring an umbrella.
You have a meeting at 09:00.
Pick up Danny at 14:00.

**Original Summary:**
${fullSummary}

**Output the ultra-brief voice version (plain text, direct, in ${language}):**`;
}
