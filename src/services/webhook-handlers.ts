/**
 * Platform-specific webhook handlers
 * Handles incoming messages from Telegram and WhatsApp
 */

/** Minimal request/response types for webhook handlers */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface WebhookRequest { body: any }
interface WebhookResponse { status(code: number): { json(data: unknown): void } }
import {
  handleStartCommand,
  handleSummaryCommand,
  handleWeatherCommand,
  handleFeedbackCommand,
  handleConnectCommand,
  getBot
} from './telegram';
import { getUserByWhatsAppPhone, getOrCreateUserByWhatsApp, getUserByTelegramId } from './user-service';
import { UserConfig } from '../types';
import { MessagingPlatform, getWhatsAppService } from './messaging';
import { handleVoiceMessage, handleEventCallback, handleEditCallback, handleDeleteCallback } from './voice';
import { handlePreCheckoutQuery, handleSuccessfulPayment } from './payment-handler';
import { setUserContext, addBreadcrumb } from './analytics-service';
import { captureError } from '../lib/error-capture';
import { isIdentifierBlocked, isUserSuspended } from '../lib/user-moderation';

/**
 * Handle Telegram webhook updates
 */
export async function handleTelegramWebhook(
  req: WebhookRequest,
  res: WebhookResponse
): Promise<void> {
  // Note: Webhook secret verification is handled at the API route level (app/api/webhook/route.ts)
  const update = req.body;

  // Extract user ID from various update types and set Sentry context
  const userId = update.message?.from?.id
    || update.callback_query?.from?.id
    || update.pre_checkout_query?.from?.id;
  const userName = update.message?.from?.first_name
    || update.callback_query?.from?.first_name
    || update.pre_checkout_query?.from?.first_name;

  if (userId) {
    setUserContext(userId, userName);
  }

  // Moderation gate: drop everything from blocked or suspended Telegram users.
  if (userId) {
    if (await isIdentifierBlocked({ telegramId: userId })) {
      console.log(`[Moderation] Dropped Telegram update from blocked id ${userId}`);
      res.status(200).json({ ok: true });
      return;
    }
    const existingUser = await getUserByTelegramId(userId);
    if (existingUser && isUserSuspended(existingUser)) {
      console.log(`[Moderation] Dropped Telegram update from suspended user ${existingUser.id}`);
      res.status(200).json({ ok: true });
      return;
    }
  }

  // Add breadcrumb for webhook type
  const isForwarded = update.message?.text && (update.message.forward_origin || update.message.forward_from || update.message.forward_from_chat || update.message.forward_date);
  const webhookType = update.pre_checkout_query ? 'pre_checkout'
    : update.message?.successful_payment ? 'successful_payment'
    : update.callback_query ? 'callback_query'
    : update.message?.voice ? 'voice_message'
    : isForwarded ? 'forwarded_message'
    : update.message?.text ? 'text_message'
    : 'unknown';

  addBreadcrumb('webhook_received', {
    type: webhookType,
    update_id: update.update_id,
    user_id: userId,
  }, 'webhook');

  // Handle pre-checkout query (Telegram Stars payment validation)
  if (update.pre_checkout_query) {
    await handlePreCheckoutQuery(update.pre_checkout_query);
    res.status(200).json({ ok: true });
    return;
  }

  // Handle successful payment (Telegram Stars)
  if (update.message?.successful_payment) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    await handleSuccessfulPayment(chatId, userId, update.message.successful_payment);
    res.status(200).json({ ok: true });
    return;
  }

  // Handle callback queries (inline keyboard button clicks)
  if (update.callback_query) {
    const callbackQuery = update.callback_query;
    const chatId = callbackQuery.message?.chat.id;
    const callbackUserId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const queryId = callbackQuery.id;

    // Add breadcrumb for callback action
    addBreadcrumb('callback_received', {
      callback_data: data,
      user_id: callbackUserId,
    }, 'user_action');

    if (chatId && data) {
      if (data.startsWith('event_create:') || data.startsWith('event_cancel:')) {
        // Handle event creation callbacks
        const [action, pendingId] = data.split(':').slice(0, 2);
        const actionType = action.replace('event_', '');
        const fullPendingId = data.substring(action.length + 1); // Get everything after "event_create:" or "event_cancel:"
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          await handleEventCallback(chatId, messageId, queryId, actionType, fullPendingId);
        }
      } else if (data.startsWith('edit_confirm:') || data.startsWith('edit_cancel:')) {
        // Handle event edit callbacks
        const [action] = data.split(':').slice(0, 1);
        const actionType = action.replace('edit_', '');
        const fullPendingId = data.substring(action.length + 1);
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          await handleEditCallback(chatId, messageId, queryId, actionType, fullPendingId);
        }
      } else if (data.startsWith('delete_confirm:') || data.startsWith('delete_cancel:')) {
        // Handle event delete callbacks
        const [action] = data.split(':').slice(0, 1);
        const actionType = action.replace('delete_', '');
        const fullPendingId = data.substring(action.length + 1);
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          await handleDeleteCallback(chatId, messageId, queryId, actionType, fullPendingId);
        }
      } else if (data.startsWith('kidname_yes:') || data.startsWith('kidname_no:')) {
        // Handle kid name detection callbacks
        const action = data.startsWith('kidname_yes') ? 'kidname_yes' : 'kidname_no';
        const pendingId = data.substring(action.length + 1);
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          const { handleKidNameCallback } = await import('./kid-name-callbacks');
          await handleKidNameCallback(chatId, messageId, queryId, action, pendingId);
        }
      } else if (data.startsWith('voice_undo:')) {
        // PR 10: Undo button on auto-create skip path
        const token = data.substring('voice_undo:'.length);
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          const { handleVoiceUndoCallback } = await import('./voice/callbacks');
          await handleVoiceUndoCallback(chatId, messageId, queryId, token, callbackUserId);
        }
      } else if (data.startsWith('bulk_confirm:') || data.startsWith('bulk_cancel:')) {
        // PR 11: bulk multi-event confirmation
        const action = data.startsWith('bulk_confirm:') ? 'confirm' : 'cancel';
        const pendingId = data.substring(action === 'confirm' ? 'bulk_confirm:'.length : 'bulk_cancel:'.length);
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          const { handleBulkCallback } = await import('./voice/callbacks');
          await handleBulkCallback(chatId, messageId, queryId, action, pendingId);
        }
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  // Handle reply-to-message corrections (text or voice reply to a pending event confirmation)
  if (update.message?.reply_to_message && (update.message.text || update.message.voice)) {
    const chatId = update.message.chat.id;
    const replyUserId = update.message.from.id;
    const repliedToMsgId = update.message.reply_to_message.message_id;

    const { redis } = await import('../utils/redis');
    const { REDIS_KEYS } = await import('../config/redis-keys');
    const pendingId = await redis.get<string>(REDIS_KEYS.pendingReply(chatId, repliedToMsgId));

    if (pendingId) {
      addBreadcrumb('reply_correction_received', {
        user_id: replyUserId,
        input_type: update.message.voice ? 'voice' : 'text',
      }, 'user_action');

      console.log(`[Webhook] Reply correction from user ${replyUserId} to message ${repliedToMsgId}`);

      try {
        let correctionInput: { text: string } | { audioBuffer: Buffer; language: string };

        if (update.message.voice) {
          const { downloadVoiceFile } = await import('./voice/event-resolution');
          const audioBuffer = await downloadVoiceFile(update.message.voice.file_id);
          const user = await import('./user-service').then(m => m.getUserByTelegramId(replyUserId));
          correctionInput = { audioBuffer, language: user?.language || 'en' };
        } else {
          correctionInput = { text: update.message.text };
        }

        const { handleEventCorrection } = await import('./voice/correction-handler');
        await handleEventCorrection(chatId, replyUserId, pendingId, repliedToMsgId, correctionInput);
      } catch (error) {
        console.error('[Webhook] Error in correction handler:', error);
      }

      res.status(200).json({ ok: true });
      return;
    }
    // Not a reply to a pending confirmation — fall through to normal handling
  }

  // Handle voice messages for event creation
  if (update.message?.voice) {
    const chatId = update.message.chat.id;
    const voiceUserId = update.message.from.id;
    const voice = update.message.voice;
    const from = update.message.from;
    const fileUniqueId = voice.file_unique_id;

    // Add breadcrumb for voice message
    addBreadcrumb('voice_message_received', {
      user_id: voiceUserId,
      duration: voice.duration,
      file_size: voice.file_size,
    }, 'user_action');

    console.log(`[Webhook] Voice message received from user ${voiceUserId}, file_unique_id: ${fileUniqueId}, duration: ${voice.duration}s`);

    // Use Redis lock to prevent duplicate processing on webhook retries
    const { acquireVoiceLock, releaseVoiceLock } = await import('../utils/redis-lock');
    const lockAcquired = await acquireVoiceLock(fileUniqueId);

    if (!lockAcquired) {
      console.log(`[Webhook] Voice message ${fileUniqueId} already being processed - skipping duplicate`);
      res.status(200).json({ ok: true });
      return;
    }

    // Process voice message (await to prevent Vercel from killing the function)
    try {
      await handleVoiceMessage(chatId, voiceUserId, voice, from);
    } catch (error) {
      console.error('[Webhook] Error in voice handler:', error);
    } finally {
      await releaseVoiceLock(fileUniqueId);
    }

    res.status(200).json({ ok: true });
    return;
  }

  // Handle forwarded text messages for event creation
  if (update.message?.text && (update.message.forward_origin || update.message.forward_from
      || update.message.forward_from_chat || update.message.forward_date)) {
    const chatId = update.message.chat.id;
    const fwdUserId = update.message.from.id;
    const fwdText = update.message.text;
    const from = update.message.from;

    addBreadcrumb('forwarded_message_received', {
      user_id: fwdUserId,
      text_length: fwdText.length,
    }, 'user_action');

    console.log(`[Webhook] Forwarded message received from user ${fwdUserId}, length: ${fwdText.length}`);

    try {
      const { handleForwardedMessage } = await import('./forward-event');
      await handleForwardedMessage(chatId, fwdUserId, fwdText, from);
    } catch (error) {
      console.error('[Webhook] Error in forward handler:', error);
    }

    res.status(200).json({ ok: true });
    return;
  }

  if (!update.message || !update.message.text) {
    // Not a text message, ignore
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = update.message.chat.id;
  const textUserId = update.message.from.id;
  const text = update.message.text;

  // Add breadcrumb for text command
  addBreadcrumb('text_message_received', {
    user_id: textUserId,
    command: text.startsWith('/') ? text.split(' ')[0] : undefined,
    is_command: text.startsWith('/'),
  }, 'user_action');

  // Route to appropriate command handler
  if (text.startsWith('/start')) {
    // Pass Telegram user info for auto-registration
    // Extract args for deep links (e.g., /start feedback from t.me/BotName?start=feedback)
    const args = text.replace('/start', '').trim();
    await handleStartCommand(chatId, textUserId, MessagingPlatform.TELEGRAM, update.message.from, args || undefined);
  } else if (text.startsWith('/summary')) {
    const args = text.replace('/summary', '').trim();
    await handleSummaryCommand(chatId, textUserId, MessagingPlatform.TELEGRAM, args || undefined);
  } else if (text.startsWith('/weather')) {
    const args = text.replace('/weather', '').trim();
    await handleWeatherCommand(chatId, textUserId, MessagingPlatform.TELEGRAM, args || undefined);
  } else if (text.startsWith('/feedback')) {
    const args = text.replace('/feedback', '').trim();
    await handleFeedbackCommand(chatId, textUserId, args || undefined);
  } else if (text.startsWith('/connect')) {
    await handleConnectCommand(chatId, textUserId, MessagingPlatform.TELEGRAM);
  } else {
    // Free-text "accept <token>" — pair-invite acceptance via plain message
    const { parseAcceptCommand, handlePairAccept } = await import('./telegram/pair-handler');
    const token = parseAcceptCommand(text);
    if (token) {
      const { getOrCreateUser } = await import('./user-service');
      const user = await getOrCreateUser(textUserId, update.message.from);
      await handlePairAccept(chatId, user.id, token, user.language || 'en', MessagingPlatform.TELEGRAM);
    }
  }

  res.status(200).json({ ok: true });
}

/**
 * Handle WhatsApp webhook updates
 * Supports auto-registration, account linking, and command routing
 */
export async function handleWhatsAppWebhook(
  req: WebhookRequest,
  res: WebhookResponse
): Promise<void> {
  const body = req.body;

  // Parse WhatsApp webhook structure
  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  // Ignore messages for other phone numbers (same Meta app, different bots)
  const incomingPhoneId = value?.metadata?.phone_number_id;
  if (incomingPhoneId && process.env.WHATSAPP_PHONE_NUMBER_ID && incomingPhoneId !== process.env.WHATSAPP_PHONE_NUMBER_ID) {
    res.status(200).json({ ok: true });
    return;
  }

  const messages = value?.messages;

  // Log delivery status callbacks (sent, delivered, read, failed)
  const statuses = value?.statuses as Array<{
    id: string;
    status: string;
    recipient_id: string;
    timestamp: string;
    errors?: Array<{ code: number; title: string; message?: string }>;
  }> | undefined;
  if (statuses && statuses.length > 0) {
    for (const status of statuses) {
      const errorInfo = status.errors?.[0];
      if (status.status === 'failed') {
        const summary = errorInfo
          ? `code=${errorInfo.code} title="${errorInfo.title}" ${errorInfo.message || ''}`
          : '';
        console.error(`[WhatsApp Status] FAILED msg=${status.id} to=${status.recipient_id}`, summary);
        // Surface every Meta delivery failure to Sentry so they're not lost in stdout.
        // 131026 (Message undeliverable) and 131047 (24h window) are the common ones — they typically
        // mean policy/state issues (closed 24h window, recipient not on WA, ToS not accepted).
        captureError(
          new Error(`WhatsApp delivery failed: ${errorInfo?.title || 'unknown'} (code ${errorInfo?.code ?? '?'})`),
          'whatsapp-status-failed',
          {
            message_id: status.id,
            recipient_id: status.recipient_id,
            error_code: errorInfo?.code,
            error_title: errorInfo?.title,
            error_message: errorInfo?.message,
          },
          'warning',
        );
      } else {
        console.log(`[WhatsApp Status] ${status.status} msg=${status.id} to=${status.recipient_id}`);
      }
    }
  }

  if (!messages || messages.length === 0) {
    res.status(200).json({ ok: true });
    return;
  }

  const message = messages[0];
  const rawPhone = message.from;

  if (!rawPhone) {
    res.status(200).json({ ok: true });
    return;
  }

  // Dedup: prevent WhatsApp webhook retries from re-processing the same message
  const waMessageId = message.id;
  if (waMessageId) {
    const { redis } = await import('../utils/redis');
    const { REDIS_KEYS } = await import('../config/redis-keys');
    const result = await redis.set(REDIS_KEYS.waDedup(waMessageId), '1', { nx: true, ex: 300 });
    if (result !== 'OK') {
      console.log(`[WhatsApp] Skipping duplicate message: ${waMessageId}`);
      res.status(200).json({ ok: true });
      return;
    }
  }

  // Detect BSUID vs phone number — don't blindly add + prefix
  const isBsuid = !rawPhone.match(/^\+?\d+$/);
  const fromId = isBsuid ? rawPhone : (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`);

  // Extract BSUID and phone from webhook metadata (ExternalUserId)
  const externalUserId = value?.contacts?.[0]?.user_id as string | undefined;  // BSUID
  const contactPhone = value?.contacts?.[0]?.wa_id as string | undefined;      // phone (may be absent)

  // Handle audio/voice messages (event creation via voice)
  if (message.type === 'audio') {
    const mediaId = message.audio?.id;
    if (mediaId) {
      const { getUserByWhatsAppId } = await import('./user-service');
      const user = await getUserByWhatsAppId(fromId);
      if (user) {
        await handleWhatsAppVoice(fromId, user, mediaId);
      }
    }
    res.status(200).json({ ok: true });
    return;
  }

  // Support text messages, template quick reply button taps, interactive button replies, and list selections
  const text = message.text?.body || message.button?.payload || message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;

  if (!text) {
    res.status(200).json({ ok: true });
    return;
  }

  const from = fromId;

  // Extract contact name from webhook payload
  const contactName = value?.contacts?.[0]?.profile?.name;

  // Moderation gate: drop incoming WhatsApp messages from blocked phones.
  // (Done before lookup so a blocked-and-deleted phone never re-registers.)
  const candidatePhone = contactPhone
    ? (contactPhone.startsWith('+') ? contactPhone : `+${contactPhone}`)
    : (isBsuid ? null : fromId);
  if (candidatePhone && await isIdentifierBlocked({ whatsappPhone: candidatePhone })) {
    console.log(`[Moderation] Dropped WhatsApp message from blocked phone ${candidatePhone}`);
    res.status(200).json({ ok: true });
    return;
  }

  // Auto-register: get existing user or create new one (BSUID-aware)
  const { getUserByWhatsAppId, updateWhatsAppBsuid } = await import('./user-service');
  let isNewUser = false;
  let user = await getUserByWhatsAppId(from);
  if (!user && externalUserId) {
    const { getUserByWhatsAppBsuid } = await import('./user-service');
    user = await getUserByWhatsAppBsuid(externalUserId);
  }
  if (!user) {
    const normalizedPhone = contactPhone ? (contactPhone.startsWith('+') ? contactPhone : `+${contactPhone}`) : (isBsuid ? undefined : fromId);
    user = await getOrCreateUserByWhatsApp(from, contactName, externalUserId, normalizedPhone);
    isNewUser = true;
  }

  // Drop further activity from suspended users.
  if (user && isUserSuspended(user)) {
    console.log(`[Moderation] Dropped WhatsApp message from suspended user ${user.id}`);
    res.status(200).json({ ok: true });
    return;
  }

  // Backfill BSUID for existing phone-based users.
  // Wrapped in try/catch because BSUID has a UNIQUE constraint — if Meta ever
  // sends the same external_user_id for two different users, the second update
  // would throw P2002 and break the entire webhook for that user.
  if (user && externalUserId && !user.whatsappBsuid) {
    try {
      await updateWhatsAppBsuid(user.id, externalUserId);
      user.whatsappBsuid = externalUserId;
    } catch (err) {
      console.error(`[WhatsApp] BSUID backfill failed for user ${user.id} (${externalUserId}):`, err);
      captureError(err, 'wa-bsuid-backfill', {
        user_id: user.id,
        external_user_id: externalUserId,
      }, 'warning');
    }
  }

  const lowerText = text.toLowerCase().trim();
  console.log(`[WhatsApp] Processing from ${from} (${isNewUser ? 'new' : 'existing'}): "${text}"`);

  try {
    const waService = getWhatsAppService();
    const { getBotMessages } = await import('../lib/bot-messages');
    const locale = user.language || 'en';
    const t = await getBotMessages(locale);
    const wa = t.whatsapp || {};

    // New user: send welcome + start onboarding + link TG prompt
    if (isNewUser) {
      const welcomeMsg = (wa.welcome || 'Welcome to FamCal, {name}! 👋').replace('{name}', user.name);
      await waService.sendMessage(from, welcomeMsg);

      const { startOnboarding } = await import('./whatsapp-onboarding');
      await startOnboarding(from, user);

      // Prompt to link Telegram account
      const botUsername = process.env.TELEGRAM_BOT_USERNAME;
      if (botUsername) {
        await waService.sendMessage(from, wa.linkTelegramPrompt || 'Already on Telegram? Link your account in one tap:', {
          whatsappUrlButton: {
            text: wa.linkTelegramButton || 'Link Telegram',
            url: `https://t.me/${botUsername}?start=connect`
          }
        });
      }

      res.status(200).json({ ok: true });
      return;
    }

    // Check if user is in onboarding flow
    const { isInOnboarding, handleOnboardingMessage } = await import('./whatsapp-onboarding');
    if (await isInOnboarding(from)) {
      const handled = await handleOnboardingMessage(from, text);
      if (handled) {
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Free-text "accept <token>" — pair-invite acceptance via plain message
    {
      const { parseAcceptCommand, handlePairAccept } = await import('./telegram/pair-handler');
      const acceptToken = parseAcceptCommand(text);
      if (acceptToken) {
        await handlePairAccept(from, user.id, acceptToken, locale, MessagingPlatform.WHATSAPP);
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Handle link code: "link ABC123"
    if (lowerText.startsWith('link ')) {
      const code = text.replace(/^link\s+/i, '').trim().toUpperCase();
      if (code.length >= 4) {
        const { redeemLinkCode } = await import('./account-linking');
        const result = await redeemLinkCode(code, from);

        if (result.success) {
          await waService.sendMessage(from, wa.linkSuccess || 'Accounts linked!');
          if (result.user?.telegramId) {
            await notifyTelegramAboutWhatsApp(result.user.telegramId, 'accounts linked');
          }
        } else {
          const errorMessages: Record<string, string> = {
            invalid_or_expired: wa.linkInvalidCode || 'Invalid or expired link code.',
            already_linked: wa.linkAlreadyLinked || 'Already linked.',
            telegram_user_not_found: wa.linkTgNotFound || 'Telegram user not found.',
            phone_in_use: wa.linkPhoneInUse || 'Phone already linked.',
          };
          await waService.sendMessage(from, errorMessages[result.error || 'unknown'] || wa.linkError || 'Something went wrong.');
        }
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Handle settings/setup command — send magic link
    if (lowerText === 'settings' || lowerText === 'setup') {
      const { generateMagicLink } = await import('./magic-link');
      const link = await generateMagicLink(user.id, locale);
      await waService.sendMessage(from, wa.settingsPrompt || 'Open your settings:', {
        whatsappUrlButton: { text: wa.settingsButton || 'Open Settings', url: link },
      });
      res.status(200).json({ ok: true });
      return;
    }

    // Route to command handlers
    const commandUserId = from;
    const tgId = user.telegramId;

    // Helper: run command async (fire-and-forget) to avoid webhook timeout
    const runAsync = (fn: () => Promise<void>, cmdName: string) => {
      // Return 200 immediately, process command in background
      res.status(200).json({ ok: true });

      // WA: fire typing indicator with repeating interval + stash message ID for voice
      let clearWaTyping: (() => void) | undefined;
      if (waMessageId) {
        waService.sendTypingIndicator(from, waMessageId).catch(() => {});
        const typingInterval = setInterval(() => {
          waService.sendTypingIndicator(from, waMessageId).catch(() => {});
        }, 4000);
        clearWaTyping = () => clearInterval(typingInterval);

        Promise.all([import('../utils/redis'), import('../config/redis-keys')]).then(([{ redis }, { REDIS_KEYS: RK }]) =>
          redis.set(RK.waLastMsg(from), waMessageId, { ex: 60 })
        ).catch(() => {});
      }

      fn()
        .then(() => { if (tgId) notifyTelegramAboutWhatsApp(tgId, cmdName).catch(e => captureError(e, 'wa-tg-notify', {}, 'warning')); })
        .catch(err => console.error(`[WhatsApp] ${cmdName} command error:`, err))
        .finally(() => { if (clearWaTyping) clearWaTyping(); });
    };

    if (lowerText === 'start' || lowerText === 'help' || lowerText === 'menu') {
      await waService.sendMessage(from, wa.menuPrompt || 'What would you like?', {
        whatsappList: {
          buttonText: wa.menuButton || 'View Options',
          sections: [{
            title: wa.menuSummaries || 'Summaries',
            rows: [
              { id: 'summary', title: wa.menuToday || '📅 Today', description: wa.menuTodayDesc || "Today's calendar" },
              { id: 'summary tmrw', title: wa.menuTomorrow || '📅 Tomorrow', description: wa.menuTomorrowDesc || "Tomorrow's calendar" },
              { id: 'lookahead', title: wa.menuThisWeek || '📅 This Week', description: wa.menuThisWeekDesc || 'Week ahead' },
              { id: 'nextweek', title: wa.menuNextWeek || '📅 Next Week', description: wa.menuNextWeekDesc || 'Next week' },
              { id: 'weather', title: wa.menuWeather || '🌤 Weather', description: wa.menuWeatherDesc || 'Weather forecast' },
            ],
          }, {
            title: wa.menuSettings || 'Settings',
            rows: [
              { id: 'settings', title: wa.menuSettingsItem || '⚙️ Settings', description: wa.menuSettingsDesc || 'Open settings' },
            ],
          }],
        },
      });
      if (tgId) await notifyTelegramAboutWhatsApp(tgId, 'start');
    } else if (lowerText.startsWith('summary')) {
      const args = lowerText.replace('summary', '').trim();
      runAsync(() => handleSummaryCommand(from, commandUserId, MessagingPlatform.WHATSAPP, args || undefined), 'summary');
      return;
    } else if (lowerText.startsWith('weather')) {
      const args = lowerText.replace('weather', '').trim();
      runAsync(() => handleWeatherCommand(from, commandUserId, MessagingPlatform.WHATSAPP, args || undefined), 'weather');
      return;
    } else if (lowerText === 'lookahead' || lowerText === 'week') {
      const { handleLookaheadCommand } = await import('./telegram');
      runAsync(() => handleLookaheadCommand(from, commandUserId, MessagingPlatform.WHATSAPP), 'lookahead');
      return;
    } else if (lowerText === 'nextweek') {
      const { handleNextWeekCommand } = await import('./telegram');
      runAsync(() => handleNextWeekCommand(from, commandUserId, MessagingPlatform.WHATSAPP), 'nextweek');
      return;
    } else if (lowerText.startsWith('feedback ')) {
      const feedbackText = text.replace(/^feedback\s+/i, '').trim();
      runAsync(() => handleFeedbackCommand(from, commandUserId, feedbackText), 'feedback');
      return;
    } else if (lowerText.startsWith('event_create:') || lowerText.startsWith('event_cancel:') ||
               lowerText.startsWith('edit_confirm:') || lowerText.startsWith('edit_cancel:') ||
               lowerText.startsWith('delete_confirm:') || lowerText.startsWith('delete_cancel:')) {
      // Voice event callbacks from WhatsApp reply buttons
      await handleWhatsAppVoiceCallback(from, text);
    } else if (!isNewUser && !lowerText.startsWith('link ')) {
      // Unknown command — show menu
      await waService.sendMessage(from, wa.menuPrompt || 'What would you like?', {
        whatsappList: {
          buttonText: wa.menuButton || 'View Options',
          sections: [{
            title: wa.menuSummaries || 'Summaries',
            rows: [
              { id: 'summary', title: wa.menuToday || '📅 Today', description: wa.menuTodayDesc || "Today's calendar" },
              { id: 'summary tmrw', title: wa.menuTomorrow || '📅 Tomorrow', description: wa.menuTomorrowDesc || "Tomorrow's calendar" },
              { id: 'lookahead', title: wa.menuThisWeek || '📅 This Week', description: wa.menuThisWeekDesc || 'Week ahead' },
              { id: 'nextweek', title: wa.menuNextWeek || '📅 Next Week', description: wa.menuNextWeekDesc || 'Next week' },
              { id: 'weather', title: wa.menuWeather || '🌤 Weather', description: wa.menuWeatherDesc || 'Weather forecast' },
            ],
          }, {
            title: wa.menuSettings || 'Settings',
            rows: [
              { id: 'settings', title: wa.menuSettingsItem || '⚙️ Settings', description: wa.menuSettingsDesc || 'Open settings' },
            ],
          }],
        },
      });
    }
  } catch (error) {
    console.error('[WhatsApp] Error handling command:', error);
  }

  res.status(200).json({ ok: true });
}

/**
 * Handle WhatsApp voice message for event creation
 */
async function handleWhatsAppVoice(phone: string, user: UserConfig, mediaId: string): Promise<void> {
  const waService = getWhatsAppService();
  const { getBotMessages } = await import('../lib/bot-messages');
  const t = await getBotMessages(user.language || 'en');
  const wa = t.whatsapp || {};

  try {

    // Check voice input enabled
    if (!user.voiceInputEnabled) {
      const { generateMagicLink } = await import('./magic-link');
      const link = await generateMagicLink(user.id, user.language || 'en');
      await waService.sendMessage(phone, t.voice?.featureDisabled || 'Voice input is disabled. Enable it in settings.', {
        whatsappUrlButton: { text: t.voice?.enableInSettings || 'Open Settings', url: link },
      });
      return;
    }

    // Check feature access
    const { checkFeatureAccess } = await import('./subscription-service');
    const voiceEventAccess = await checkFeatureAccess(user.id, 'voice_events');
    if (!voiceEventAccess.allowed) {
      await waService.sendMessage(phone, t.subscription?.voiceEventsRequired || 'Voice events require a Pro subscription.');
      return;
    }

    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('./calendar-provider');
    if (!(await hasUsableCalendar(user))) {
      await waService.sendMessage(phone, t.voice?.noCalendar || 'Please connect your Google Calendar first.');
      return;
    }
    const userCalendars = await getCalendarAssignmentsForUser(user);

    // Send processing message
    await waService.sendMessage(phone, t.voice?.processing || 'Processing your voice message...');

    // Download audio from WhatsApp
    const { WhatsAppAdapter } = await import('./messaging/whatsapp-adapter');
    const adapter = waService as InstanceType<typeof WhatsAppAdapter>;
    const audioBuffer = await adapter.downloadMedia(mediaId);

    console.log(`[WhatsApp Voice] Downloaded ${audioBuffer.length} bytes from media ${mediaId}`);

    // Process with Gemini (same pipeline as Telegram)
    const { resolveUserTimezone } = await import('../lib/timezone');
    const timezone = await resolveUserTimezone(user);
    const { processVoiceWithGemini } = await import('./voice/gemini-voice');
    const { getRecentEvents, formatRecentEventsBlock } = await import('./voice/recent-events-store');
    const recentEvents = await getRecentEvents(user.id);
    const recentBlock = formatRecentEventsBlock(recentEvents, timezone);
    const { intentResult, intentResults, transcription } = await processVoiceWithGemini(
      audioBuffer,
      user.language || 'en',
      userCalendars,
      timezone,
      recentBlock
    );

    console.log(`[WhatsApp Voice] Intent: ${intentResult.intent}, confidence: ${intentResult.confidence}`);

    // Multi-event batches are not yet supported on WhatsApp (PR 11 ships TG
    // bulk only). Surface a clear message rather than silently dropping all
    // but the first event.
    const validBulkWa = (intentResults || []).filter((r) => r.intent === 'create' && r.event && !r.error);
    if (validBulkWa.length > 1) {
      await waService.sendMessage(
        phone,
        wa.bulkUseTelegram ||
          `📋 I heard ${validBulkWa.length} events at once. Multi-event is only on Telegram for now — please dictate them one at a time here.`
      );
      return;
    }

    if (intentResult.intent === 'create' && intentResult.event) {
      // Store pending event in Redis
      const { REDIS_KEYS } = await import('../config/redis-keys');
      const { redis } = await import('../utils/redis');

      const pendingId = `wa:${phone}:${Date.now()}`;
      await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event: intentResult.event, user, transcription }, { ex: 600 });

      const { formatEventDateTime } = await import('./voice/confirmations');
      const dateTimeStr = formatEventDateTime(intentResult.event, user.language || 'en', t.voice?.allDay || 'All day', timezone);
      const locationStr = intentResult.event.location ? `\n📍 ${intentResult.event.location}` : '';

      await waService.sendMessage(phone,
        `*${wa.createEvent || 'Create event?'}*\n\n*${intentResult.event.title}*\n${dateTimeStr}${locationStr}\n\n_"${transcription}"_`,
        {
          whatsappButtons: [
            { id: `event_create:${pendingId}`, title: wa.createButton || '✅ Create' },
            { id: `event_cancel:${pendingId}`, title: wa.cancelButton || '❌ Cancel' },
          ],
        }
      );
    } else {
      const safeTranscription = transcription || '';
      await waService.sendMessage(phone,
        `${t.voice?.notUnderstood || "I couldn't understand that."}\n\n_I heard: "${safeTranscription}"_\n\n${t.voice?.tryExamples || 'Try something like:'}\n• "${t.voice?.example1 || 'Meeting tomorrow at 3pm'}"\n• "${t.voice?.example2 || 'Dentist on Thursday at 10'}"`,
      );
    }

    const { trackActivityAsync } = await import('./analytics-service');
    trackActivityAsync(user.id, 'voice_event_started', { language: user.language, platform: 'whatsapp' });
  } catch (error) {
    console.error('[WhatsApp Voice] Error:', error);
    await waService.sendMessage(phone, wa.voiceError || 'Sorry, could not process your voice message.').catch(e => captureError(e, 'wa-voice-error-send', { phone }, 'warning'));
  }
}

/**
 * Handle voice event callbacks from WhatsApp reply buttons
 */
async function handleWhatsAppVoiceCallback(phone: string, callbackData: string): Promise<void> {
  const waService = getWhatsAppService();
  // Try to get user language for i18n — default to English
  const userRecord = await getUserByWhatsAppPhone(phone);
  const { getBotMessages } = await import('../lib/bot-messages');
  const t = await getBotMessages(userRecord?.language || 'en');
  const wa = t.whatsapp || {};

  try {
    const [action, ...pendingIdParts] = callbackData.split(':');
    const pendingId = pendingIdParts.join(':');

    if (action === 'event_create') {
      const { getPendingEvent, removePendingEvent } = await import('./voice/confirmations');
      const pending = await getPendingEvent(pendingId);

      if (!pending) {
        await waService.sendMessage(phone, wa.eventExpired || 'This confirmation has expired.');
        return;
      }

      const { buildRecurrenceRule } = await import('./calendar');
      const { getProviderForUser } = await import('./calendar-provider');
      const provider = getProviderForUser(pending.user);
      const result = await provider.createEvent(
        pending.user,
        pending.event.calendarId || 'primary',
        {
          title: pending.event.title,
          startTime: new Date(pending.event.startTime),
          endTime: new Date(pending.event.endTime),
          location: pending.event.location,
          allDay: pending.event.allDay,
          recurrence: buildRecurrenceRule(pending.event.recurrence),
        }
      );

      await removePendingEvent(pendingId);

      if (result.success) {
        await waService.sendMessage(phone, `✅ ${t.voice?.created || 'Event created!'}\n\n*${pending.event.title}*`);

        const { incrementUsage } = await import('./subscription-service');
        const { trackActivityAsync } = await import('./analytics-service');
        trackActivityAsync(pending.user.id, 'voice_event_created', { platform: 'whatsapp' });
        incrementUsage(pending.user.id, 'voiceEvents').catch(e => captureError(e, 'usage-increment', { user_id: pending.user.id }, 'warning'));

        // Recent-events: feed the sliding window so follow-ups resolve via context (PR 9).
        if (result.eventId) {
          const { pushRecentEvent } = await import('./voice/recent-events-store');
          const calId = pending.event.calendarId || 'primary';
          await pushRecentEvent(pending.user.id, {
            provider: calId.startsWith('native:') ? 'native' : 'google',
            calendarId: calId,
            eventId: result.eventId,
            title: pending.event.title,
            startsAt: new Date(pending.event.startTime).toISOString(),
            endsAt: new Date(pending.event.endTime).toISOString(),
            action: 'create',
          });
        }
      } else {
        await waService.sendMessage(phone, `❌ ${(wa.eventFailed || 'Failed to create event: {error}').replace('{error}', result.error || '')}`);
      }
    } else if (action === 'event_cancel') {
      const { removePendingEvent } = await import('./voice/confirmations');
      await removePendingEvent(pendingId);
      await waService.sendMessage(phone, `❌ ${wa.eventCancelled || 'Event creation cancelled.'}`);
    } else if (action === 'edit_confirm') {
      const { getPendingEdit, removePendingEdit } = await import('./voice/confirmations');
      const pending = await getPendingEdit(pendingId);
      if (!pending) {
        await waService.sendMessage(phone, wa.eventExpired || 'This confirmation has expired.');
        return;
      }
      const { getProviderForUser } = await import('./calendar-provider');
      const provider = getProviderForUser(pending.user);
      const result = await provider.updateEvent(
        pending.user,
        pending.calendarId,
        pending.originalEvent.eventId!,
        { ...pending.updates, scope: pending.scope, recurringEventId: pending.originalEvent.recurringEventId }
      );
      await removePendingEdit(pendingId);
      await waService.sendMessage(phone, result.success
        ? `✅ ${wa.eventUpdated || 'Event updated!'}`
        : `❌ ${(wa.editFailed || 'Failed to update: {error}').replace('{error}', result.error || '')}`);
    } else if (action === 'edit_cancel') {
      const { removePendingEdit } = await import('./voice/confirmations');
      await removePendingEdit(pendingId);
      await waService.sendMessage(phone, `❌ ${wa.editCancelled || 'Edit cancelled.'}`);
    } else if (action === 'delete_confirm') {
      const { getPendingDelete, removePendingDelete } = await import('./voice/confirmations');
      const pending = await getPendingDelete(pendingId);
      if (!pending) {
        await waService.sendMessage(phone, wa.eventExpired || 'This confirmation has expired.');
        return;
      }
      const { getProviderForUser } = await import('./calendar-provider');
      const provider = getProviderForUser(pending.user);
      const result = await provider.deleteEvent(
        pending.user,
        pending.calendarId,
        pending.event.eventId!,
        pending.scope ? { scope: pending.scope, recurringEventId: pending.event.recurringEventId } : { recurringEventId: pending.event.recurringEventId }
      );
      await removePendingDelete(pendingId);
      await waService.sendMessage(phone, result.success
        ? `✅ ${wa.eventDeleted || 'Event deleted!'}`
        : `❌ ${(wa.deleteFailed || 'Failed to delete: {error}').replace('{error}', result.error || '')}`);
    } else if (action === 'delete_cancel') {
      const { removePendingDelete } = await import('./voice/confirmations');
      await removePendingDelete(pendingId);
      await waService.sendMessage(phone, `❌ ${wa.deleteCancelled || 'Delete cancelled.'}`);
    }
  } catch (error) {
    console.error('[WhatsApp Voice Callback] Error:', error);
    await waService.sendMessage(phone, wa.genericError || 'Something went wrong. Please try again.').catch(e => captureError(e, 'wa-callback-error-send', { phone }, 'warning'));
  }
}

/**
 * Send notification to Telegram when command comes from WhatsApp
 */
async function notifyTelegramAboutWhatsApp(telegramId: number, command: string): Promise<void> {
  try {
    const bot = getBot();
    await bot.sendMessage(
      telegramId,
      `📱 <b>WhatsApp Command:</b> /${command}\n<i>Response sent to WhatsApp</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('[WhatsApp] Failed to notify Telegram:', error);
  }
}
