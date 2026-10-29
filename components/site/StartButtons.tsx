import { MessageCircle, Send } from 'lucide-react';
import { TELEGRAM_BOT_URL, whatsappStartUrl } from '@/src/site/config';

// The two start buttons (spec 2026-10-28-public-website §2.5): Telegram, then WhatsApp, the same size and weight, with
// one class list for both (the channel's colour comes from data-channel, not from a class). Side by side on a wide
// screen, stacked on a phone. The compact pair (the header's) shows the app's name alone and keeps the full words as
// its accessible name, which contains the visible one. Server-safe: no hook.

export interface StartWords {
  telegram: string;
  whatsapp: string;
  telegramShort: string;
  whatsappShort: string;
  /** The WhatsApp chat's first message, in the visitor's language (bot.whatsapp.greeting). */
  greeting: string;
}

type Translate = (key: string) => string;

/** The start buttons' words, in the page's language. */
export function startWords(t: Translate): StartWords {
  return {
    telegram: t('site.cta.telegram'),
    whatsapp: t('site.cta.whatsapp'),
    telegramShort: t('site.cta.telegramShort'),
    whatsappShort: t('site.cta.whatsappShort'),
    greeting: t('bot.whatsapp.greeting'),
  };
}

export function StartButtons({ words, compact = false }: { words: StartWords; compact?: boolean }) {
  return (
    <div className={compact ? 'site-starts site-starts-compact' : 'site-starts'}>
      <a className="site-start" data-channel="telegram" href={TELEGRAM_BOT_URL} aria-label={compact ? words.telegram : undefined}>
        <Send aria-hidden="true" focusable="false" />
        {compact ? words.telegramShort : words.telegram}
      </a>
      <a className="site-start" data-channel="whatsapp" href={whatsappStartUrl(words.greeting)} aria-label={compact ? words.whatsapp : undefined}>
        <MessageCircle aria-hidden="true" focusable="false" />
        {compact ? words.whatsappShort : words.whatsapp}
      </a>
    </div>
  );
}

/** The one honest line under the buttons: what is on Telegram alone for now. */
export function HonestLine({ text }: { text: string }) {
  return <p className="site-honest">{text}</p>;
}
