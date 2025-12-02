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
│  (Ready)   │    │ (Skeleton)  │
└────────────┘    └─────────────┘
```

## Current Status

✅ **Telegram Adapter** - Fully functional, wraps existing `node-telegram-bot-api`
🚧 **WhatsApp Adapter** - Skeleton implementation, ready for Cloud API integration

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

## Adding WhatsApp Support

### 1. Setup WhatsApp Business

1. Create Facebook Business account
2. Set up WhatsApp Business API
3. Get Access Token and Phone Number ID

### 2. Configure Environment

```bash
# .env
WHATSAPP_ACCESS_TOKEN=your_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
```

### 3. Implement WhatsApp Adapter

Complete the TODOs in `whatsapp-adapter.ts`:
- `sendMessage()` - Use WhatsApp Cloud API
- `sendVoice()` - Upload media, send audio message
- Test command parsing

### 4. Update Webhook

```typescript
// api/webhook.ts
import { detectPlatform, getMessagingService } from '../src/services/messaging';

export default async function handler(req, res) {
  const platform = detectPlatform(req);
  const service = getMessagingService(platform, bot);

  // Handle message with platform-agnostic service
  await service.sendMessage(chatId, 'Hello!');
}
```

## Migration Path

### Phase 1: Foundation (✅ COMPLETE)
- Created abstraction layer
- Telegram adapter working
- WhatsApp skeleton ready

### Phase 2: Integration (Next Step)
- Refactor existing handlers to use `IMessagingService`
- Update webhook for multi-platform routing
- Test Telegram with new abstraction

### Phase 3: WhatsApp Implementation
- Complete WhatsApp adapter
- Set up WhatsApp Business account
- Test end-to-end

### Phase 4: Future Platforms
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
  await bot.sendMessage(chatId, summary, { parse_mode: 'HTML' });
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
├── telegram-adapter.ts - Telegram implementation (✅ Ready)
├── whatsapp-adapter.ts - WhatsApp skeleton (🚧 TODO)
├── factory.ts         - Service factory & platform detection
├── index.ts           - Exports
└── README.md          - This file
```
