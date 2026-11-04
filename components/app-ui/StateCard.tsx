'use client';

// The card for a state that stands in for a screen, or for part of one (F1; spec 2026-10-19
// §4): the home's busy and retry card, its crash card, PageGate's gate and error cards, a
// missing parameter, a page that doesn't exist. It is the home's card (.ch-home-card*, in
// ./screen.ts) with the same markup it always had, so those cards look as they did.
//
// - tone 'plain' is a state inside a screen: role="status", the title a paragraph.
//   tone 'crash' is a screen that cannot show: role="alert", the title the page's h1.
// - The action is a link when it has an href, else a button; both read as the primary
//   button. A second, quieter action sits under it (the browser card's "Open the bot"), and a
//   third under that (the browser card: Sign in, then WhatsApp, then the bot).
// - A card needs the app's tokens above it: inside an AppScreen. MissingParameterCard and
//   NotFoundCard bring their own.
// - MissingParameterCard outside Telegram (a browser; an account made on famcal.bot has no bot, 6c-1) names no chat and
//   offers Sign in: /signin opens the calendar of a browser that is still signed in. On the server, and in the render
//   that hydrates its markup, it is the card inside Telegram, as it always was.
//
// Strings: the card takes its text already translated; the two cards below read `ui.*` (and Sign in, `pageGate.signIn`).

import { useSyncExternalStore, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { isInTelegram } from '@/src/lib/telegram-ui';
import { signInHref } from '@/src/site/signin';
import { AppScreen } from './AppScreen';

const subscribeNothing = () => () => {};
/** The server, and the first render that hydrates its markup: the card inside Telegram, as it was. */
const assumeTelegram = () => true;

export interface StateAction {
  label: string;
  /** A link when set, else a button that calls onClick. */
  href?: string;
  onClick?: () => void;
}

export interface StateCardProps {
  title: string;
  body?: ReactNode;
  action?: StateAction;
  /** A quieter action under the first. */
  secondary?: StateAction;
  /** One more quiet action under the second (or under the first when there is no second). */
  tertiary?: StateAction;
  tone?: 'plain' | 'crash';
}

function ActionButton({ action, primary }: { action: StateAction; primary: boolean }) {
  const className = `ch-btn${primary ? ' ch-btn-primary' : ''} ch-home-card-action`;
  return action.href ? (
    <a className={className} href={action.href}>
      {action.label}
    </a>
  ) : (
    <button type="button" className={className} onClick={action.onClick}>
      {action.label}
    </button>
  );
}

export function StateCard({ title, body, action, secondary, tertiary, tone = 'plain' }: StateCardProps) {
  const crash = tone === 'crash';
  const Title = crash ? 'h1' : 'p';
  const primary = action ? <ActionButton action={action} primary /> : null;
  return (
    <div className={crash ? 'ch-home-card ch-crash' : 'ch-home-card'} role={crash ? 'alert' : 'status'}>
      <Title className="ch-home-card-title">{title}</Title>
      {body ? <p className="ch-home-card-body">{body}</p> : null}
      {secondary || tertiary ? (
        <div className="ch-home-card-actions">
          {primary}
          {secondary ? <ActionButton action={secondary} primary={false} /> : null}
          {tertiary ? <ActionButton action={tertiary} primary={false} /> : null}
        </div>
      ) : (
        primary
      )}
    </div>
  );
}

/**
 * A page opened without the parameter its link carries (user_id): one card in the app's look, in the page's language.
 * Inside Telegram it says to open the link again from the bot's message; in a browser it says to sign in, with Sign in.
 */
export function MissingParameterCard() {
  const t = useTranslations('ui.missingParameter');
  const gate = useTranslations('pageGate');
  const locale = useLocale();
  const inTelegram = useSyncExternalStore(subscribeNothing, isInTelegram, assumeTelegram);
  return (
    <AppScreen>
      {inTelegram ? (
        <StateCard tone="crash" title={t('title')} body={t('body')} />
      ) : (
        <StateCard tone="crash" title={t('title')} body={t('bodyBrowser')} action={{ label: gate('signIn'), href: signInHref(locale) }} />
      )}
    </AppScreen>
  );
}

/** A path that is no page: the same card, with the way back to the calendar. */
export function NotFoundCard() {
  const t = useTranslations('ui.notFound');
  const locale = useLocale();
  return (
    <AppScreen>
      <StateCard tone="crash" title={t('title')} body={t('body')} action={{ label: t('home'), href: `/${locale}/dashboard` }} />
    </AppScreen>
  );
}
