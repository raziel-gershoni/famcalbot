# Albums and PDFs for photo-to-events (Telegram) - design

Date: 2026-10-25. Status: owner-approved scope.

## Scope

Telegram only (WhatsApp later). Only real albums (Telegram `media_group_id`); separate photos stay separate, as today. Reuses the image path: `image-event/handler.ts`, `gemini-image.ts`, `showEventConfirmation` / `showBulkConfirmation`, and the photo branch of `webhook-handlers.ts`.

## Scenarios

| # | Situation | Behaviour |
|---|---|---|
| 1 | Album of 2-10 photos | Collect every part (separate webhook updates sharing `media_group_id`), read them in ONE Gemini request, show ONE confirmation card with all events |
| 2 | Caption on one album item | Applies to the whole album |
| 3 | Album with different invitations | One card listing all events, each removable (the bulk card already allows it) |
| 4 | Same event on two photos | Created once: deduped in the prompt and in code by title + start |
| 5 | Table continuing across photos | Read together, in order |
| 6 | Album includes a video | Skipped with a short note; the photos are read |
| 7 | More than 10 photos | Telegram splits them into several albums; each is read separately |
| 8 | One photo fails to download or read | The rest go through, with a note that one couldn't be read |
| 9 | Nothing found anywhere | One "no events found" reply, not one per photo |
| 10 | Forwarded album | Same as a normal album |
| 11 | PDF (`message.document`, `application/pdf`) | Read as one document. Above Telegram's 20 MB bot download limit: a clear answer. Only the first 20 pages go to Gemini (trimmed with pdf-lib); the user is told when pages were dropped |
| 12 | Scanned PDF | Works: Gemini reads the page images |
| 13 | Password-protected or broken PDF | A clear "can't open this file" message |
| 14 | Image sent as a document (jpeg, png, webp, heic, heif) | Treated like a photo |
| 15 | Other documents | A polite "send a photo or PDF" |
| 16 | Plan and usage | Same gate as a single photo (`checkFeatureAccess(.., 'voice_events')`, plus the user's AI-events switch); an album or PDF counts as ONE use |
| 17 | Long reading | The typing indicator runs the whole time, quiet wait included |

## Design

### Core handler

`handleImageMessage` (one photo) becomes a thin wrapper over `handleMediaMessage(chatId, userId, from, files, caption)`. `files` is a list of `{ fileId, mimeType, kind: 'image' | 'pdf', fileSize?, name? }`. The checks (registered, AI-events switch, feature gate, calendar), the usage event, the typing interval, the Gemini call and the confirmation seam run once per call. A single photo goes through exactly the same steps as before (auto-create of one high-confidence event included).

Steps:
1. Download every file (a failure is logged, sent to Sentry, and counted as "couldn't be read"; the rest go on).
2. PDFs: load with pdf-lib. Encrypted or broken: counted as unreadable (a lone PDF gets the "can't open this file" message). More than 20 pages: only the first 20 are kept (`copyPages` into a new document) and a note says so. Up to 20 pages the original bytes are sent untouched.
3. One `processMediaWithGemini` call with all parts, labelled in order ("File 1 of N"). The multi-file prompt addendum says: the files are parts of one set in order; a table or list may continue across them; return every distinct event once; the same event on two files is one event. The retry/backoff is the existing image one (shared function; `processImageWithGemini` delegates to it).
4. Dedupe in code by lower-cased title + start instant.
5. 2+ events: `showBulkConfirmation`; one: the single path (auto-create rules unchanged); none: ONE "no events" reply (notes folded into it).
6. Notes (video skipped, N files unreadable, PDF trimmed) are sent as one short message before the card, or folded into the "no events" reply. All text lives in `messages/{en,he,ru}.json` under `bot.imageEvent`.
7. Only if every file failed: the existing generic error message.

### Album collection (`image-event/album.ts`)

Parts arrive as concurrent webhook requests, and during a zero-downtime deploy two instances may overlap, so state lives in Redis, keyed `album:{chatId}:{media_group_id}`:

- `:seen` (set, `SADD file_unique_id`): idempotent per part; a Telegram retry of a part is ignored, even after the album was drained.
- `:parts` (list, `RPUSH` of JSON `{messageId, kind, fileId, mimeType, caption, ...}`), expiry 10 min.
- `:lock` (`SET NX EX 300`): exactly one request becomes the leader.

Each part request: `SADD`; if new, `RPUSH` + `EXPIRE`; then `SET NX` on the lock. Not acquired: return (the leader reads it). Acquired: this request is the leader. Telegram sends no "last part" marker, so the leader waits for a quiet period: repeat { n = LLEN; sleep 1.5 s; stop if LLEN == n or LLEN >= 10 }. It then takes a snapshot (`LRANGE` + `LTRIM`), sorts by message id, processes it, and releases the lock in `finally`. If parts landed while it worked (list not empty), it takes the lock again and processes them as a second round, so a very late part is never stranded. Each step is logged with the album key and counts.

Routing in the webhook: a message with `media_group_id` and a photo, video or document goes to the album collector and NEVER to the single-photo/document path. A lone video (no group) is ignored as today. Video, and other non-image/non-PDF members, are skipped with the note. A Redis failure while storing a part is logged and sent to Sentry; the part is dropped (it is not handled as a single photo).

The caption of the whole album is the first non-empty caption by message order (all distinct captions joined, in practice there is one).

### Usage

The feature gate and the `image_event_started` activity run once in `handleMediaMessage`, so an album or PDF is one use. (There is no per-use counter for `voice_events`; the gate is the plan check.)

## Tests (`scripts/smoke-album-pdf.ts`, fakes only)

Real: the webhook branch, album collector, handler, gemini-image (prompt + retry + parsing), pdf-lib, dedupe, bot texts. Faked: Gemini (scripted answers, records parts), Redis (in memory, async), Telegram file download (scripted bytes / failures), user, subscription, analytics, confirmations, Sentry.

Checks: album of 2; album of 10 (no quiet wait needed); caption on the 2nd part; a part arriving late within the quiet period; concurrent handlers where only one reads; a failed part; nothing found; a video part; the same event on two photos; PDF happy path; PDF over 20 MB; PDF over 20 pages trimmed with the note; broken PDF; encrypted PDF; image as a document; another document type; one gate check and one usage event per album; a Telegram retry of a part; the single photo unchanged; the typing interval runs during the wait and stops after.

## Limits

- If the combined Gemini request itself fails after the retries, the whole album fails (we cannot tell which image is bad). A file that cannot be downloaded or is unreadable by pdf-lib is dropped before the request.
- The leader's webhook request stays open for the whole reading, as the single photo does today.
- A leader process that crashes mid-read loses that album's parts (the lock and keys expire on their own).
