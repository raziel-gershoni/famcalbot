import { Globe, MessageCircle, Send } from 'lucide-react';
import { TELEGRAM_BOT_URL, whatsappStartUrl } from '@/src/site/config';

// The two start buttons (spec 2026-10-28-public-website §2.5): Telegram, then WhatsApp, the same size and weight, with
// one class list for both (the channel's colour comes from data-channel, not from a class). Side by side on a wide
// screen, stacked on a phone. The compact pair (the header's) shows the app's name alone and keeps the full words as
// its accessible name, which contains the visible one. Server-safe: no hook.
//
// A third, "Use in the browser" (web sign-up spec §2.16), opens /signin, where a new person can also create an account.
// It shows only where the page passes its /signin address (browserHref: signInHref(locale)): the landing's hero and
// Start again, a blog post's end and a zmanim city page's FamCal block. Never on /signin and never in the header, which
// has Sign in. A plain anchor, never a Next <Link>: a link a page draws is not prefetched (the zmanim pages' limit counts
// a prefetch, smoke-zmanim-pages Z10). Outlined in the page's own colours, not a brand's.

export interface StartWords {
  telegram: string;
  whatsapp: string;
  telegramShort: string;
  whatsappShort: string;
  browser: string;
  browserShort: string;
  /** The WhatsApp chat's first message, in the visitor's language (bot.whatsapp.greeting). */
  greeting: string;
}

type Translate = ((key: string) => string) & { raw: (key: string) => unknown };

/** The start buttons' words, in the page's language. */
export function startWords(t: Translate): StartWords {
  return {
    telegram: t('site.cta.telegram'),
    whatsapp: t('site.cta.whatsapp'),
    telegramShort: t('site.cta.telegramShort'),
    whatsappShort: t('site.cta.whatsappShort'),
    browser: t('site.cta.browser'),
    browserShort: t('site.cta.browserShort'),
    // A bot string: {name}-style, not ICU, so it is read raw
    greeting: String(t.raw('bot.whatsapp.greeting')),
  };
}

export function StartButtons({ words, compact = false, browserHref }: { words: StartWords; compact?: boolean; browserHref?: string }) {
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
      {browserHref ? (
        <a className="site-start" data-channel="browser" href={browserHref} aria-label={compact ? words.browser : undefined}>
          <Globe aria-hidden="true" focusable="false" />
          {compact ? words.browserShort : words.browser}
        </a>
      ) : null}
    </div>
  );
}

/** The one honest line under the buttons: what is on Telegram alone for now. */
export function HonestLine({ text }: { text: string }) {
  return <p className="site-honest">{text}</p>;
}
