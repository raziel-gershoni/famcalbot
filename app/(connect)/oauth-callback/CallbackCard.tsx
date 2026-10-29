'use client';

// What /oauth-callback shows when the connect did not go through (plan W4-3): one screen in the app's look, in the
// language the page picked (the owner's, else the browser's), with the way back the page picked (retryHrefFor). The
// words are `oauth.*` (the page's provider); a reason from the server or Google never reaches it.
//
// - expired: a link used up or out of date (no state, an old one, one not there, one a second callback used, an
//   expired one, an owner who is gone), and our redirect URI finding no code or no state;
// - denied: the person said no on Google's screen;
// - refused: Google came back with another error of its own (a workplace or school policy, an app it blocks);
// - generic: a failure on our side (the code exchange threw, parking the token failed);
// - exchangeFailed: Google refused the code;
// - noRefreshToken: Google gave no refresh token;
// - insufficientScopes: a permission was left unticked: the hero, the two permissions as rows of a card, the
//   footnote and Try again (the page's grouped ground: the rows are a card).
// Each of the others is the kit's state card on the plain ground: its title the page's h1, its action the way back.

import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS, FormCard, FormRow } from '@/components/app-ui/form-kit';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { StateCard } from '@/components/app-ui/StateCard';
import { CONNECT_CSS } from '../connect-css';
import { ConnectHero } from '../connect-ui';

export type CallbackKind = 'expired' | 'denied' | 'refused' | 'generic' | 'exchangeFailed' | 'noRefreshToken' | 'insufficientScopes';

export function CallbackCard({ kind, retryHref }: { kind: CallbackKind; retryHref: string }) {
  const t = useTranslations('oauth');
  if (kind === 'insufficientScopes') {
    return (
      <AppScreen ground="grouped">
        <style>{FORM_CSS}</style>
        <style>{CONNECT_CSS}</style>
        <div className="ch-form-page ch-form-page-grouped">
          <ConnectHero
            icon={<ShieldCheck aria-hidden="true" />}
            title={t('insufficientScopes.title')}
            lead={t.rich('insufficientScopes.description', { b: (chunks) => <b>{chunks}</b> })}
          />
          <SectionLabel>{t('insufficientScopes.checkAll')}</SectionLabel>
          <FormCard>
            <FormRow label={t('insufficientScopes.viewCalendar')} hint={t('insufficientScopes.viewCalendarDesc')} />
            <FormRow label={t('insufficientScopes.editEvents')} hint={t('insufficientScopes.editEventsDesc')} />
          </FormCard>
          <p className="ch-form-fixed">{t('insufficientScopes.footnote')}</p>
          <div className="ch-connect-actions">
            <a className="ch-btn ch-btn-primary ch-save" href={retryHref}>
              {t('insufficientScopes.tryAgain')}
            </a>
          </div>
        </div>
      </AppScreen>
    );
  }
  const card =
    kind === 'exchangeFailed'
      ? { title: t('exchangeFailed.title'), body: t('exchangeFailed.message'), label: t('exchangeFailed.tryAgain') }
      : { title: t(`${kind}.title`), body: t(`${kind}.body`), label: t('backToFamcal') };
  return (
    <AppScreen>
      <StateCard tone="crash" title={card.title} body={card.body} action={{ label: card.label, href: retryHref }} />
    </AppScreen>
  );
}
