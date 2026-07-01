# Image → Calendar Event Creation

- **Date:** 2026-07-01
- **Status:** Approved design, pending implementation plan
- **Author:** Raziel Gershoni (with Claude Code)

## Summary

Let a user send an event **invitation image** (a flyer, a screenshot, a snapshot
of a printed card) to the Telegram bot and have it create a calendar event
automatically — the same experience as the existing voice and forwarded-text
flows.

This is not a new subsystem. It is a third input modality added to the front of
the pipeline that already exists. Voice and forwarded-text both converge on one
shared seam (`showEventConfirmation` / `autoCreateEvent` → the create callback →
Google Calendar). The image modality produces the same `VoiceIntentResult` and
hands off to that seam, leaving everything downstream untouched.

## Decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| Feature gating / metering | **Reuse `voice_events`** | No schema/API changes. Consistent with forwarded-text, which already piggybacks this key. Both gate and usage counter (`voiceEventsCreated`) are shared. |
| Commit behavior | **Auto-create on high confidence, with an ambiguity guard** | Auto-create fires only when confidence is `high` **and** the model reports no `ambiguities`. Anything less falls back to the confirmation card. |
| Input scope (v1) | **Photos only (`message.photo`) + caption as context** | Compressed JPEG, the common "screenshot/snap the invite" case. The user's `message.caption`, if present, is fed to the model as extra context. |
| Out of scope (v1) | Albums / multi-image, documents (`message.document`), PDFs, `edit`/`delete` intents from images | Deferred. Image mode returns only `create` or `none`. |

## Architecture — the reuse seam

The convergence point shared by voice and forwarded-text is a short chain, all
reusable as-is:

- **Extraction contract:** `buildEventExtractionPrompt(mode)` and
  `parseGeminiEventResponse()` in `src/services/voice/gemini-voice.ts`
  (`:25`, `:266`), producing `VoiceIntentResult` / `ParsedEvent`
  (`src/services/event-parser.ts:43`, `:69`).
- **Confirmation UX:** `showEventConfirmation()` in
  `src/services/voice/confirmations.ts:314`, which already stashes an
  `inputModality` field in Redis — the designed extension point. Image flow sets
  `inputModality: 'image'`.
- **High-confidence bypass:** `autoCreateEvent()` in
  `src/services/voice/auto-create.ts:83`.
- **Create commit + usage:** `handleEventCallback()` action `'create'` in
  `src/services/voice/callbacks.ts:67` → `provider.createEvent(...)` (`:88`) →
  `incrementUsage(user.id, 'voiceEvents')` (`:134`).
- **Persistence:** `provider.createEvent` → `createEvent()` in
  `src/services/calendar.ts:328` (`events.insert` at `:379`).

Everything from `showEventConfirmation` / `autoCreateEvent` downward is already
modality-agnostic and needs **zero changes**. The `forward-event/` module is the
existing template proving a non-voice modality can reuse this seam.

## Data flow

```
Telegram photo update
  → webhook-handlers.ts: new `message.photo` branch (dedup lock on file_unique_id)
  → handleImageMessage(chatId, userId, photo, from, caption)
      → getUserByTelegramId → checkFeatureAccess('voice_events') → hasUsableCalendar
      → upload_photo typing indicator
      → downloadTelegramFile(photo.file_id)          [generic'd from downloadVoiceFile]
      → processImageWithGemini(buffer, 'image/jpeg', caption, lang, calendars, tz, recentBlock)
           → buildEventExtractionPrompt('image', …)   [new mode on the existing builder]
           → Gemini generateContent:
               parts: [{ text }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }]
           → parseGeminiEventResponse(…) → VoiceIntentResult
      → route on result:
          2+ create intents                                  → showBulkConfirmation (never auto-creates)
          1 create + confidence high + no ambiguities        → autoCreateEvent (inputModality:'image')
          1 create otherwise                                 → showEventConfirmation (inputModality:'image')
          intent 'none' / no event                           → friendly "couldn't find an event" reply
```

## Components — new and changed files

### `src/services/webhook-handlers.ts` (changed)
- Add `photo_message` to the `webhookType` classifier (`:66-72`).
- Add a dispatch branch next to the voice branch (`:310`), before the text
  catch-all (`:375`):
  - Select the highest-resolution `PhotoSize`:
    `update.message.photo[update.message.photo.length - 1]`.
  - Acquire a Redis dedup lock on `photo.file_unique_id`, mirroring the voice
    lock (`acquireVoiceLock`, `:327-334`), to survive Telegram webhook retries.
  - Read `update.message.caption` (optional).
  - Call `handleImageMessage(chatId, userId, photo, from, caption)`.
- Photos that arrive forwarded are treated identically to non-forwarded photos
  (detection keys on `message.photo`, independent of forward status).

### `src/services/voice/event-resolution.ts` (changed)
- Extract the already-generic two-step download (`bot.getFile` → `file_path` →
  `https://api.telegram.org/file/bot<token>/<file_path>` → `Buffer`,
  `:20-39`) into `downloadTelegramFile(fileId): Promise<Buffer>`.
- Keep `downloadVoiceFile` as a thin alias delegating to `downloadTelegramFile`
  so existing voice call-sites don't churn.

### `src/services/image-event/handler.ts` (new)
`handleImageMessage(chatId, userId, photo, from, caption?)`, twin of
`handleVoiceMessage` (`src/services/voice/handler.ts:225`):
1. `getUserByTelegramId(userId)`.
2. `checkFeatureAccess(user.id, 'voice_events')` → on deny, send the existing
   "Pro feature" upgrade message (same pattern as
   `src/services/forward-event/handler.ts:77-94`).
3. `hasUsableCalendar(user)` guard.
4. `upload_photo` typing indicator (already supported by the Telegram adapter).
5. `downloadTelegramFile(photo.file_id)`.
6. Build the timezone + recent-events context block (reuse
   `recent-events-store`), as voice does.
7. `processImageWithGemini(buffer, 'image/jpeg', caption, language, userCalendars, timezone, recentBlock)`.
8. Route (mirrors the voice handler's routing at `handler.ts:373-406`):
   - **2+ create intents** → `showBulkConfirmation(...)`. Bulk always confirms
     and never auto-creates, so a multi-event flyer is safe by construction.
   - **1 create**, `confidence === 'high'`, no `ambiguities` →
     `autoCreateEvent(...)` with `inputModality: 'image'` (must run the same
     `incrementUsage('voiceEvents')` the voice auto-create path runs).
   - **1 create** otherwise → `showEventConfirmation(...)` with
     `inputModality: 'image'`.
   - `intent === 'none'` / no event → reply with `imageEvent.noEventFound`.

### `src/services/image-event/gemini-image.ts` (new)
`processImageWithGemini(imageBuffer, mimeType, caption, language, userCalendars, timezone, recentBlock)`,
twin of `processTextWithGemini` (`src/services/forward-event/gemini-text.ts:35`):
- Resolve the model the same way: admin setting → `process.env.AI_MODEL` →
  fallback `gemini-3-flash-preview` (multimodal-capable).
- `promptText = buildEventExtractionPrompt('image', …)`.
- Request parts:
  ```ts
  parts: [
    { text: promptText + (caption ? `\n\nCAPTION FROM USER:\n${caption}` : '') },
    { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
  ]
  ```
- Reuse verbatim: retry config, JSON-fence stripping, token/duration metrics,
  and `parseGeminiEventResponse`.

### `src/services/voice/gemini-voice.ts` (changed)
- Extend `buildEventExtractionPrompt` mode from `'voice' | 'text'` to
  `'voice' | 'text' | 'image'`.
- Image mode writes into the **same JSON envelope** (`:113-170`) so the parser
  and the entire downstream chain are unchanged. Image mode returns only
  `create` or `none` intents (no `edit`/`delete`); one or more `create` intents
  are allowed via the existing `intents[]` array, so a multi-event flyer routes
  to the bulk confirmation.

### i18n (en / he / ru) (changed)
- One new string: `imageEvent.noEventFound` (friendly "I couldn't find an event
  in this image" reply). Must read naturally per language, not translated
  literally.
- Confirmation card, upgrade prompt, and "created ✅" strings are already
  modality-agnostic and are reused unchanged.

### Gating (no schema changes)
- `checkFeatureAccess(user.id, 'voice_events')` in the image handler.
- `incrementUsage(user.id, 'voiceEvents')` on the shared create path
  (`callbacks.ts:134`) and the auto-create path.

## The image prompt — the real work

Invitations carry failure modes that voice and text do not. The `image` mode of
`buildEventExtractionPrompt` must instruct the model to:

1. **Disambiguate the actual event date/time from an RSVP-by / reply-by date.**
   When both appear, the event date wins; the RSVP date may go into
   `description`.
2. **Infer the year** as the nearest sensible future date relative to
   `CURRENT DATE` when the flyer omits it.
3. Handle **Hebrew/RTL and mixed-script (he/ru/en)** invitation text.
4. Extract venue/address into `location`.
5. Return `intent: 'none'` for non-event images (memes, random screenshots).
6. Emit the same JSON envelope as voice/text (no schema drift).

## Error and edge handling

- **Non-event photo** → `imageEvent.noEventFound` reply; no event created.
- **Gemini or download failure** → existing error-message pattern; the Redis
  dedup lock prevents double-processing on webhook retries.
- **Feature-gate denial** → existing "Pro feature" upgrade message.
- **Mime/size validation** → not needed for v1; Telegram photos are always JPEG
  and size-capped. (Would be required if `document`/PDF intake is added later.)

## Testing

- **Unit:** `buildEventExtractionPrompt('image')` includes the invitation /
  RSVP-vs-event-date instructions; `processImageWithGemini` builds the correct
  `parts` array (mocked Gemini).
- **Manual QA (the real validation):** a small set of real he/ru/en invitation
  images, verifying RSVP-vs-event-date disambiguation, year inference, location
  extraction, and the non-event `none` path. OCR quality on stylized Hebrew
  flyers cannot be unit-tested and must be checked against real inputs.

## Risks and open questions (deferred, not blocking v1)

- **OCR quality on Hebrew/stylized flyers** is unverified; the manual QA set
  above is the mitigation. If quality is poor, the ambiguity guard degrades
  gracefully to the confirmation card rather than creating wrong events.
- **Vision-call cost / abuse surface:** users will send off-topic photos that
  return `intent: none` and still cost a vision call. The `voice_events` Pro gate
  limits this to paying users for v1; per-user rate limiting can be added later
  if abuse appears.
- **Albums, documents, PDFs** are explicitly deferred; revisit if users ask to
  forward multi-page or "send as file" invitations.
