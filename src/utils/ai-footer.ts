import { AICompletionResult } from '../services/ai-provider';

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
  voiceStyle?: string,
): string | undefined {
  if (!isAdmin) return undefined;
  const condenser = `🎙 ${buildMetricsParts(condenserResult).join(' | ')}`;
  const voicePart = voiceName ? ` | ${voiceName}` : '';
  const stylePart = voiceStyle && voiceStyle !== 'natural' ? ` | style:${voiceStyle}` : '';
  const tts = `🔊 TTS ${ttsModel}${voicePart}${stylePart} | ${(ttsMs / 1000).toFixed(1)}s`;
  return `${condenser}\n${tts}`;
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
