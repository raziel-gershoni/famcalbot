'use client';

// The card for a state that stands in for a screen, or for part of one (F1; spec 2026-10-19
// §4): the home's busy and retry card, its crash card, PageGate's gate and error cards, a
// missing parameter, a page that doesn't exist. It is the home's card (.ch-home-card*, in
// ./screen.ts) with the same markup it always had, so those cards look as they did.
//
// - tone 'plain' is a state inside a screen: role="status", the title a paragraph.
//   tone 'crash' is a screen that cannot show: role="alert", the title the page's h1.
// - The action is a link when it has an href, else a button; both read as the primary
//   button. A second, quieter action sits under it (the browser card's "Open the bot").
// - A card needs the app's tokens above it: inside an AppScreen. MissingParameterCard and
//   NotFoundCard bring their own.
//
// Strings: the card takes its text already translated; the two cards below read `ui.*`.

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppScreen } from './AppScreen';

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

export function StateCard({ title, body, action, secondary, tone = 'plain' }: StateCardProps) {
  const crash = tone === 'crash';
  const Title = crash ? 'h1' : 'p';
  const primary = action ? <ActionButton action={action} primary /> : null;
  return (
    <div className={crash ? 'ch-home-card ch-crash' : 'ch-home-card'} role={crash ? 'alert' : 'status'}>
      <Title className="ch-home-card-title">{title}</Title>
      {body ? <p className="ch-home-card-body">{body}</p> : null}
      {secondary ? (
        <div className="ch-home-card-actions">
          {primary}
          <ActionButton action={secondary} primary={false} />
        </div>
      ) : (
        primary
      )}
    </div>
  );
}

/** A page opened without the parameter its link carries (user_id): one card in the app's look, in the page's language. */
export function MissingParameterCard() {
  const t = useTranslations('ui.missingParameter');
  return (
    <AppScreen>
      <StateCard tone="crash" title={t('title')} body={t('body')} />
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
