# Image → Calendar Event Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user send an event-invitation photo to the Telegram bot and have it create a calendar event automatically, mirroring the existing voice and forwarded-text flows.

**Architecture:** Add a third input modality to the front of the existing pipeline. A new `image-event/` module (twin of `forward-event/`) turns a photo into a `VoiceIntentResult` via Gemini vision, then hands off to the already-modality-agnostic shared seam (`showEventConfirmation` / `autoCreateEvent` / `showBulkConfirmation` → the create callback → Google Calendar). Everything downstream of that seam is unchanged.

**Tech Stack:** Next.js 16, TypeScript, `@google/genai` (Gemini, natively multimodal), Telegram Bot API, Redis (Upstash), Prisma/Neon.

## Global Constraints

- **No new dependencies.** Gemini vision uses the existing `@google/genai` SDK and existing models (`gemini-3.5-flash` default, `gemini-3-flash-preview` fallback — both multimodal). No SDK/model changes.
- **No DB migration.** Gating reuses the existing `'voice_events'` feature key and `incrementUsage('voiceEvents')` counter.
- **Verification is typecheck + build + lint + manual QA.** This repo has no test framework (zero `*.test.ts`, no test runner in `package.json`). Do not add one. Each task ends by running `npx tsc --noEmit`.
- **i18n must sound natural per language** (en/he/ru), not literally translated. Messages live in `messages/{locale}.json` under the `bot` key (untyped JSON).
- **Never voice-out image events.** Image confirmations pass `inputModality: 'image'`; the callback only voices `'voice'`.
- **Image mode returns only `create` or `none` intents** — never `edit`/`delete`.
- **Auto-create rides the existing shared admin flag** `voiceAutoCreateHighConf` (via `isAutoCreateEnabled()`), default off. Do NOT change its default (it also governs voice). Out of the box, images show the confirmation card.

---

### Task 1: Generalize the Telegram file-download helper

**Files:**
- Modify: `src/services/voice/event-resolution.ts:20-40`

**Interfaces:**
- Produces: `downloadTelegramFile(fileId: string): Promise<Buffer>` — generic Telegram CDN download. `downloadVoiceFile` kept as a delegating alias so voice call-sites don't churn.

- [ ] **Step 1: Add the generic helper and make `downloadVoiceFile` delegate**

Replace the existing `downloadVoiceFile` (lines 20-40) with:

```ts
/**
 * Download any file from the Telegram CDN by file_id (voice, photo, document).
 */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const bot = getBot();

  const fileInfo = await bot.getFile(fileId);
  const filePath = fileInfo.file_path;

  if (!filePath) {
    throw new Error('Could not get file path from Telegram');
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Download a voice file from Telegram CDN (thin alias over downloadTelegramFile).
 */
export async function downloadVoiceFile(fileId: string): Promise<Buffer> {
  return downloadTelegramFile(fileId);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

---

### Task 2: Add `image` mode to the shared extraction prompt + export multi-event splitter

**Files:**
- Modify: `src/services/voice/gemini-voice.ts:25-31` (mode param), `:51-59` (mode instructions), `:114` and `:128` (JSON envelope conditionals), `:211-225` (mode examples), and the `extractIntents` declaration (add `export`).

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildEventExtractionPrompt(language, calendars, timezone, mode: 'voice' | 'text' | 'image', recentEventsBlock?)`; `extractIntents(parsed, calendars, timezone): VoiceIntentResult[]` now exported.

- [ ] **Step 1: Widen the `mode` parameter type**

At `src/services/voice/gemini-voice.ts:29`, change:

```ts
  mode: 'voice' | 'text' = 'voice',
```
to:
```ts
  mode: 'voice' | 'text' | 'image' = 'voice',
```

- [ ] **Step 2: Add image-mode instructions**

Replace the `modeInstructions` assignment (`:51-59`) with a three-way branch:

```ts
  const modeInstructions = mode === 'voice'
    ? `You are a calendar assistant. Listen to the attached audio message and:
1. Transcribe what the user said
2. Determine the user's intent (create, edit, or delete a calendar event)
3. Extract structured event data based on the intent`
    : mode === 'image'
    ? `You are a calendar assistant. The user sent an IMAGE of an event invitation, flyer, poster, or a screenshot. Read ALL text visible in the image (OCR) — it may be in Hebrew (right-to-left), Russian, or English — and:
1. Determine whether the image describes a calendar event (intent "create") or not (intent "none").
2. Extract structured event data for the event.

IMAGE-SPECIFIC RULES:
- If the image is NOT an event (a meme, a random photo, a screenshot with no event details), return intent "none".
- Extract the ACTUAL event date and start time. If the invitation also shows an RSVP / reply-by / confirmation deadline (e.g. "אישור הגעה", "RSVP by", "просьба подтвердить до"), that is NOT the event date — never use it as the event start; you may mention it in "description".
- If the year is not printed, choose the nearest FUTURE date consistent with the current date/time below.
- Put the venue name and/or address into "location".
- CONFIDENCE: return "high" ONLY when the event date AND start time are explicitly and unambiguously printed. If you had to infer the year, guess the time, or you are unsure whether a printed date is the event date or an RSVP date, return "medium" or "low". (Lower confidence routes the event to a manual confirmation card instead of auto-creating it.)
- Intent is ONLY "create" or "none" — never "edit" or "delete" for an image.`
    : `You are a calendar assistant. Parse the following forwarded text message and extract calendar event information.
The text may be conversational (e.g. "Hey, can you come to dinner at our place on Friday at 7pm?"). Look for dates, times, event names, and locations.
1. Determine the intent (create, edit, delete, or none if no event information found)
2. Extract structured event data based on the intent`;
```

- [ ] **Step 3: Constrain the image-mode intent enum in the JSON envelope**

At `:128`, change:

```ts
  "intent": ${mode === 'voice' ? '"create" | "edit" | "delete"' : '"create" | "edit" | "delete" | "none"'},
```
to:
```ts
  "intent": ${mode === 'voice' ? '"create" | "edit" | "delete"' : mode === 'image' ? '"create" | "none"' : '"create" | "edit" | "delete" | "none"'},
```

(The `transcription` conditional at `:114` — `mode === 'voice' ? … : ''` — already correctly omits transcription for image mode. Leave it.)

- [ ] **Step 4: Add image-mode few-shot examples**

At the end of the returned template string (`:211-225`), the examples currently append `(mode === 'text' ? …text examples… : '')`. Add an image branch after it:

```ts
` + (mode === 'text' ? `

ADDITIONAL TEXT-MODE EXAMPLES:

Input text: "Hey, can we do dinner at my place on Friday at 7pm?"
Output: {"intent": "create", "confidence": "high", "event": {"title": "Dinner", "startDate": "YYYY-MM-DD", "startTime": "19:00", "endDate": "YYYY-MM-DD", "endTime": "21:00", "allDay": false, "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Input text: "Don't forget - parent-teacher meeting next Tuesday at 16:30 in room 204"
Output: {"intent": "create", "confidence": "high", "event": {"title": "Parent-teacher meeting", "startDate": "YYYY-MM-DD", "startTime": "16:30", "endDate": "YYYY-MM-DD", "endTime": "17:30", "allDay": false, "location": "Room 204", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Input text: "haha that's hilarious 😂"
Output: {"intent": "none", "confidence": "high", "error": "No calendar event information found in this message."}

Input text: "The meeting tomorrow is pushed to 3pm instead"
Output: {"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "meeting", "timeHint": "tomorrow"}, "editRequest": {"newStartTime": "15:00", "newEndTime": "16:00"}}` : '') + (mode === 'image' ? `

ADDITIONAL IMAGE-MODE EXAMPLES (the actual input is the attached image; these show the expected OUTPUT):

Image: a birthday invitation reading "You're invited! Noa turns 5 — Saturday, March 14 at 17:00, Gymboree Hall, Herzliya. RSVP by March 1."
Output: {"intent": "create", "confidence": "high", "event": {"title": "Noa's 5th birthday", "startDate": "YYYY-03-14", "startTime": "17:00", "endDate": "YYYY-03-14", "endTime": "19:00", "allDay": false, "location": "Gymboree Hall, Herzliya", "description": "RSVP by March 1", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Image: a wedding invitation in Hebrew with the date printed but no time.
Output: {"intent": "create", "confidence": "medium", "event": {"title": "Wedding", "startDate": "YYYY-MM-DD", "startTime": "19:00", "endDate": "YYYY-MM-DD", "endTime": "23:00", "allDay": false, "location": "...", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Image: a photo of a cat with no text.
Output: {"intent": "none", "confidence": "high", "error": "No event found in this image."}` : '');
```

- [ ] **Step 5: Export `extractIntents`**

Find the `extractIntents` declaration (just after the `sleep` helper, ~`:236`) and add the `export` keyword:

```ts
export function extractIntents(
```

(It is currently module-private; `processImageWithGemini` in Task 3 needs it for multi-event flyers.)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

---

### Task 3: Image Gemini processor

**Files:**
- Create: `src/services/image-event/gemini-image.ts`

**Interfaces:**
- Consumes: `buildEventExtractionPrompt`, `parseGeminiEventResponse`, `extractIntents` from `../voice/gemini-voice`; `getGemini` from `../ai-provider`; `getDefaultAiModelSetting` from `../reminder-cache`; `getModelConfig` from `../../config/ai-models`.
- Produces: `processImageWithGemini(imageBuffer, mimeType, caption, language, calendars, timezone): Promise<{ intentResult: VoiceIntentResult; intentResults?: VoiceIntentResult[]; metrics: ImageProcessingMetrics }>`.

- [ ] **Step 1: Create the processor**

```ts
/**
 * Gemini Image Processing for invitation photos
 * Single multimodal API call: OCR + intent detection + event extraction.
 * Twin of processTextWithGemini, but sends an image inlineData part.
 */

import { getGemini } from '../ai-provider';
import { VoiceIntentResult } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { getDefaultAiModelSetting } from '../reminder-cache';
import { getModelConfig } from '../../config/ai-models';
import { buildEventExtractionPrompt, parseGeminiEventResponse, extractIntents } from '../voice/gemini-voice';

const IMAGE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

const IMAGE_MODEL_FALLBACK = 'gemini-3-flash-preview';

export interface ImageProcessingMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process an invitation image with Gemini.
 * @param imageBuffer raw image bytes
 * @param mimeType e.g. 'image/jpeg'
 * @param caption optional user caption sent with the photo (extra context)
 */
export async function processImageWithGemini(
  imageBuffer: Buffer,
  mimeType: string,
  caption: string | undefined,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
): Promise<{ intentResult: VoiceIntentResult; intentResults?: VoiceIntentResult[]; metrics: ImageProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  // Resolve model: admin setting → env var → hardcoded fallback
  const adminDefault = await getDefaultAiModelSetting();
  let resolvedModelId = IMAGE_MODEL_FALLBACK;
  if (adminDefault) {
    const cfg = getModelConfig(adminDefault);
    if (cfg) resolvedModelId = cfg.modelId;
  } else if (process.env.AI_MODEL) {
    const cfg = getModelConfig(process.env.AI_MODEL);
    if (cfg) resolvedModelId = cfg.modelId;
  }

  for (let attempt = 0; attempt <= IMAGE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'image')
        + (caption?.trim() ? `\n\nUSER CAPTION (extra context):\n${caption.trim()}` : '');

      const response = await getGemini().models.generateContent({
        model: resolvedModelId,
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText },
              { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
            ],
          },
        ],
      });

      const duration = Date.now() - startTime;
      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(`[Image Gemini] Response in ${duration}ms, model: ${resolvedModelId}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

      // response.text getter can throw if no candidates are present
      let responseText: string;
      try {
        responseText = response.text ?? '';
      } catch {
        throw new Error('Gemini returned empty response');
      }
      if (!responseText) {
        throw new Error('Gemini returned empty response');
      }

      // Extract JSON from response (may be wrapped in markdown code blocks)
      let jsonSource = responseText;
      const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonSource = codeBlockMatch[1];
      }
      const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to extract JSON from Gemini response');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any = JSON.parse(jsonMatch[0]);
      const intentResults = extractIntents(parsed, calendars, timezone);
      const intentResult = intentResults[0];

      return {
        intentResult,
        intentResults,
        metrics: { model: resolvedModelId, inputTokens, outputTokens, durationMs: duration },
      };

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < IMAGE_RETRY_CONFIG.maxRetries) {
        const delay = IMAGE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[Image Gemini] Error (attempt ${attempt + 1}/${IMAGE_RETRY_CONFIG.maxRetries + 1}), retrying in ${delay}ms:`, error);
        await sleep(delay);
      }
    }
  }

  console.error(`[Image Gemini] Failed after ${IMAGE_RETRY_CONFIG.maxRetries + 1} attempts:`, lastError);
  throw new Error(`Image processing failed: ${lastError?.message || 'Unknown error'}`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

---

### Task 4: Widen `inputModality` union + add i18n strings

**Files:**
- Modify: `src/services/voice/confirmations.ts` (the `showEventConfirmation` `inputModality` param and the pending-event payload interface/type that carries `inputModality`).
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (add `bot.imageEvent`).

**Interfaces:**
- Produces: `inputModality: 'voice' | 'text' | 'image'` accepted by `showEventConfirmation` and stored in the pending-event payload. New i18n keys `bot.imageEvent.noEventFound` and `bot.imageEvent.fromImage`.

- [ ] **Step 1: Widen the `showEventConfirmation` parameter**

At `src/services/voice/confirmations.ts:321`, change:

```ts
  inputModality: 'voice' | 'text' = 'voice'
```
to:
```ts
  inputModality: 'voice' | 'text' | 'image' = 'voice'
```

- [ ] **Step 2: Widen the pending-event payload type**

Grep in `src/services/voice/confirmations.ts` for the interface/type that types the object stored via `REDIS_KEYS.pendingEvent` and returned by `getPendingEvent` (it has an `inputModality` field typed `'voice' | 'text'`). Widen that field to `'voice' | 'text' | 'image'`.

Run: `grep -n "inputModality" src/services/voice/confirmations.ts`
Change every `'voice' | 'text'` occurrence on an `inputModality` field/param to `'voice' | 'text' | 'image'`.

Note: the read-side comparison in `src/services/voice/callbacks.ts:124` (`pending.inputModality === 'voice'`) needs NO change — image correctly falls through to the no-voice-out path.

- [ ] **Step 3: Add the English strings**

In `messages/en.json`, inside the `bot` object (near the `voice` block, ~line 547), add an `imageEvent` object:

```json
    "imageEvent": {
      "noEventFound": "🤔 I couldn't find an event in that image. Try sending a clear photo of an invitation, flyer, or event details.",
      "fromImage": "an invitation image"
    },
```

- [ ] **Step 4: Add the Hebrew strings** (natural, not literal)

In `messages/he.json`, inside `bot`, add:

```json
    "imageEvent": {
      "noEventFound": "🤔 לא הצלחתי למצוא אירוע בתמונה. נסו לשלוח תמונה ברורה של הזמנה, פלייר או פרטי אירוע.",
      "fromImage": "תמונת הזמנה"
    },
```

- [ ] **Step 5: Add the Russian strings** (natural, not literal)

In `messages/ru.json`, inside `bot`, add:

```json
    "imageEvent": {
      "noEventFound": "🤔 Не удалось найти событие на этом изображении. Пришлите чёткое фото приглашения, афиши или деталей события.",
      "fromImage": "изображения приглашения"
    },
```

- [ ] **Step 6: Typecheck + validate JSON**

Run: `npx tsc --noEmit && node -e "for (const l of ['en','he','ru']) { const m = require('./messages/'+l+'.json'); if (!m.bot.imageEvent?.noEventFound) throw new Error('missing imageEvent in '+l); } console.log('i18n ok')"`
Expected: PASS + `i18n ok`.

---

### Task 5: Image message handler

**Files:**
- Create: `src/services/image-event/handler.ts`
- Create: `src/services/image-event/index.ts`

**Interfaces:**
- Consumes: `processImageWithGemini` (Task 3); `showEventConfirmation` (`../voice/confirmations`); `showBulkConfirmation` (`../voice/bulk-confirmations`); `autoCreateEvent`, `isAutoCreateEnabled` (`../voice/auto-create`); `downloadTelegramFile` (`../voice/event-resolution`); `checkFeatureAccess` (`../subscription-service`); `getUserByTelegramId` (`../user-service`); `hasUsableCalendar`, `getCalendarAssignmentsForUser` (`../calendar-provider`); `resolveUserTimezone` (`../../lib/timezone`); `getBotMessages` (`../../lib/bot-messages`); `getBot`, `getMessagingService` (`../telegram`); `startTypingInterval` (`../telegram/command-pipeline`).
- Produces: `handleImageMessage(chatId: number, userId: number, photo: TelegramPhotoSize, from: TelegramUser, caption?: string): Promise<void>`.

- [ ] **Step 1: Create the handler** (models `forward-event/handler.ts` + `voice/handler.ts` routing)

```ts
/**
 * Image message handler
 * Processes invitation photos for automatic event creation.
 * Twin of the forwarded-text and voice handlers; converges on the same
 * confirmation / auto-create seam.
 */

import { getBot, getMessagingService } from '../telegram';
import { getUserByTelegramId } from '../user-service';
import { MessageFormat } from '../messaging/types';
import { processImageWithGemini } from './gemini-image';
import { resolveUserTimezone } from '../../lib/timezone';
import { buildUrl } from '../../config/urls';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb, setUserContext } from '../analytics-service';
import { checkFeatureAccess } from '../subscription-service';
import { showEventConfirmation } from '../voice/confirmations';
import { downloadTelegramFile } from '../voice/event-resolution';
import { captureError } from '../../lib/error-capture';
import { startTypingInterval } from '../telegram/command-pipeline';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

/** Telegram PhotoSize (the highest-resolution entry of message.photo). */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * Handle an invitation photo for event creation.
 */
export async function handleImageMessage(
  chatId: number,
  userId: number,
  photo: TelegramPhotoSize,
  from: TelegramUser,
  caption?: string
): Promise<void> {
  console.log(`[Image] Starting image handler for user ${userId}`);
  const messagingService = getMessagingService();
  let user: Awaited<ReturnType<typeof getUserByTelegramId>> | null = null;
  let stopTyping: (() => void) | null = null;

  setUserContext(userId, from.first_name);
  addBreadcrumb('image_processing_started', { user_id: userId }, 'image');

  try {
    user = await getUserByTelegramId(userId);

    if (!user) {
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId, t.voice.notRegistered, { format: MessageFormat.PLAIN });
      return;
    }

    const t = await getBotMessages(user.language || 'en');

    // Reuse the same "AI event creation" toggle as voice / forwarded text.
    if (!user.voiceInputEnabled) {
      const bot = getBot();
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.id}`);
      await bot.sendMessage(chatId, t.voice.featureDisabled, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: t.voice.enableInSettings, web_app: { url: settingsUrl } }]],
        },
      });
      return;
    }

    const eventAccess = await checkFeatureAccess(user.id, 'voice_events');
    if (!eventAccess.allowed) {
      const bot = getBot();
      const upgradeUrl = buildUrl(`/${user.language || 'en'}/subscription?user_id=${user.id}`);
      const upgradeMessage = t.subscription?.voiceEventsRequired
        || '⭐ <b>Voice event creation is a Pro feature</b>\n\nUpgrade to Pro to create calendar events using voice messages!';
      await bot.sendMessage(chatId, upgradeMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: t.subscription?.upgradeButton || '⭐ Upgrade to Pro', web_app: { url: upgradeUrl } }]],
        },
      });
      return;
    }

    trackActivityAsync(user.id, 'image_event_started', { language: user.language });

    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
    if (!(await hasUsableCalendar(user))) {
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }
    const userCalendars = await getCalendarAssignmentsForUser(user);

    stopTyping = startTypingInterval(chatId, messagingService);

    console.log(`[Image] Downloading photo for user ${userId}, file_id: ${photo.file_id}`);
    const imageBuffer = await downloadTelegramFile(photo.file_id);
    console.log(`[Image] Downloaded ${imageBuffer.length} bytes`);

    const timezone = await resolveUserTimezone(user);
    const { intentResult, intentResults, metrics } = await processImageWithGemini(
      imageBuffer,
      'image/jpeg',
      caption,
      user.language || 'en',
      userCalendars,
      timezone
    );

    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;

    addBreadcrumb('image_intent_detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      has_event: !!intentResult.event,
    }, 'image');

    stopTyping();

    // Source label shown on the confirmation card (there is no transcription).
    const sourceLabel = caption?.trim() || t.imageEvent?.fromImage || 'an invitation image';

    // Multi-event flyer: 2+ valid CREATE intents → bulk card (never auto-creates).
    const validBulk = (intentResults || []).filter(r => r.intent === 'create' && r.event && !r.error);
    if (validBulk.length > 1) {
      const { showBulkConfirmation } = await import('../voice/bulk-confirmations');
      await showBulkConfirmation(chatId, validBulk, user, sourceLabel, t, messagingService, timezone);
      return;
    }

    if (intentResult.intent === 'create' && intentResult.event) {
      // Auto-create only for HIGH-confidence, non-recurring single events, and
      // only when the shared admin flag is on. The image prompt already
      // downgrades confidence on any ambiguity (RSVP-vs-event date, inferred
      // year), so "high" here means the date/time were explicit — the approved
      // ambiguity guard, expressed through the confidence channel.
      const { isAutoCreateEnabled, autoCreateEvent } = await import('../voice/auto-create');
      if (
        intentResult.confidence === 'high' &&
        !intentResult.event.recurrence &&
        (await isAutoCreateEnabled())
      ) {
        const handled = await autoCreateEvent(user, intentResult.event, t, messagingService, chatId);
        if (handled) return;
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, sourceLabel, user, adminFooter, 'image');
      return;
    }

    // intent === 'none' (or no event) → friendly reply, nothing created.
    await messagingService.sendMessage(
      chatId,
      t.imageEvent?.noEventFound || "🤔 I couldn't find an event in that image.",
      { format: MessageFormat.PLAIN }
    );

  } catch (error) {
    if (stopTyping) stopTyping();
    console.error('[Image] Error handling image message:', error);
    captureError(error, 'image-handler');

    if (user) {
      trackActivityAsync(user.id, 'image_event_failed', {
        error_type: error instanceof Error ? error.message : 'unknown',
      });
    }

    const errorMessages = await getBotMessages(user?.language || 'en');
    await messagingService.sendMessage(
      chatId,
      errorMessages.imageEvent?.noEventFound || errorMessages.voice.geminiError,
      { format: MessageFormat.PLAIN }
    );
  }
}
```

- [ ] **Step 2: Create the module barrel**

`src/services/image-event/index.ts`:

```ts
export { handleImageMessage } from './handler';
export type { TelegramPhotoSize } from './handler';
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. If `t.imageEvent` / `t.subscription` raise "possibly undefined", they are `Record<string, any>` (untyped) — optional chaining already used; no change needed.

---

### Task 6: Wire the webhook router

**Files:**
- Modify: `src/services/webhook-handlers.ts:66-72` (classifier), insert a photo branch after `:347` (the voice branch), and — if the update/message type is strict — extend it with `photo?` / `caption?`.

**Interfaces:**
- Consumes: `handleImageMessage` from `./image-event`; `acquireVoiceLock`, `releaseVoiceLock` from `../utils/redis-lock` (reused as generic string-keyed locks).

- [ ] **Step 1: Add `photo_message` to the classifier**

At `src/services/webhook-handlers.ts:69-72`, insert a photo clause after the voice clause:

```ts
    : update.message?.voice ? 'voice_message'
    : update.message?.photo ? 'photo_message'
    : isForwarded ? 'forwarded_message'
    : update.message?.text ? 'text_message'
    : 'unknown';
```

- [ ] **Step 2: Add the photo dispatch branch**

Immediately after the voice branch closes (after `:347`, before the forwarded-text branch at `:349`), insert:

```ts
  // Handle invitation photos for event creation
  if (update.message?.photo && update.message.photo.length > 0) {
    const chatId = update.message.chat.id;
    const photoUserId = update.message.from.id;
    // Telegram sends ascending resolutions; the last is the highest.
    const photo = update.message.photo[update.message.photo.length - 1];
    const from = update.message.from;
    const caption = update.message.caption;
    const fileUniqueId = photo.file_unique_id;

    addBreadcrumb('photo_message_received', {
      user_id: photoUserId,
      file_size: photo.file_size,
    }, 'user_action');

    console.log(`[Webhook] Photo received from user ${photoUserId}, file_unique_id: ${fileUniqueId}`);

    // Reuse the generic Redis lock to dedupe webhook retries.
    const { acquireVoiceLock, releaseVoiceLock } = await import('../utils/redis-lock');
    const lockAcquired = await acquireVoiceLock(fileUniqueId);
    if (!lockAcquired) {
      console.log(`[Webhook] Photo ${fileUniqueId} already being processed - skipping duplicate`);
      res.status(200).json({ ok: true });
      return;
    }

    try {
      const { handleImageMessage } = await import('./image-event');
      await handleImageMessage(chatId, photoUserId, photo, from, caption);
    } catch (error) {
      console.error('[Webhook] Error in image handler:', error);
    } finally {
      await releaseVoiceLock(fileUniqueId);
    }

    res.status(200).json({ ok: true });
    return;
  }
```

- [ ] **Step 3: If the update/message type is strict, extend it**

Run: `grep -n "photo\|caption\|interface.*Message\|message:" src/services/webhook-handlers.ts | head` and check how `update.message` is typed. If `update` is `any`/loosely typed (it is assigned from `req.body`), no change is needed. If a strict interface exists, add to the message type:

```ts
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  caption?: string;
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

---

### Task 7: Full verification

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Lint (if configured)**

Run: `npm run lint --silent 2>/dev/null || npx next lint`
Expected: no new errors in the touched files.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds (compiles the new module + webhook route).

- [ ] **Step 4: Manual QA checklist** (the real validation — cannot be unit-tested)

Send the bot, as photos:
- An English invitation with explicit date + time → expect an event (auto-created if `voiceAutoCreateHighConf` is on, else a confirmation card) with correct date/time/location.
- A Hebrew invitation (RTL) with an RSVP date distinct from the event date → verify the EVENT date is used, not the RSVP date.
- An invitation with no printed year → verify the nearest future year is chosen and confidence is medium (confirmation card).
- A non-event photo (a meme / random picture) → expect the `imageEvent.noEventFound` reply, no event.
- A photo with a caption ("this is next month") → verify the caption nudges extraction.
- A photo from a FREE-tier user → expect the Pro upgrade prompt.

---

## Self-Review

**Spec coverage:**
- Telegram photo intake → Task 6. ✓
- `downloadTelegramFile` reuse → Task 1. ✓
- Image Gemini call (inlineData image part) → Task 3. ✓
- `image` prompt mode (RSVP/year/RTL/none) → Task 2. ✓
- Reuse seam (`showEventConfirmation`/`autoCreateEvent`/bulk) → Tasks 4, 5. ✓
- Gating via `voice_events` (no migration) → Task 5. ✓
- Auto-create + ambiguity guard (via confidence) → Task 5 + Task 2. ✓
- Multi-event flyer → bulk → Tasks 2 (export `extractIntents`), 5. ✓
- `imageEvent.noEventFound` i18n (en/he/ru) → Task 4. ✓
- No auto-voice-out for image → Task 4 (union widening; callback unchanged). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. `YYYY`/`YYYY-MM-DD` placeholders inside prompt example strings are intentional literals copied from the existing prompt convention (the model fills the real year).

**Type consistency:** `handleImageMessage(chatId, userId, photo, from, caption?)`, `processImageWithGemini(imageBuffer, mimeType, caption, language, calendars, timezone)`, `buildEventExtractionPrompt(..., 'image')`, `extractIntents(...)` exported, `inputModality: 'voice' | 'text' | 'image'` — names/signatures consistent across Tasks 2–6.

**Implementation note (ambiguity guard):** The approved design's "no ambiguities" guard is implemented through the confidence channel — the image prompt is instructed to return `high` only when date+time are explicit and unambiguous, so `confidence === 'high'` in the handler IS the guard. This avoids touching the shared parser, which does not currently surface a separate ambiguities array.
