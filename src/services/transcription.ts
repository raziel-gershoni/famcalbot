/**
 * Transcription Service
 * Converts voice messages to text using Google Cloud Speech-to-Text
 */

import speech from '@google-cloud/speech';

// Initialize Google Cloud Speech client
// Reuses the same credentials as TTS service (GOOGLE_TTS_CREDENTIALS)
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

const client = new speech.SpeechClient({
  credentials: getCredentials(),
});

/**
 * Language codes for speech recognition
 */
const LANGUAGE_CODES: Record<string, string> = {
  'he': 'he-IL',
  'en': 'en-US',
  'ru': 'ru-RU',
  'es': 'es-ES',
  'fr': 'fr-FR',
  'de': 'de-DE',
};

/**
 * Transcription result
 */
export interface TranscriptionResult {
  text: string;
  confidence: number;
  languageCode: string;
}

/**
 * Transcribe voice audio to text
 * @param audioBuffer - Audio data buffer (OGG format from Telegram)
 * @param language - User's preferred language (e.g., 'he', 'en', 'ru')
 * @returns Transcription result with text and confidence
 */
export async function transcribeVoice(
  audioBuffer: Buffer,
  language: string = 'en'
): Promise<TranscriptionResult> {
  const startTime = Date.now();
  const languageCode = LANGUAGE_CODES[language] || 'en-US';

  console.log(`[Transcription] Starting transcription, language: ${languageCode}, size: ${audioBuffer.length} bytes`);

  try {
    // Convert buffer to base64 for API
    const audioContent = audioBuffer.toString('base64');

    // Use Chirp 2 model for best multilingual accuracy
    // Chirp 2 is available in Speech-to-Text V2 API
    const [response] = await client.recognize({
      config: {
        // OGG_OPUS is the format Telegram uses for voice messages
        encoding: 'OGG_OPUS' as any,
        // Telegram voice messages are typically 48000 Hz
        sampleRateHertz: 48000,
        languageCode: languageCode,
        // Enable automatic punctuation for better readability
        enableAutomaticPunctuation: true,
        // Use enhanced model for better accuracy
        model: 'latest_long',
        // Alternative languages for auto-detection
        alternativeLanguageCodes: Object.values(LANGUAGE_CODES).filter(code => code !== languageCode),
      },
      audio: {
        content: audioContent,
      },
    });

    // Extract transcription from response
    const results = response.results || [];

    if (results.length === 0 || !results[0].alternatives || results[0].alternatives.length === 0) {
      console.log('[Transcription] No transcription results');
      return {
        text: '',
        confidence: 0,
        languageCode: languageCode,
      };
    }

    const topResult = results[0].alternatives[0];
    const transcription = topResult.transcript || '';
    const confidence = topResult.confidence || 0;

    const duration = Date.now() - startTime;
    console.log(`[Transcription] Completed in ${duration}ms, confidence: ${(confidence * 100).toFixed(1)}%, text: "${transcription.substring(0, 50)}..."`);

    return {
      text: transcription,
      confidence: confidence,
      languageCode: languageCode,
    };
  } catch (error) {
    console.error('[Transcription] Error:', error);
    throw error;
  }
}
