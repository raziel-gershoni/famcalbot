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

export interface VoiceOptions {
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
    const response = await openai.audio.speech.create({
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
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const elapsed = Date.now() - startTime;
    console.log('Voice generated successfully:', {
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
    .replace(/\n\n+/g, '\n\n') // Normalize multiple newlines
    .trim();
}
