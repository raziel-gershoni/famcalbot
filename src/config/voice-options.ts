/**
 * Available TTS voices per language for the settings UI dropdown.
 * Voice names correspond to Gemini TTS prebuilt voices.
 */

// Default voice per language (must match VOICE_CONFIG in voice-generator.ts)
const LANGUAGE_DEFAULTS: Record<string, string> = {
  he: 'Algieba',
  en: 'Achird',
  ru: 'Schedar',
};

export const VOICE_OPTIONS: Record<string, { value: string; label: string }[]> = {
  he: [
    { value: 'default', label: 'Default (Algieba)' },
    { value: 'Algieba', label: 'Algieba' },
    { value: 'Schedar', label: 'Schedar' },
    { value: 'Sulafat', label: 'Sulafat' },
    { value: 'Puck', label: 'Puck' },
    { value: 'Kore', label: 'Kore' },
  ],
  en: [
    { value: 'default', label: 'Default (Achird)' },
    { value: 'Achird', label: 'Achird' },
    { value: 'Puck', label: 'Puck' },
    { value: 'Kore', label: 'Kore' },
    { value: 'Algieba', label: 'Algieba' },
    { value: 'Sulafat', label: 'Sulafat' },
  ],
  ru: [
    { value: 'default', label: 'Default (Schedar)' },
    { value: 'Schedar', label: 'Schedar' },
    { value: 'Algieba', label: 'Algieba' },
    { value: 'Puck', label: 'Puck' },
    { value: 'Kore', label: 'Kore' },
  ],
};

/**
 * Resolve "default" to the actual voice name for the given language.
 */
export function getVoiceForUser(language: string, voicePreference: string): string {
  if (!voicePreference || voicePreference === 'default') {
    return LANGUAGE_DEFAULTS[language] || LANGUAGE_DEFAULTS['en'] || 'Achird';
  }
  return voicePreference;
}
