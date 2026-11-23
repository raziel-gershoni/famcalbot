'use client';

// The Google calendars screen when Google refuses the stored token (page-data's googleReconnect notice: classifyGoogleError
// gives 'token', a revoked or expired grant; menu revamp spec 2026-11-24 §4). Missing scopes never come here (page-data sends
// them to /refresh-token) and any other failure is PageGate's generic retry card.
//
// - The screen's own title and Back, on the grouped ground as the list is: a card that says the connection stopped working,
//   with Reconnect Google as its action, a link to /refresh-token?user_id=… (a full page load: that page sits outside [locale],
//   picks the language itself and returns to this screen after Google's consent).
// - Disconnect Google under it (./GoogleDisconnect.tsx), so a person whose token died can still disconnect, as Settings allowed
//   before. Its result goes to the Calendars screen, as the list's does.
// - Back closes the disconnect sheet first (its closer does nothing while the request runs), else goes to the Calendars screen.
//
// No user data: the notice is static (PageGate renders it from the page's notices), and its words come from messages.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS } from '@/components/app-ui/form-kit';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { StateCard } from '@/components/app-ui/StateCard';
import GoogleDisconnect from './GoogleDisconnect';

interface GoogleReconnectNoticeProps {
  /** The page's own ?user_id (a telegramId or a DB id), as the list's links use it. */
  userId: number;
  locale: string;
}

export default function GoogleReconnectNotice({ userId, locale }: GoogleReconnectNoticeProps) {
  const t = useTranslations('selectCalendars');
  const ui = useTranslations('ui');
  const router = useRouter();
  // The disconnect sheet's closer while it is open (GoogleDisconnect reports it), for Back
  const [googleClose, setGoogleClose] = useState<(() => void) | null>(null);
  // A swipe down in the sheet must not minimize the app.
  useTelegramVerticalSwipes(googleClose !== null);

  const toCalendars = () => router.push(`/${locale}/calendars?user_id=${userId}`);
  const back = () => {
    if (googleClose) googleClose();
    else toCalendars();
  };

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={back} />
      <div className="ch-form-page ch-form-page-grouped">
        <StateCard title={t('reconnectCard.title')} body={t('reconnectCard.body')} action={{ label: t('account.reconnect'), href: `/refresh-token?user_id=${userId}` }} />
        <GoogleDisconnect userId={userId} connected onDisconnected={toCalendars} onSheet={(close) => setGoogleClose(() => close)} />
      </div>
    </AppScreen>
  );
}
