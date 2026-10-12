import type { AICompletionResult } from '../services/ai-provider';
import type { ShowVoiceResult } from '../services/voice-generator';
import { getTtsModelConfig } from '../config/tts-models';

export function formatAdminFooter(result: AICompletionResult, isAdmin: boolean): string {
  if (!isAdmin) return '';
  return `\n\n<i>📊 ${buildMetricsParts(result).join(' | ')}</i>`;
}

export function formatVoiceCaption(
  condenserResult: AICompletionResult,
  ttsMs: number,
  ttsModel: string,
  isAdmin: boolean,
  voiceName?: string,
): string | undefined {
  if (!isAdmin) return undefined;
  const condenser = `🎙 ${buildMetricsParts(condenserResult).join(' | ')}`;
  const voicePart = voiceName ? ` | ${voiceName}` : '';
  const tts = `🔊 TTS ${ttsModel}${voicePart} | ${(ttsMs / 1000).toFixed(1)}s`;
  return `${condenser}\n${tts}`;
}

/** Admin caption for the two-host show: the writer's metrics, then the TTS side. */
export function formatShowCaption(
  writer: AICompletionResult,
  writerAttempts: number,
  show: Pick<ShowVoiceResult, 'ttsMs' | 'ttsModel' | 'voices' | 'lineCount' | 'audioSeconds' | 'audioTokens' | 'via'>,
  isAdmin: boolean,
): string | undefined {
  if (!isAdmin) return undefined;
  const rewritten = writerAttempts > 1 ? ` | rewritten x${writerAttempts - 1}` : '';
  const tts = [
    `🔊 TTS ${show.ttsModel}`,
    `A:${show.voices.A} B:${show.voices.B}`,
    `${show.lineCount} lines`,
    `${show.audioSeconds.toFixed(0)}s audio`,
    `${(show.ttsMs / 1000).toFixed(1)}s`,
    show.via,
  ];
  const cost = estimateTtsCost(show.ttsModel, show.audioTokens);
  if (cost !== null) tts.push(`~$${cost.toFixed(4)}`);
  return `🎙 ${buildMetricsParts(writer).join(' | ')}${rewritten}\n${tts.join(' | ')}`;
}

/** USD for a TTS call's output audio tokens; null when the model or the count is unknown. */
export function estimateTtsCost(model: string, audioTokens: number): number | null {
  const config = getTtsModelConfig(model);
  if (!config || !audioTokens) return null;
  return (audioTokens * config.costPer1MAudioTokens) / 1_000_000;
}

function buildMetricsParts(result: AICompletionResult): string[] {
  const parts: string[] = [result.model];
  if (result.thinkingLevel) parts.push(`think:${result.thinkingLevel}`);
  let tok = `${result.usage.inputTokens}→${result.usage.outputTokens}`;
  if (result.usage.thinkingTokens) tok += `+${result.usage.thinkingTokens}t`;
  if (result.usage.cacheReadTokens) tok += ` (cache:${result.usage.cacheReadTokens})`;
  parts.push(tok + ' tok');
  parts.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  return parts;
}
