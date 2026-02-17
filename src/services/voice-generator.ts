/**
 * Voice Generation Service
 * Converts text summaries to speech using Google Cloud Text-to-Speech
 */

import textToSpeech from '@google-cloud/text-to-speech';
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

// Initialize Google Cloud TTS client
const getCredentials = () => {
  if (!process.env.GOOGLE_TTS_CREDENTIALS) {
    return undefined;
  }

  const creds = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS);

  // Fix escaped newlines in private key (Vercel may store \\n instead of \n)
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  return creds;
};

const client = new textToSpeech.TextToSpeechClient({
  credentials: getCredentials(),
});

export interface VoiceOptions {
  voice?: string;  // Google TTS voice name (e.g., 'he-IL-Wavenet-D', 'en-US-Wavenet-D', 'es-ES-Wavenet-B')
  speed?: number; // 0.25 to 4.0
}

const DEFAULT_OPTIONS: VoiceOptions = {
  voice: (process.env.VOICE_DEFAULT as any) || 'he-IL-Wavenet-D', // Male voice, natural
  speed: parseFloat(process.env.VOICE_SPEED || '1.0'),
};

/**
 * Map locale codes to Google TTS language codes and default voices
 */
function getLanguageConfig(language: string = 'en'): { code: string; voice: string } {
  const configs: Record<string, { code: string; voice: string }> = {
    'he': { code: 'he-IL', voice: 'he-IL-Wavenet-D' },  // Male, natural
    'en': { code: 'en-US', voice: 'en-US-Wavenet-D' },  // Male, neutral
    'ru': { code: 'ru-RU', voice: 'ru-RU-Wavenet-D' },  // Male, neutral
    'es': { code: 'es-ES', voice: 'es-ES-Wavenet-B' },  // Male, neutral
    'fr': { code: 'fr-FR', voice: 'fr-FR-Wavenet-B' },  // Male, neutral
    'de': { code: 'de-DE', voice: 'de-DE-Wavenet-B' },  // Male, neutral
  };

  return configs[language] || configs['en']; // Default to English if language not found
}

/**
 * Generate voice message from text
 * @param text - Text summary (HTML tags will be stripped)
 * @param language - Target language (e.g., "Hebrew", "English", "Spanish")
 * @param options - Voice generation options (voice name, speed)
 * @returns Path to generated audio file in /tmp
 */
export async function generateVoiceMessage(
  text: string,
  language: string = 'en',
  options: VoiceOptions = {}
): Promise<string> {
  const startTime = Date.now();

  // Strip HTML tags only - let Google TTS handle text natively
  const cleanText = stripHtmlTagsOnly(text);

  // Get language-specific configuration
  const langConfig = getLanguageConfig(language);

  // Merge with defaults, prioritizing options, then language defaults
  const config = {
    ...DEFAULT_OPTIONS,
    voice: options.voice || langConfig.voice,
    speed: options.speed !== undefined ? options.speed : DEFAULT_OPTIONS.speed,
  };

  console.log('Generating voice message (Google TTS):', {
    textLength: cleanText.length,
    language,
    languageCode: langConfig.code,
    voice: config.voice,
    speed: config.speed,
  });

  try {
    // Call Google Cloud TTS API
    const [response] = await client.synthesizeSpeech({
      input: { text: cleanText },
      voice: {
        languageCode: langConfig.code,
        name: config.voice,
      },
      audioConfig: {
        audioEncoding: 'OGG_OPUS', // Best for Telegram
        speakingRate: config.speed,
        pitch: 0,
      },
    });

    // Generate unique filename
    const randomId = randomBytes(6).toString('hex');
    const timestamp = Date.now();
    const filename = `voice-${timestamp}-${randomId}.opus`;
    const filePath = path.join('/tmp', filename);

    // Write to temp file
    const audioContent = response.audioContent as Buffer;
    await fs.writeFile(filePath, audioContent);

    const elapsed = Date.now() - startTime;
    console.log('Voice generated successfully:', {
      filePath,
      sizeKB: (audioContent.length / 1024).toFixed(2),
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
 * Strip HTML tags and apply minimal normalization
 * Let Google TTS handle Hebrew, Gematria, dates natively
 * Only fix: pauses and time range dashes
 */
function stripHtmlTagsOnly(html: string): string {
  let text = html
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&lt;/g, '<')   // Decode HTML entities
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\*+/g, '')     // Remove asterisks (markdown formatting)
    .replace(/\n\n+/g, '\n\n') // Normalize multiple newlines
    .trim();

  // Fix 1: Transliterate problematic English words to Hebrew phonetics
  // Only words that Google TTS mispronounces badly
  const transliterations: Record<string, string> = {
    'Zoom': 'זום',
    'zoom': 'זום',
    'Teams': 'טימס',
    'teams': 'טימס',
    'Skype': 'סקייפ',
    'skype': 'סקייפ',
    'Google': 'גוגל',
    'google': 'גוגל',
  };

  for (const [english, hebrew] of Object.entries(transliterations)) {
    const regex = new RegExp(`\\b${english}\\b`, 'g');
    text = text.replace(regex, hebrew);
  }

  // Fix 2: Convert time range dashes to Hebrew "עד" (until)
  // 8:00-16:00 → 8:00 עד 16:00
  text = text.replace(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/g, '$1 עד $2');

  // Fix 3: Add pauses before newlines
  // Single newline → short pause (,)
  text = text.replace(/\n/g, ', ');

  // Double newline → medium pause (...)
  text = text.replace(/,\s*,/g, '... ');

  return text;
}

