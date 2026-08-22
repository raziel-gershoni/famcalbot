// Quick-correction shortcut buttons (deferred polish from PR 10).
//
// Tapping ⏰ Time / 📅 Day / 📁 Cal on a pending confirmation card stashes
// `{ pendingId, field, messageId }` in Redis and prompts the user to reply
// with just that field. The next user message (text or voice) is routed
// through a focused field-extraction call to Gemini — much narrower scope
// than the full event-extraction prompt.
//
// On success the pending event in Redis is patched and the existing
// confirmation card is edited in place (TG editMessageText).

import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { getGemini } from '../ai-provider';
import { getModelConfig, FALLBACK_MODEL_ID } from '../../config/ai-models';
import { getDefaultAiModelSetting } from '../reminder-cache';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import type { ParsedEvent } from '../event-parser';
import type { CalendarAssignment } from '../../types';

export type QuickField = 'time' | 'day' | 'cal';
const QUICK_TTL_SECONDS = 120; // 2 minutes — enough to read the prompt and reply
const FIELD_MODEL_FALLBACK = FALLBACK_MODEL_ID;

interface QuickPayload {
  pendingId: string;
  field: QuickField;
  // The TG message id of the confirmation card so we can edit it in place.
  messageId: number;
}

export async function setQuickCorrection(chatId: number, payload: QuickPayload): Promise<void> {
  await redis.set(REDIS_KEYS.quickCorrection(chatId), payload, { ex: QUICK_TTL_SECONDS });
}

export async function getQuickCorrection(chatId: number): Promise<QuickPayload | null> {
  const data = await redis.get<QuickPayload>(REDIS_KEYS.quickCorrection(chatId));
  return data ?? null;
}

export async function clearQuickCorrection(chatId: number): Promise<void> {
  await redis.del(REDIS_KEYS.quickCorrection(chatId));
}

export interface FieldPatch {
  startTime?: Date;
  endTime?: Date;
  calendarId?: string;
  calendarName?: string;
}

/**
 * Build a focused prompt for a single field. Much shorter than the full
 * event-extraction prompt; we only need to extract the one piece of info
 * the user clarified.
 */
function buildFieldPrompt(
  field: QuickField,
  current: ParsedEvent,
  calendars: CalendarAssignment[],
  language: string,
  timezone: string
): string {
  const now = new Date();
  const currentDateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  });
  const currentTimeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });

  const calList = calendars.map((c) => `- "${c.name}" (ID: ${c.calendarId})`).join('\n');

  const eventCtx = `Current event: "${current.title}" — ${current.startTime.toISOString()} to ${current.endTime.toISOString()}`;

  let fieldHint = '';
  if (field === 'time') {
    fieldHint = `The user is correcting just the START TIME (and end time = start + duration). Return JSON: { "startTime": "HH:MM", "endTime": "HH:MM" }. The date stays the same as the current event.`;
  } else if (field === 'day') {
    fieldHint = `The user is correcting just the DATE. Return JSON: { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }. The time stays the same as the current event.`;
  } else if (field === 'cal') {
    fieldHint = `The user is correcting just the CALENDAR. Return JSON: { "calendarId": "matched id", "calendarName": "matched name" }.\n\nUSER'S CALENDARS:\n${calList}`;
  }

  return `You are a calendar assistant patching a single field of an event. The user is replying with a focused correction.

CURRENT DATE/TIME: ${currentDateStr} at ${currentTimeStr} (timezone: ${timezone})
USER LANGUAGE: ${language}
${eventCtx}

${fieldHint}

Listen to the user's audio (or read the text) and extract only the requested field. Respond with JSON only — no markdown.`;
}

/**
 * Extract the patch from the user's correction utterance. Single-field
 * Gemini call with a much shorter prompt than the full pipeline.
 */
export async function extractFieldPatch(
  field: QuickField,
  audioBuffer: Buffer | null,
  textInput: string | null,
  current: ParsedEvent,
  calendars: CalendarAssignment[],
  language: string,
  timezone: string
): Promise<FieldPatch | null> {
  const adminDefault = await getDefaultAiModelSetting();
  let modelId = FIELD_MODEL_FALLBACK;
  if (adminDefault) {
    const cfg = getModelConfig(adminDefault);
    if (cfg) modelId = cfg.modelId;
  } else if (process.env.AI_MODEL) {
    const cfg = getModelConfig(process.env.AI_MODEL);
    if (cfg) modelId = cfg.modelId;
  }

  const prompt = buildFieldPrompt(field, current, calendars, language, timezone);
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: prompt }];
  if (audioBuffer) {
    parts.push({ inlineData: { mimeType: 'audio/ogg', data: audioBuffer.toString('base64') } });
  } else if (textInput) {
    parts.push({ text: `\n\nUSER'S CORRECTION: "${textInput}"` });
  } else {
    return null;
  }

  try {
    const response = await getGemini().models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts }],
    });
    const responseText = response.text ?? '';
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonSource = codeBlockMatch ? codeBlockMatch[1] : responseText;
    const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    const out: FieldPatch = {};
    if (field === 'time' && parsed.startTime && parsed.endTime) {
      // Reuse existing date from current event — IN THE USER'S TIMEZONE,
      // not UTC, so an event near local midnight doesn't slip a day.
      const datePart = formatInTimeZone(current.startTime, timezone, 'yyyy-MM-dd');
      out.startTime = fromZonedTime(`${datePart}T${parsed.startTime}:00`, timezone);
      out.endTime = fromZonedTime(`${datePart}T${parsed.endTime}:00`, timezone);
    } else if (field === 'day' && parsed.startDate) {
      // Reuse existing time from current event — IN THE USER'S TIMEZONE.
      const startTimePart = formatInTimeZone(current.startTime, timezone, 'HH:mm');
      const endTimePart = formatInTimeZone(current.endTime, timezone, 'HH:mm');
      const endDate = parsed.endDate || parsed.startDate;
      out.startTime = fromZonedTime(`${parsed.startDate}T${startTimePart}:00`, timezone);
      out.endTime = fromZonedTime(`${endDate}T${endTimePart}:00`, timezone);
    } else if (field === 'cal' && parsed.calendarId) {
      // Validate against user's calendars; fall back to name match.
      const matched = calendars.find((c) => c.calendarId === parsed.calendarId)
        || calendars.find((c) => c.name?.toLowerCase() === (parsed.calendarName || '').toLowerCase());
      if (matched) {
        out.calendarId = matched.calendarId;
        out.calendarName = matched.name;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (err) {
    console.error('[QuickCorrection] Field extraction failed:', err);
    return null;
  }
}
