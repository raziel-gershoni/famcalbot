'use client';

import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { AgendaView } from '@/app/[locale]/(app)/dashboard/AgendaView';
import type { AgendaModel } from '@/src/lib/calendar-view/agenda';

// The hero's calendar (spec 2026-10-28-public-website §5.3): the calendar home's real AgendaView with the sample week,
// so it can never fall behind the app. It is drawn twice, in the app's light and dark looks (.ch-app with data-theme,
// as AppScreen sets it), and the site's style sheet shows the one that matches the device's setting: CSS alone picks
// it, so the server's markup is already right and nothing flashes. The frame around it is inert: a row does nothing.
// It reads only the calendar home's words for the rows (`messages`), in its own provider.

const noop = () => undefined;
const HINTS = { voiceEvents: true, reminders: true } as const;

export function DemoAgenda({ agenda, locale, messages }: { agenda: AgendaModel; locale: string; messages: AbstractIntlMessages }) {
  const look = (theme: 'light' | 'dark') => (
    <div className={`ch-app site-demo-app site-demo-${theme}`} data-theme={theme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <AgendaView agenda={agenda} hints={HINTS} selected={null} onSelect={noop} onShowNextWeek={noop} onRetry={noop} onChooseCalendars={noop} />
    </div>
  );
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={agenda.tz}>
      {look('light')}
      {look('dark')}
    </NextIntlClientProvider>
  );
}
