# Messaging Service Abstraction Layer

Multi-platform messaging support for Telegram, WhatsApp, and future platforms.

## Architecture

```
┌─────────────────────────────────────┐
│     Core Bot Logic (Platform        │
│   Agnostic: calendar, weather, AI)  │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│    IMessagingService Interface      │
└──────────────┬──────────────────────┘
               │
    ┌──────────┴──────────┐
    │                     │
┌───▼────────┐    ┌──────▼──────┐
│  Telegram  │    │  WhatsApp   │
│  Adapter   │    │  Adapter    │
│  (Live)    │    │  (Live)     │
└────────────┘    └─────────────┘
```

## Current Status

✅ **Telegram Adapter** - Fully functional, wraps the `node-telegram-bot-api` 2.x `Api` client (`getBot()`)
✅ **WhatsApp Adapter** - Fully functional on the WhatsApp Business Cloud API: text (HTML converted to Markdown), interactive reply buttons and lists, template messages for proactive sends (`whatsapp-template.ts`), voice, photos, typing indicator and media download

## Usage

### Basic Example

```typescript
import { getMessagingService, MessagingPlatform, MessageFormat } from './messaging';

// Get Telegram service
const telegramService = getMessagingService(MessagingPlatform.TELEGRAM, bot);

// Send message (platform-agnostic)
await telegramService.sendMessage(
  chatId,
  '<b>Hello World!</b>',
  { format: MessageFormat.HTML }
);

// Parse commands (works across platforms)
const command = telegramService.parseCommand('/summary tmrw');
// Returns: { command: 'summary', args: 'tmrw' }
```

### Platform Detection

```typescript
import { detectPlatform } from './messaging/factory';

// In webhook handler
const platform = detectPlatform(req);
const service = getMessagingService(platform, bot);
```

## Interface

All messaging adapters implement `IMessagingService`:

```typescript
interface IMessagingService {
  // Send text message with optional formatting
  sendMessage(chatId, text, options?): Promise<void>

  // Send voice message
  sendVoice(chatId, audioPath, options?): Promise<void>

  // Parse platform-specific commands
  parseCommand(text): ParsedCommand | null

  // Answer callback queries (inline buttons)
  answerCallbackQuery(queryId, text?): Promise<void>

  // Get current platform
  getPlatform(): MessagingPlatform

  // Convert between formats (HTML ↔ Markdown)
  formatText(text, from): string
}
```

## Format Conversion

The abstraction handles format conversion automatically:

- **Telegram**: HTML (`<b>bold</b>`, `<i>italic</i>`)
- **WhatsApp**: Markdown (`*bold*`, `_italic_`)

```typescript
// Write once, works on both platforms
const html = '<b>Important:</b> Meeting at <i>3 PM</i>';

// Telegram: sends as HTML
await telegramService.sendMessage(chatId, html, { format: MessageFormat.HTML });

// WhatsApp: auto-converts to Markdown (*Important:* Meeting at _3 PM_)
await whatsappService.sendMessage(chatId, html, { format: MessageFormat.HTML });
```

## WhatsApp setup

The adapter is built by `getWhatsAppService()` from two environment variables (see the README for the full setup):

```bash
# .env
WHATSAPP_ACCESS_TOKEN=your_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
```

### Webhook

The live route is `app/api/webhook/route.ts`: it verifies Meta's signature, then picks the platform with `detectPlatform`.

## Migration Path

### Phase 1: Foundation (✅ COMPLETE)
- Created abstraction layer
- Telegram adapter working

### Phase 2: WhatsApp (✅ COMPLETE)
- WhatsApp adapter live, webhook routing for both platforms

### Phase 3: Future Platforms
- Discord adapter
- Slack adapter
- SMS adapter (Twilio)

## Benefits

✅ **Platform Agnostic** - Write business logic once, run on any platform
✅ **Easy Testing** - Mock `IMessagingService` for unit tests
✅ **Format Conversion** - Automatic HTML ↔ Markdown conversion
✅ **Future Proof** - Easy to add new platforms
✅ **Clean Separation** - Business logic independent of messaging platform

## Example: Refactoring Existing Code

### Before (Telegram-specific)
```typescript
export async function handleSummaryCommand(chatId: number, userId: number, args?: string) {
  const bot = getBot();
  await bot.sendMessage({ chat_id: chatId, text: summary, parse_mode: 'HTML' });
}
```

### After (Platform-agnostic)
```typescript
export async function handleSummaryCommand(
  service: IMessagingService,
  chatId: number | string,
  userId: number | string,
  args?: string
) {
  await service.sendMessage(chatId, summary, { format: MessageFormat.HTML });
}
```

## Testing

```typescript
// Mock messaging service for tests
class MockMessagingService implements IMessagingService {
  messages: string[] = [];

  async sendMessage(chatId, text) {
    this.messages.push(text);
  }

  // ... implement other methods
}

// Test
const mock = new MockMessagingService();
await handleSummaryCommand(mock, 123, 456);
assert(mock.messages.length === 1);
```

## Files

```
src/services/messaging/
├── types.ts           - Interface & type definitions
├── telegram-adapter.ts - Telegram implementation (✅ Live)
├── whatsapp-adapter.ts - WhatsApp Cloud API implementation (✅ Live)
├── whatsapp-template.ts - Template messages for proactive sends
├── factory.ts         - Service factory & platform detection
├── index.ts           - Exports
└── README.md          - This file
```
