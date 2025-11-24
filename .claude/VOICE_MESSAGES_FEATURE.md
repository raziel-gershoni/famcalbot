# Voice Messages Feature - Implementation Plan

## Overview

Add Text-to-Speech (TTS) capability to send voice messages after text summaries, enabling users to listen to their calendar summaries hands-free.

---

## Feature Requirements

### Core Functionality
1. **Generate voice from text summary** - Convert Hebrew text summary to natural-sounding audio
2. **Send after text** - Voice message follows immediately after text summary
3. **User preference** - Per-user toggle to enable/disable voice messages
4. **Quality Hebrew TTS** - Must handle Hebrew text (RTL) with natural pronunciation
5. **Error resilience** - Text summary always sent even if voice generation fails

### User Experience
- Voice plays automatically in Telegram when opened
- Clear, natural Hebrew pronunciation
- Appropriate speaking pace (not too fast/slow)
- Pleasant voice quality (professional, friendly tone)
- Optional: Brief intro ("הנה סיכום היומן שלך להיום")

---

## Technical Design

### 1. TTS Provider Selection - Deep Dive

⚠️ **CRITICAL**: Hebrew TTS quality varies significantly between providers. Must test before committing.

---

#### Option A: Google Cloud Text-to-Speech (🏆 RECOMMENDED for Hebrew)

**Hebrew Support: ⭐⭐⭐⭐⭐ (Excellent)**
- **Native Hebrew voices**: he-IL-Wavenet-A/B/C/D (4 voices: 2 male, 2 female)
- **Neural2 models**: he-IL-Neural2-A/B/C/D (most natural sounding)
- **Designed for Hebrew**: Proper nikud (vowel marks) handling
- **RTL text support**: Native right-to-left rendering
- **Stress patterns**: Correct Hebrew word stress and intonation
- **Numbers**: Proper Hebrew number pronunciation (e.g., "עשרים ושלושה")

**Quality: ⭐⭐⭐⭐⭐**
- WaveNet voices: Very natural, human-like
- Neural2: Even more natural, latest technology
- Clear pronunciation of Hebrew-specific sounds (ח, כ, ק, etc.)
- Proper dagesh and emphasis handling

**Cost: ⭐⭐⭐⭐ (Good)**
```
WaveNet voices:  $16 per 1M characters
Neural2 voices:  $16 per 1M characters
Standard voices: $4 per 1M characters

Typical summary: 1500-2500 Hebrew characters
Per summary cost: $0.024-0.040 (WaveNet/Neural2)
Monthly (60 summaries): ~$1.44-2.40
```

**Pros:**
- **Best Hebrew pronunciation** - designed specifically for Hebrew
- Multiple voice options with gender selection
- SSML support for fine-tuning (pauses, emphasis, speed)
- Stable, reliable API from Google
- Can handle mixed Hebrew-English text
- Free tier: 1M characters/month (enough for ~400 summaries!)

**Cons:**
- Requires Google Cloud setup (but you already have Google Calendar API)
- Additional dependency (`@google-cloud/text-to-speech`)
- Slightly more complex code than OpenAI
- Authentication via service account (one-time setup)

**Sample Implementation:**
```typescript
import textToSpeech from '@google-cloud/text-to-speech';

const client = new textToSpeech.TextToSpeechClient({
  keyFilename: process.env.GOOGLE_TTS_SERVICE_ACCOUNT_KEY
});

const [response] = await client.synthesizeSpeech({
  input: { text: hebrewText },
  voice: {
    languageCode: 'he-IL',
    name: 'he-IL-Neural2-A', // Female, natural
    ssmlGender: 'FEMALE'
  },
  audioConfig: {
    audioEncoding: 'OGG_OPUS',
    speakingRate: 1.0,
    pitch: 0.0
  }
});
```

---

#### Option B: OpenAI TTS

**Hebrew Support: ⭐⭐⭐ (Good, but not native)**
- **Multilingual model**: Supports 57 languages including Hebrew
- **No dedicated Hebrew voices**: Uses same voices for all languages
- **Accent issues**: May have slight English accent on Hebrew
- **Unknown training data**: Unclear how much Hebrew data was used
- **Nikud handling**: May not properly handle vowel marks
- **Need to test**: Quality for Hebrew unknown until tested

**Quality: ⭐⭐⭐⭐ (Very good for English, unknown for Hebrew)**
- Excellent for English
- Natural prosody and emotion
- 6 voice options
- Unknown Hebrew performance (needs testing)

**Cost: ⭐⭐⭐⭐ (Good)**
```
tts-1:    $15 per 1M characters
tts-1-hd: $15 per 1M characters

Typical summary: 1500-2500 characters
Per summary cost: $0.0225-0.0375
Monthly (60 summaries): ~$1.35-2.25
```

**Pros:**
- Already integrated (have OpenAI API key)
- Simple API, easy to implement
- Fast generation (~2-3 seconds)
- Multiple format options
- Good for mixed-language content

**Cons:**
- **Not designed for Hebrew** - may have pronunciation issues
- No control over Hebrew-specific features
- Unknown quality until tested
- Single global model (can't select Hebrew-optimized variant)
- May pronounce Hebrew names/places incorrectly

**Recommendation**: Test with actual Hebrew calendar summary before committing

---

#### Option C: AWS Polly

**Hebrew Support: ⭐ (Poor - No Hebrew support)**
- No Hebrew voices available
- Not suitable for this project

---

#### Option D: Azure Cognitive Services Speech

**Hebrew Support: ⭐⭐⭐⭐ (Excellent)**
- **Native Hebrew voices**: he-IL voices (male and female)
- **Neural voices**: Very natural sounding
- **Hebrew-specific**: Proper pronunciation and intonation

**Quality: ⭐⭐⭐⭐**
- High-quality neural voices
- Good Hebrew support

**Cost: ⭐⭐⭐ (Moderate)**
```
Neural voices: ~$16 per 1M characters
Standard voices: ~$4 per 1M characters
```

**Pros:**
- Excellent Hebrew support
- Multiple voice options
- SSML support

**Cons:**
- Requires Azure account setup
- Additional complexity
- Not already integrated

---

#### Option E: ElevenLabs

**Hebrew Support: ⭐⭐⭐⭐ (Good multilingual)**
- Supports Hebrew through multilingual models
- Can clone voices for Hebrew
- High quality but expensive

**Quality: ⭐⭐⭐⭐⭐ (Best overall)**
- Most natural-sounding TTS available
- Emotion and intonation control
- Premium quality

**Cost: ⭐ (Very expensive)**
```
Multilingual: $0.30 per 1000 characters

Typical summary: 1500-2500 characters
Per summary cost: $0.45-0.75
Monthly (60 summaries): ~$27-45
```

**Decision: ❌ Too expensive** for daily automated summaries

---

### 🎯 RECOMMENDED APPROACH: Two-Phase Testing

#### Phase 1: Test Both OpenAI and Google Cloud (1-2 hours)

**Quick Test Script:**
```typescript
// test-hebrew-tts.ts
const hebrewTestText = `
בוקר טוב רזיאל!

📅 היום - יום שלישי, 24 בנובמבר 2025

הלו״ז של ישועה:
- 08:00-12:45 - כלנית
- 15:00-16:00 - תַּל״א עם הורים

זמני התחלת הילדים:
- 07:30 - יצחק יוסף
- 08:00 - ישראל
`;

// Test OpenAI
const openaiVoice = await testOpenAI(hebrewTestText, 'nova');

// Test Google Cloud
const googleVoice = await testGoogle(hebrewTestText, 'he-IL-Neural2-A');

// Compare:
// 1. Pronunciation accuracy (especially ח, כ, ע)
// 2. Name pronunciation (ישועה, יצחק יוסף, etc.)
// 3. Natural flow and intonation
// 4. Numbers (24, 08:00, etc.)
// 5. Special characters (״, ״א)
```

**Evaluation Criteria:**
1. ✅ Hebrew letters pronounced correctly
2. ✅ Hebrew names sound natural
3. ✅ Times/numbers in Hebrew format
4. ✅ Natural prosody (not robotic)
5. ✅ No English accent bleeding through

#### Phase 2: Choose Based on Results

**If Google Cloud Hebrew quality is significantly better:**
→ Use Google Cloud (likely scenario)
- Worth the setup time for native Hebrew support
- Free tier covers first month
- Best long-term solution

**If OpenAI Hebrew quality is acceptable:**
→ Use OpenAI
- Already integrated
- Simpler implementation
- Slightly cheaper

---

### 💰 Cost Comparison (60 summaries/month, 2 users)

| Provider | Per Summary | Monthly Cost | Free Tier | Hebrew Quality |
|----------|-------------|--------------|-----------|----------------|
| **Google Cloud Neural2** | $0.024-0.040 | $1.44-2.40 | ✅ 1M chars/month | ⭐⭐⭐⭐⭐ Native |
| **OpenAI TTS-1-HD** | $0.0225-0.0375 | $1.35-2.25 | ❌ None | ⭐⭐⭐ Unknown |
| **Azure Neural** | $0.024-0.040 | $1.44-2.40 | ✅ Limited | ⭐⭐⭐⭐ Good |
| **ElevenLabs** | $0.45-0.75 | $27-45 | ❌ None | ⭐⭐⭐⭐ Good |

**Winner: Google Cloud** - Native Hebrew support + free tier + excellent quality

---

### 🏆 FINAL RECOMMENDATION

**Primary: Google Cloud Text-to-Speech (Neural2)**
- Native Hebrew voices designed for the language
- Free tier covers ~400 summaries (6+ months free for 2 users!)
- After free tier: ~$1.44-2.40/month
- Best pronunciation and naturalness for Hebrew
- You already have Google Cloud setup (Calendar API)

**Fallback: OpenAI TTS**
- If Google setup is too complex
- If testing shows acceptable Hebrew quality
- Slightly simpler implementation

**Testing Plan:**
1. Spend 30 minutes testing both with real Hebrew summaries
2. Listen to pronunciation quality
3. Get user feedback on naturalness
4. Choose based on Hebrew quality (primary factor)
5. Cost difference is minimal (<$1/month difference)

---

### 2. Architecture

#### New Files to Create

**`src/services/voice-generator.ts`**
```typescript
/**
 * Voice Generation Service
 * Converts text summaries to speech using OpenAI TTS
 */

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

interface VoiceOptions {
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  speed?: number; // 0.25 to 4.0
  model?: 'tts-1' | 'tts-1-hd';
}

/**
 * Generate voice message from text
 * @param text - Hebrew text summary
 * @param options - Voice generation options
 * @returns Path to generated audio file
 */
export async function generateVoiceMessage(
  text: string,
  options?: VoiceOptions
): Promise<string>;

/**
 * Clean up temporary voice file
 * @param filePath - Path to audio file
 */
export async function cleanupVoiceFile(filePath: string): Promise<void>;
```

**Update `src/config/users.ts`**
```typescript
export interface UserConfig {
  // ... existing fields ...
  voiceEnabled?: boolean; // Default: false
  voicePreference?: {
    voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
    speed: number; // 0.8-1.2 recommended
  };
}
```

**Update `src/services/telegram.ts`**
```typescript
async function sendSummaryWithVoice(
  userId: number,
  textSummary: string,
  date: Date
): Promise<void> {
  // 1. Send text message
  await botInstance.sendMessage(userId, textSummary, { parse_mode: 'HTML' });

  // 2. Check if voice enabled for user
  if (!user.voiceEnabled) return;

  // 3. Generate voice message
  try {
    const voiceFilePath = await generateVoiceMessage(textSummary, user.voicePreference);

    // 4. Send voice message
    await botInstance.sendVoice(userId, voiceFilePath);

    // 5. Clean up temp file
    await cleanupVoiceFile(voiceFilePath);
  } catch (error) {
    console.error('Voice generation failed:', error);
    // Text already sent, just notify admin
    await notifyAdminWarning('Voice Generation', `Failed for user ${userId}: ${error.message}`);
  }
}
```

---

### 3. Implementation Flow

```
User requests summary (/summary or cron job)
         ↓
Generate text summary (existing)
         ↓
Send text message to Telegram ✓
         ↓
Check if user.voiceEnabled === true
         ↓
    [YES] → Generate TTS audio
         ↓
    Save to /tmp/voice-{userId}-{timestamp}.mp3
         ↓
    Send voice message via bot.sendVoice()
         ↓
    Delete temp file from /tmp
         ↓
    [DONE]
```

---

### 4. Telegram Integration

#### Voice Message vs Audio File

**Option A: Voice Message** (Recommended)
- Uses `bot.sendVoice(chatId, voiceFile)`
- Shows as voice message bubble (blue waveform)
- Plays inline in Telegram
- Format: OGG (Opus codec) for best experience
- Duration automatically detected

**Option B: Audio File**
- Uses `bot.sendAudio(chatId, audioFile)`
- Shows as music player
- Supports title, artist metadata
- Format: MP3, M4A, etc.

**Decision: Use sendVoice()** - Better UX for spoken messages.

#### Format Conversion (if needed)
OpenAI TTS can output opus format directly:
```typescript
const buffer = await openai.audio.speech.create({
  model: "tts-1-hd",
  voice: "nova",
  input: text,
  response_format: "opus" // Instead of mp3
});
```

---

### 5. File Handling

#### Temporary Storage
Vercel serverless functions have `/tmp` directory:
- Max 512MB storage
- Cleared between cold starts
- Persists during function execution

#### File Naming
```
/tmp/voice-{userId}-{timestamp}-{random}.opus
Example: /tmp/voice-762715667-1732456789-a3f2b1.opus
```

#### Cleanup Strategy
1. **Immediate cleanup** - Delete file after sending
2. **Error handling** - Use try-finally to ensure cleanup
3. **Orphan prevention** - Files auto-deleted on cold start

```typescript
let voiceFilePath: string | null = null;
try {
  voiceFilePath = await generateVoiceMessage(text);
  await bot.sendVoice(chatId, voiceFilePath);
} finally {
  if (voiceFilePath) {
    await cleanupVoiceFile(voiceFilePath).catch(err =>
      console.error('Cleanup failed:', err)
    );
  }
}
```

---

### 6. Cost Analysis

#### OpenAI TTS Pricing
- **Model**: tts-1-hd (high quality)
- **Cost**: $15.00 per 1M characters
- **Typical summary**: 1500-2500 characters (including Hebrew)
- **Per summary**: $0.0225-0.0375

#### Monthly Estimates (2 users, daily summaries)
- **Summaries per month**: 60 (30 days × 2 users)
- **Monthly cost**: ~$1.35-2.25
- **With tomorrow summaries**: ~$2.70-4.50

#### Comparison with Text-Only
- **Current text-only cost**: ~$2.40/month (Claude 4.5)
- **With voice**: ~$3.75-6.90/month total
- **Increase**: +56-188%

**Decision:** Reasonable cost increase for premium feature. Make it optional per user.

---

### 7. Configuration

#### Environment Variables
```env
# Voice Messages (optional)
VOICE_ENABLED=true                    # Global kill switch
VOICE_MODEL=tts-1-hd                  # or tts-1 (faster/cheaper)
VOICE_DEFAULT=nova                     # Default voice if not set per user
VOICE_SPEED=1.0                       # Default speed
```

#### User Configuration
```typescript
// src/config/users.ts
{
  telegramId: 762715667,
  name: 'Raziel',
  // ... existing fields ...
  voiceEnabled: true,  // Enable voice for this user
  voicePreference: {
    voice: 'nova',     // Female voice, clear pronunciation
    speed: 1.0         // Normal speed
  }
}
```

---

### 8. Error Handling

#### Failure Scenarios & Responses

1. **OpenAI TTS API fails**
   - Log error with full context
   - Notify admin via Telegram
   - Continue without voice (text already sent)
   - Don't retry (TTS not critical)

2. **File write to /tmp fails**
   - Log error
   - Notify admin
   - Continue without voice

3. **Telegram sendVoice fails**
   - Log error
   - Notify admin with file size, duration
   - File already generated (cost incurred)
   - Clean up temp file

4. **Cleanup fails**
   - Log warning (non-critical)
   - File will be deleted on next cold start
   - Don't notify admin (noise)

#### Error Notification Format
```typescript
await notifyAdminWarning(
  'Voice Generation',
  `Failed for user ${userName} (${userId})

Error: ${error.message}
Summary length: ${text.length} chars
Voice settings: ${JSON.stringify(user.voicePreference)}

Text summary was delivered successfully.`
);
```

---

### 9. Implementation Phases

### Phase 1: Basic Implementation (MVP)
**Goal:** Get voice messages working for one user

**Tasks:**
1. Create `src/services/voice-generator.ts`
2. Add `generateVoiceMessage()` function with OpenAI TTS
3. Add `cleanupVoiceFile()` helper
4. Update user config to add `voiceEnabled: false` for all users
5. Modify `sendSummaryToUser()` to conditionally generate and send voice
6. Test with admin user only
7. Add error handling and admin notifications

**Testing:**
- `/summary` command with voice enabled
- Verify voice quality in Hebrew
- Confirm temp file cleanup
- Test error scenarios (TTS API down, file write fails)

**Estimated time:** 2-3 hours

---

### Phase 2: User Preferences & Configuration
**Goal:** Make voice customizable per user

**Tasks:**
1. Add `voicePreference` to UserConfig interface
2. Support voice selection (alloy, echo, fable, onyx, nova, shimmer)
3. Support speed adjustment (0.8-1.2 range)
4. Add environment variables for global defaults
5. Document configuration in README

**Testing:**
- Test all 6 voices with Hebrew text
- Find best male and female voices
- Test speed variations
- Update user configs with preferences

**Estimated time:** 1-2 hours

---

### Phase 3: Quality & Polish
**Goal:** Optimize voice quality and user experience

**Tasks:**
1. Add brief intro text: "סיכום היומן שלך ל{תאריך}"
2. Test format options (opus vs mp3 vs ogg)
3. Optimize for file size and quality
4. Consider SSML-like enhancements (pauses between sections)
5. Add metrics tracking (generation time, file size, success rate)

**Testing:**
- A/B test different intro phrases
- Compare audio formats
- Measure generation time vs file size trade-offs
- User feedback on voice quality

**Estimated time:** 2-3 hours

---

### Phase 4: Advanced Features (Future)
**Optional enhancements if Phase 1-3 are successful:**

1. **Command to toggle voice**
   - `/voice on` and `/voice off`
   - Persisted to user config file

2. **Command to test voices**
   - `/testvoices` (admin only)
   - Generates sample with all voices
   - Helps user choose preference

3. **Alternative TTS provider**
   - If OpenAI Hebrew quality isn't great
   - Try Google Cloud TTS with Hebrew neural voices
   - Compare quality and cost

4. **Voice message for /tomorrow command**
   - Extend to all summary-generating commands
   - Consistent experience

5. **Streaming support**
   - Stream TTS output directly to Telegram
   - Avoid disk writes entirely
   - Faster delivery

---

### 10. Code Skeleton

#### `src/services/voice-generator.ts`

```typescript
/**
 * Voice Generation Service
 * Converts text summaries to speech using OpenAI TTS
 */

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface VoiceOptions {
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  speed?: number; // 0.25 to 4.0
  model?: 'tts-1' | 'tts-1-hd';
}

const DEFAULT_OPTIONS: VoiceOptions = {
  voice: (process.env.VOICE_DEFAULT as any) || 'nova',
  speed: parseFloat(process.env.VOICE_SPEED || '1.0'),
  model: (process.env.VOICE_MODEL as any) || 'tts-1-hd',
};

/**
 * Generate voice message from text
 * @param text - Hebrew text summary (HTML tags will be stripped)
 * @param options - Voice generation options
 * @returns Path to generated audio file in /tmp
 */
export async function generateVoiceMessage(
  text: string,
  options: VoiceOptions = {}
): Promise<string> {
  const startTime = Date.now();

  // Strip HTML tags for clean TTS
  const cleanText = stripHtmlTags(text);

  // Merge with defaults
  const config = { ...DEFAULT_OPTIONS, ...options };

  console.log('Generating voice message:', {
    textLength: cleanText.length,
    voice: config.voice,
    speed: config.speed,
    model: config.model,
  });

  try {
    // Call OpenAI TTS API
    const mp3 = await openai.audio.speech.create({
      model: config.model!,
      voice: config.voice!,
      input: cleanText,
      speed: config.speed,
      response_format: 'opus', // Best for Telegram voice messages
    });

    // Generate unique filename
    const randomId = randomBytes(6).toString('hex');
    const timestamp = Date.now();
    const filename = `voice-${timestamp}-${randomId}.opus`;
    const filePath = path.join('/tmp', filename);

    // Write to temp file
    const buffer = Buffer.from(await mp3.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const elapsed = Date.now() - startTime;
    console.log('Voice generated:', {
      filePath,
      sizeKB: (buffer.length / 1024).toFixed(2),
      durationMs: elapsed,
    });

    return filePath;
  } catch (error) {
    console.error('Voice generation failed:', error);
    throw new Error(`TTS failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clean up temporary voice file
 * @param filePath - Path to audio file
 */
export async function cleanupVoiceFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
    console.log('Voice file cleaned up:', filePath);
  } catch (error) {
    // Non-critical error, file will be cleaned on cold start
    console.warn('Failed to cleanup voice file:', filePath, error);
  }
}

/**
 * Strip HTML tags from text for clean TTS
 * @param html - Text with HTML formatting
 * @returns Plain text
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&lt;/g, '<')   // Decode HTML entities
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
```

#### Update `src/services/telegram.ts`

```typescript
// Add after line 293 (in sendSummaryToUser function)

    // Send personalized message (greeting is included in the summary)
    await botInstance.sendMessage(userId, summary, { parse_mode: 'HTML' });

    // Generate and send voice message if enabled for user
    if (user.voiceEnabled) {
      await sendVoiceMessage(userId, summary, user);
    }
  } catch (error) {
    // ... existing error handling
  }
}

/**
 * Generate and send voice version of summary
 * Non-blocking - errors logged but don't affect text summary delivery
 */
async function sendVoiceMessage(
  userId: number,
  summary: string,
  user: UserConfig
): Promise<void> {
  let voiceFilePath: string | null = null;

  try {
    const { generateVoiceMessage, cleanupVoiceFile } = await import('../utils/voice-generator');

    // Generate voice file
    voiceFilePath = await generateVoiceMessage(summary, user.voicePreference);

    // Send as voice message to Telegram
    const botInstance = getBot();
    await botInstance.sendVoice(userId, voiceFilePath);

    console.log(`Voice message sent to user ${userId}`);
  } catch (error) {
    console.error(`Voice generation failed for user ${userId}:`, error);

    // Notify admin but don't interrupt user experience
    const { notifyAdminWarning } = await import('../utils/error-notifier');
    await notifyAdminWarning(
      'Voice Generation',
      `Failed for user ${user.name} (${userId}):\n${error instanceof Error ? error.message : 'Unknown error'}`
    );
  } finally {
    // Always attempt cleanup
    if (voiceFilePath) {
      const { cleanupVoiceFile } = await import('../utils/voice-generator');
      await cleanupVoiceFile(voiceFilePath).catch(err =>
        console.warn('Voice file cleanup failed:', err)
      );
    }
  }
}
```

---

### 11. Testing Plan

#### Manual Testing

**Test 1: Basic voice generation**
- Enable voice for admin user
- Run `/summary` command
- Verify text message received
- Verify voice message received immediately after
- Listen to voice quality in Hebrew
- Check voice message duration (~30-60 seconds)

**Test 2: Voice quality comparison**
- Test all 6 voices (alloy, echo, fable, onyx, nova, shimmer)
- Evaluate Hebrew pronunciation
- Rate naturalness and clarity
- Choose best male and female voices

**Test 3: Error handling**
- Temporarily break OpenAI API key → Verify text still sent, admin notified
- Fill /tmp to capacity → Verify graceful failure
- Disable internet during voice send → Verify cleanup happens

**Test 4: Performance**
- Measure voice generation time (target: <5 seconds)
- Check file sizes (target: <500KB for 1-2 min audio)
- Monitor Vercel function duration (must stay under 10s for standard tier)

**Test 5: Hebrew edge cases**
- Very long summary (>5000 characters) → Should handle or truncate gracefully
- Summary with special characters → Should strip HTML properly
- Summary with numbers → Should pronounce correctly

#### Automated Testing (Future)

```typescript
// tests/voice-generator.test.ts
describe('Voice Generator', () => {
  test('should generate voice file from Hebrew text', async () => {
    const text = 'בוקר טוב! הנה סיכום היומן שלך להיום.';
    const filePath = await generateVoiceMessage(text);

    expect(filePath).toContain('/tmp/voice-');
    expect(filePath).toMatch(/\.opus$/);

    const stats = await fs.stat(filePath);
    expect(stats.size).toBeGreaterThan(0);

    await cleanupVoiceFile(filePath);
  });

  test('should strip HTML tags', () => {
    const html = '<b>Bold</b> and <i>italic</i>';
    const result = stripHtmlTags(html);
    expect(result).toBe('Bold and italic');
  });
});
```

---

### 12. Documentation Updates

#### README.md additions

```markdown
## Voice Messages

The bot can generate voice messages for calendar summaries using Text-to-Speech (TTS).

### Enable Voice Messages

Edit `src/config/users.ts` for each user:

```typescript
{
  telegramId: 123456789,
  name: 'Raziel',
  // ... other fields ...
  voiceEnabled: true,  // Enable voice messages
  voicePreference: {
    voice: 'nova',     // Options: alloy, echo, fable, onyx, nova, shimmer
    speed: 1.0         // Speed: 0.8 (slower) to 1.2 (faster)
  }
}
```

### Voice Options

**Available voices (OpenAI):**
- `alloy` - Neutral, balanced
- `echo` - Clear, articulate
- `fable` - Warm, engaging
- `onyx` - Deep, authoritative (male)
- `nova` - Pleasant, friendly (female) - **Recommended for Hebrew**
- `shimmer` - Soft, gentle

**Speed adjustment:**
- `0.8` - 20% slower (easier to follow)
- `1.0` - Normal speed (default)
- `1.2` - 20% faster (efficient)

### Cost Impact

- **Per summary**: ~$0.025
- **Monthly (2 users, daily summaries)**: ~$1.50 additional

### Environment Variables

```env
VOICE_ENABLED=true              # Global kill switch
VOICE_MODEL=tts-1-hd            # Quality: tts-1-hd or tts-1
VOICE_DEFAULT=nova               # Default voice
VOICE_SPEED=1.0                 # Default speed
```
```

---

### 13. Future Enhancements

1. **Intro/Outro audio clips**
   - Pre-recorded "Good morning" in Hebrew
   - Attach before generated TTS
   - More natural podcast-like feel

2. **Voice command to toggle**
   - `/voice on` / `/voice off`
   - Instant user control without editing config

3. **Pronunciation dictionary**
   - Custom pronunciation for Hebrew names
   - Calendar event names (school names, etc.)

4. **Background music**
   - Subtle background ambiance
   - Mix with TTS output
   - More professional feel

5. **Multi-language support**
   - Detect English events
   - Use appropriate voice/accent
   - Switch mid-summary if needed

6. **Offline mode**
   - Cache common phrases
   - Reduce API calls
   - Faster generation

---

## Summary

### What We're Building
A voice message feature that converts Hebrew calendar summaries to natural-sounding speech using OpenAI TTS, sent automatically after text summaries to Telegram.

### Key Decisions
- **Provider**: OpenAI TTS (tts-1-hd model)
- **Voice**: Nova (female, clear)
- **Format**: Opus (best for Telegram)
- **Storage**: Temporary /tmp files
- **Optional**: Per-user toggle, disabled by default
- **Cost**: ~$1.50/month additional for 2 users

### Implementation Approach
- **Phase 1**: MVP with basic TTS
- **Phase 2**: User preferences
- **Phase 3**: Quality polish
- **Phase 4**: Advanced features

### Estimated Effort
- **Phase 1**: 2-3 hours (core implementation)
- **Phase 2**: 1-2 hours (preferences)
- **Phase 3**: 2-3 hours (polish)
- **Total**: 5-8 hours for full feature

### Success Criteria
✅ Voice messages sent after text summaries
✅ Clear, natural Hebrew pronunciation
✅ Optional per user (not forced)
✅ Reliable (text always sent even if voice fails)
✅ Cost-effective (<$5/month total)
✅ Fast (<5s generation time)

---

## Next Steps

1. Review this plan
2. Decide on Phase 1 implementation timeline
3. Test OpenAI TTS Hebrew quality with sample text
4. Implement Phase 1 MVP
5. Get user feedback
6. Iterate based on feedback
