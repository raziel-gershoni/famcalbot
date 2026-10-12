/**
 * Turns a text summary into the two-host show voice note: writer → validator →
 * pointing → TTS (remote or local) → OGG. Any failure propagates to the caller's
 * "voice unavailable" path.
 */

import type { UserConfig } from '../../types';
import { hasShowPrompt } from '../../prompts/voice-show';
import { formatShowCaption } from '../../utils/ai-footer';
import { generateShowVoice, getShowVoices, type ShowVoiceDeps } from '../voice-generator';
import { buildShowContext } from './context';
import { toShowLines } from './script';
import type { ProducedVoice, ShowKind } from './types';
import { writeShowScript, type CompletionFn } from './writer';

/** A language gets the show when it has both a writer prompt and host voices. */
export function isShowLanguage(language: string): boolean {
  return hasShowPrompt(language) && getShowVoices(language) !== null;
}

/** Test seams for the LLM and the per-line TTS call. */
export interface ProduceShowDeps {
  complete?: CompletionFn;
  synthesize?: ShowVoiceDeps['synthesize'];
}

export async function produceShowVoice(
  summary: string,
  user: UserConfig,
  kind: ShowKind,
  isNextWeek = false,
  deps: ProduceShowDeps = {},
): Promise<ProducedVoice> {
  const language = user.language || 'en';
  const context = buildShowContext(summary, user, kind, isNextWeek);
  const written = await writeShowScript(context, { complete: deps.complete });
  const { turns, warnings } = written.script;
  if (warnings.length) console.warn(`[VoiceShow] Script repaired for user ${user.id}:`, warnings);
  console.log(`[VoiceShow] ${kind} script for user ${user.id}: ${turns.length} turns from ${summary.length} chars`);

  const show = await generateShowVoice(toShowLines(turns, language, context.listener.gender), language, {
    synthesize: deps.synthesize,
  });
  return {
    filePath: show.filePath,
    caption: formatShowCaption(written.completion, written.attempts, show, user.isAdmin),
    durationSeconds: Math.max(1, Math.round(show.audioSeconds)),
  };
}
