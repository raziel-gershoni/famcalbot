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
  voice?: 'he-IL-Wavenet-A' | 'he-IL-Wavenet-B' | 'he-IL-Wavenet-C' | 'he-IL-Wavenet-D' | 'he-IL-Standard-A' | 'he-IL-Standard-B';
  speed?: number; // 0.25 to 4.0
}

const DEFAULT_OPTIONS: VoiceOptions = {
  voice: (process.env.VOICE_DEFAULT as any) || 'he-IL-Wavenet-D', // Male voice, natural
  speed: parseFloat(process.env.VOICE_SPEED || '1.0'),
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

  // Strip HTML tags only - let Google TTS handle Hebrew natively
  const cleanText = stripHtmlTagsOnly(text);

  // Merge with defaults
  const config = { ...DEFAULT_OPTIONS, ...options };

  console.log('Generating voice message (Google TTS):', {
    textLength: cleanText.length,
    voice: config.voice,
    speed: config.speed,
  });

  try {
    // Call Google Cloud TTS API
    const [response] = await client.synthesizeSpeech({
      input: { text: cleanText },
      voice: {
        languageCode: 'he-IL',
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

/*
// OLD NORMALIZATION CODE - COMMENTED OUT FOR TESTING
// Uncomment sections below if Google TTS doesn't handle specific cases well

function stripHtmlTags(html: string): string {
  let text = stripHtmlTagsOnly(html);

  // Normalize dates for better pronunciation
  text = normalizeDatesForTTS(text);

  // Normalize times for better Hebrew pronunciation
  text = normalizeTimesForTTS(text);

  // Transliterate English words to Hebrew phonetics
  text = transliterateEnglishToHebrew(text);

  // Add natural pauses for better flow
  text = addNaturalPauses(text);

  return text;
}
*/

/**
 * Normalize dates for better TTS pronunciation
 */
function normalizeDatesForTTS(text: string): string {
  let result = text;

  // 1. Gregorian dates with text month: "24 נובמבר" or "24 November 2024"
  // Convert day and year numbers to Hebrew words
  result = result.replace(/\b(\d{1,2})\s+(ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר|January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?\b/gi,
    (match, day, month, year) => {
      const dayWords = convertNumberToHebrewWords(parseInt(day, 10));
      if (year) {
        // Read year as: "אלפיים עשרים וארבעה" (two thousand twenty-four)
        const yearWords = convertYearToHebrewWords(parseInt(year, 10));
        return `${dayWords} ${month} ${yearWords}`;
      }
      return `${dayWords} ${month}`;
    }
  );

  // 2. Numeric dates with slashes (just in case): "24/11"
  result = result.replace(/\b(\d{1,2})[\/\.](\d{1,2})\b/g, (match, day, month) => {
    const dayWords = convertNumberToHebrewWords(parseInt(day, 10));
    const monthWords = convertNumberToHebrewWords(parseInt(month, 10));
    return `${dayWords} ${monthWords}`;
  });

  // 3. Hebrew Gematria: spell out letter names
  // ONLY process the beginning of text (where dates are) to avoid abbreviations like לו״ז
  const dateHeaderLength = 150; // Date header is at the start
  const beginning = result.slice(0, dateHeaderLength);
  const rest = result.slice(dateHeaderLength);

  const processedBeginning = beginning.replace(/([א-ת]+)[״׳]([א-ת])?/g, (match, beforeMark, afterMark) => {
    // Split all letters before the mark
    const beforeNames = beforeMark.split('').map((l: string) => getHebrewLetterName(l)).join(' ');

    if (afterMark) {
      // Gershayim case: תשפ״ד → "תו שין פא דלת"
      const afterName = getHebrewLetterName(afterMark);
      return `${beforeNames} ${afterName}`;
    } else {
      // Geresh case: ה׳ → "הא"
      return beforeNames;
    }
  });

  result = processedBeginning + rest;

  return result;
}

/**
 * Convert year to Hebrew words
 * 2024 → "אלפיים עשרים וארבעה" (two thousand twenty-four)
 */
function convertYearToHebrewWords(year: number): string {
  if (year >= 2000 && year < 3000) {
    // Modern years: 2024 → "אלפיים עשרים וארבעה"
    const thousands = Math.floor(year / 1000);
    const remainder = year % 1000;

    const thousandsWords = thousands === 2 ? 'אלפיים' : `${convertNumberToHebrewWords(thousands)} אלפים`;

    if (remainder === 0) {
      return thousandsWords;
    } else if (remainder < 100) {
      // 2024 → "אלפיים עשרים וארבעה"
      return `${thousandsWords} ${convertNumberToHebrewWords(remainder)}`;
    } else {
      // 2124 → "אלפיים מאה עשרים וארבעה"
      const hundreds = Math.floor(remainder / 100);
      const tens = remainder % 100;
      const hundredsWords = hundreds === 1 ? 'מאה' : `${convertNumberToHebrewWords(hundreds)} מאות`;

      if (tens === 0) {
        return `${thousandsWords} ${hundredsWords}`;
      }
      return `${thousandsWords} ${hundredsWords} ${convertNumberToHebrewWords(tens)}`;
    }
  }

  // For other years, just say digits
  return year.toString().split('').map((d: string) => convertNumberToHebrewWords(parseInt(d, 10))).join(' ');
}

/**
 * Convert number to Hebrew words (simple version for dates)
 */
function convertNumberToHebrewWords(num: number): string {
  if (num === 0) return 'אפס';
  if (num === 1) return 'אחד';
  if (num === 2) return 'שניים';
  if (num === 3) return 'שלושה';
  if (num === 4) return 'ארבעה';
  if (num === 5) return 'חמישה';
  if (num === 6) return 'שישה';
  if (num === 7) return 'שבעה';
  if (num === 8) return 'שמונה';
  if (num === 9) return 'תשעה';
  if (num === 10) return 'עשרה';
  if (num === 11) return 'אחד עשר';
  if (num === 12) return 'שנים עשר';
  if (num === 20) return 'עשרים';
  if (num === 24) return 'עשרים וארבעה';
  if (num === 30) return 'שלושים';
  if (num === 31) return 'שלושים ואחד';

  // For other numbers, approximate
  if (num < 20) return `${num}`; // Fallback
  const tens = Math.floor(num / 10) * 10;
  const ones = num % 10;
  const tensWords = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
  const onesWords = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה'];

  if (ones === 0) return tensWords[Math.floor(num / 10)];
  return `${tensWords[Math.floor(num / 10)]} ו${onesWords[ones]}`;
}

/**
 * Get the phonetic name of a Hebrew letter
 */
function getHebrewLetterName(letter: string): string {
  const letterNames: Record<string, string> = {
    'א': 'אלף',
    'ב': 'בית',
    'ג': 'גימל',
    'ד': 'דלת',
    'ה': 'הא',
    'ו': 'וו',
    'ז': 'זיין',
    'ח': 'חת',
    'ט': 'טת',
    'י': 'יוד',
    'כ': 'כף',
    'ך': 'כף סופית',
    'ל': 'למד',
    'מ': 'מם',
    'ם': 'מם סופית',
    'נ': 'נון',
    'ן': 'נון סופית',
    'ס': 'סמך',
    'ע': 'עין',
    'פ': 'פא',
    'ף': 'פא סופית',
    'צ': 'צדיק',
    'ץ': 'צדיק סופית',
    'ק': 'קוף',
    'ר': 'ריש',
    'ש': 'שין',
    'ת': 'תו',
  };

  return letterNames[letter] || letter;
}

/**
 * Convert time formats to Hebrew-friendly TTS format
 * Handles both ranges and single times naturally
 */
function normalizeTimesForTTS(text: string): string {
  // First, handle time ranges (e.g., "08:00 - 11:45" or "08:00-11:45")
  text = text.replace(/\b(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\b/g,
    (match, h1, m1, h2, m2) => {
      const startTime = formatHebrewTime(parseInt(h1, 10), parseInt(m1, 10));
      const endTime = formatHebrewTime(parseInt(h2, 10), parseInt(m2, 10), true);
      return `מ${startTime} עד ${endTime}`;
    }
  );

  // Then, handle remaining single times
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (match, h, m) => {
    return formatHebrewTime(parseInt(h, 10), parseInt(m, 10));
  });

  return text;
}

/**
 * Format a time in Hebrew
 * @param hour - Hour (0-23)
 * @param minute - Minute (0-59)
 * @param isEndTime - If true, uses "quarter to" format for :45 times
 */
function formatHebrewTime(hour: number, minute: number, isEndTime: boolean = false): string {
  const hours: Record<number, string> = {
    0: 'חצות',
    1: 'אחת',
    2: 'שתיים',
    3: 'שלוש',
    4: 'ארבע',
    5: 'חמש',
    6: 'שש',
    7: 'שבע',
    8: 'שמונה',
    9: 'תשע',
    10: 'עשר',
    11: 'אחת עשרה',
    12: 'שתים עשרה',
    13: 'אחת',
    14: 'שתיים',
    15: 'שלוש',
    16: 'ארבע',
    17: 'חמש',
    18: 'שש',
    19: 'שבע',
    20: 'שמונה',
    21: 'תשע',
    22: 'עשר',
    23: 'אחת עשרה',
  };

  const hourText = hours[hour] || hour.toString();

  // Handle special minutes
  if (minute === 0) {
    return hourText; // "שמונה" (8:00)
  } else if (minute === 30) {
    return `${hourText} וחצי`; // "שמונה וחצי" (8:30)
  } else if (minute === 15) {
    return `${hourText} ורבע`; // "שמונה ורבע" (8:15)
  } else if (minute === 45) {
    // For end times, use natural "quarter to" format
    if (isEndTime) {
      const nextHour = (hour + 1) % 24;
      const nextHourText = hours[nextHour] || nextHour.toString();
      return `רבע ל${nextHourText}`; // "רבע לשתים עשרה" (quarter to twelve)
    } else {
      return `${hourText} ורבע`; // "שמונה ורבע" (8:45 as standalone)
    }
  } else if (minute >= 1 && minute <= 9) {
    // For single-digit minutes (01-09), add "zero" for clarity
    // "13:05" → "אחת ואפס חמש" (one zero five)
    const minuteText = convertMinutesToHebrew(minute);
    return `${hourText} ואפס ${minuteText}`;
  } else {
    // For other minutes (10-59, excluding special cases above)
    return `${hourText} ו${convertMinutesToHebrew(minute)}`;
  }
}

/**
 * Convert minutes (1-59) to Hebrew words
 */
function convertMinutesToHebrew(minute: number): string {
  const ones = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע'];
  const tens = ['', 'עשר', 'עשרים', 'שלושים', 'ארבעים', 'חמישים'];

  if (minute < 10) {
    return ones[minute];
  } else if (minute < 20) {
    // 10-19: special cases
    const teens = ['עשר', 'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה',
                   'חמש עשרה', 'שש עשרה', 'שבע עשרה', 'שמונה עשרה', 'תשע עשרה'];
    return teens[minute - 10];
  } else {
    // 20-59: combine tens and ones
    const tensDigit = Math.floor(minute / 10);
    const onesDigit = minute % 10;
    if (onesDigit === 0) {
      return tens[tensDigit];
    } else {
      return `${tens[tensDigit]} ו${ones[onesDigit]}`;
    }
  }
}

/**
 * Add natural pauses for better TTS flow
 * Conservative approach - only essential pauses
 */
function addNaturalPauses(text: string): string {
  let result = text;

  // 1. Pause after greetings at the start
  result = result.replace(/^(בוקר טוב|ערב טוב|צהריים טובים|לילה טוב)([,!]?\s+)/m, '$1... ');

  // 2. Major section breaks (double newlines) → medium pause
  result = result.replace(/\n\n+/g, '. ');

  // 3. Single newlines → keep natural flow, just replace with space
  result = result.replace(/\n/g, ' ');

  // 4. Pause before summary headers (common patterns in calendar summaries)
  result = result.replace(/\s+(לסיכום|שימו לב|חשוב):/g, '... $1:');

  // 5. Brief pause before time ranges in event descriptions
  // Pattern: Hebrew text followed by time range
  result = result.replace(/([א-ת])\s+(מ[א-ת]+\s+עד\s+[א-ת]+)/g, '$1, $2');

  // Cleanup: excessive spaces
  result = result.replace(/\s{2,}/g, ' ');

  return result.trim();
}

/**
 * Transliterate common English words to Hebrew phonetics for TTS
 * Helps TTS pronounce English names/terms that would otherwise be skipped
 */
function transliterateEnglishToHebrew(text: string): string {
  // Common English terms in calendar events with Hebrew phonetic equivalents
  const transliterations: Record<string, string> = {
    // Common calendar terms
    'meeting': 'מיטינג',
    'zoom': 'זום',
    'call': 'קול',
    'doctor': 'דוקטור',
    'pickup': 'פיקאפ',
    'drop': 'דרופ',
    'dropoff': 'דרופ-אוף',
    'school': 'סקול',
    'office': 'אופיס',
    'park': 'פארק',
    'mall': 'מול',
    'gym': 'ג\'ים',
    'pool': 'פול',
    'class': 'קלאס',
    'lesson': 'לסון',
    'appointment': 'אפוינטמנט',
    'birthday': 'בירת\'דיי',
    'party': 'פארטי',

    // Days of week (in case they appear in English)
    'sunday': 'סאנדיי',
    'monday': 'מאנדיי',
    'tuesday': 'טיוזדיי',
    'wednesday': 'ונזדיי',
    'thursday': 'ת\'רסדיי',
    'friday': 'פריידיי',
    'saturday': 'סאטרדיי',

    // Tech/apps
    'google': 'גוגל',
    'teams': 'טימס',
    'skype': 'סקייפ',
    'whatsapp': 'ווטסאפ',
  };

  // Replace whole words (case-insensitive, preserve word boundaries)
  let result = text;
  for (const [english, hebrew] of Object.entries(transliterations)) {
    const regex = new RegExp(`\\b${english}\\b`, 'gi');
    result = result.replace(regex, hebrew);
  }

  // For remaining English words: add spaces around them to help TTS separate them
  // This helps the model understand they're distinct entities
  result = result.replace(/\b([a-zA-Z]{2,})\b/g, ' $1 ').replace(/\s+/g, ' ').trim();

  return result;
}
