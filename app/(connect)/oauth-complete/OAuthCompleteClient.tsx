'use client';

// /oauth-complete in the app's design (plan W4-3): one more tap, in Telegram or WhatsApp, to finish connecting Google.
// It always opens in a browser (after Google's consent), so its look follows the browser's light or dark.
//
// - Before the fragment is read (the server's render and the first paint) the app's loader, never an empty card.
// - Ready: an AppScreen on the grouped ground (the owner line is a notice on a card): a success icon, the title and the
//   subtitle, the owner line ({name} through next-intl), then the buttons the fragment's b= allows: Finish in Telegram
//   (the primary), Finish in WhatsApp (outlined beside Telegram, the primary alone) with its hint under it.
// - A fragment that is missing or bad: the kit's state card, "This link is incomplete".
//
// The pendingId, the owner's first name and the buttons are in the URL fragment (finishPageUrl), which only this
// client reads and which never reaches a server. Words: oauthComplete.* and pageGate.loading (the page's provider).

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { CircleCheck } from 'lucide-react';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { StateCard } from '@/components/app-ui/StateCard';
import { CONNECT_CSS } from '../connect-css';
import { ConnectHero, ConnectLoader } from '../connect-ui';

/** What the claim buttons say. */
export interface FinishButtonWords {
  telegramButton: string;
  whatsappButton: string;
  /** Under the WhatsApp button: nothing is connected until that message is sent */
  whatsappHint: string;
}

interface OAuthCompleteClientProps {
  botUsername: string;
  waNumber: string;
}

/** What the OAuth callback put in the fragment: #p=<pendingId>&n=<first name>&b=tg,wa */
export interface FinishParams {
  pendingId: string;
  ownerName: string;
  telegram: boolean;
  whatsapp: boolean;
}

const PENDING_ID = /^[A-Za-z0-9_-]{32}$/;

export function parseFinishFragment(hash: string): FinishParams | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const pendingId = params.get('p') ?? '';
  if (!PENDING_ID.test(pendingId)) return null;
  const buttons = (params.get('b') ?? '').split(',');
  return { pendingId, ownerName: params.get('n') ?? '', telegram: buttons.includes('tg'), whatsapp: buttons.includes('wa') };
}

/**
 * The claim links: the bot's /start gc_<id>, and a WhatsApp message that contains gc_<id>.
 * A button shows only when the owner has that channel and it is configured.
 */
export function finishLinks(
  params: FinishParams,
  botUsername: string,
  waNumber: string,
  waText: string,
): { telegram?: string; whatsapp?: string } {
  const code = `gc_${params.pendingId}`;
  return {
    ...(params.telegram && botUsername ? { telegram: `https://t.me/${botUsername}?start=${code}` } : {}),
    ...(params.whatsapp && waNumber
      ? { whatsapp: `https://wa.me/${waNumber}?text=${encodeURIComponent(waText.replace('{code}', code))}` }
      : {}),
  };
}

/**
 * The claim buttons. Telegram is the primary; WhatsApp is outlined beside it and the primary alone. WhatsApp only
 * prefills the message, so its hint under it says to send it.
 */
export function FinishButtons({ links, translations: t }: { links: { telegram?: string; whatsapp?: string }; translations: FinishButtonWords }) {
  return (
    <div className="ch-connect-actions">
      {links.telegram ? (
        <a className="ch-btn ch-btn-primary ch-save" href={links.telegram}>
          {t.telegramButton}
        </a>
      ) : null}
      {links.whatsapp ? (
        <>
          <a className={`ch-btn ${links.telegram ? 'ch-btn-outline' : 'ch-btn-primary'} ch-save`} href={links.whatsapp}>
            {t.whatsappButton}
          </a>
          <p className="ch-form-fixed">{t.whatsappHint}</p>
        </>
      ) : null}
    </div>
  );
}

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export default function OAuthCompleteClient({ botUsername, waNumber }: OAuthCompleteClientProps) {
  const t = useTranslations('oauthComplete');
  const gate = useTranslations('pageGate');
  // The fragment exists only in the browser; the server render has none (null)
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => null);
  if (hash === null) {
    return (
      <AppScreen ground="grouped">
        <ConnectLoader label={gate('loading')} />
      </AppScreen>
    );
  }
  const params = parseFinishFragment(hash);
  // The message as written, {code} and all: finishLinks puts the claim code in
  const links = params ? finishLinks(params, botUsername, waNumber, t.raw('whatsappText') as string) : {};
  if (!params || (!links.telegram && !links.whatsapp)) {
    return (
      <AppScreen>
        <StateCard tone="crash" title={t('incompleteTitle')} body={t('incompleteBody')} />
      </AppScreen>
    );
  }
  return (
    <AppScreen ground="grouped">
      <style>{FORM_CSS}</style>
      <style>{CONNECT_CSS}</style>
      <div className="ch-form-page ch-form-page-grouped">
        <ConnectHero icon={<CircleCheck aria-hidden="true" />} title={t('title')} lead={t('subtitle')} />
        <Notice>{params.ownerName ? t('owner', { name: params.ownerName }) : t('ownerUnnamed')}</Notice>
        <FinishButtons
          links={links}
          translations={{ telegramButton: t('telegramButton'), whatsappButton: t('whatsappButton'), whatsappHint: t('whatsappHint') }}
        />
      </div>
    </AppScreen>
  );
}
