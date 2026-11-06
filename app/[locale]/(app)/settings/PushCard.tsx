'use client';

// Settings' "Notifications on this device" card (spec 2026-11-05-web-push §2.1, §2.4; plan 6c-2 Task 5), for an account with
// no chat in a real browser while push is set up (page-data's push.key; Settings renders it only then, right above Sign in on
// the web). It saves itself, as Sign in on the web does: it is not part of the Save bar. Its states (usePushDevice):
// - a browser that can't show notifications (no service worker or no push): one line;
// - an iPhone or an iPad in a browser tab: the three steps to add FamCal to the Home Screen (iOS 16.4 or later), no switch;
// - a sign-in over an hour old: Sign in again (which asks the browser nothing) and the hour's note;
// - checking, off, turning on, on, turning off: the switch; "Tap again to allow" when the browser wants a tap of its own;
// - what came of a press: a notice (not answered and blocked are notes; refused, failed and a failed turn off are alerts).
// onDevices tells the screen the account's count of devices that are on (its rows a notification can honour follow it).
// Strings: settings.push.*. Lucide's bell (the switch at rest) and spinner (a press or the check is out); the iPhone steps are
// IosPushSteps (a numbered list with the Share icon in step 1).

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, Loader2 } from 'lucide-react';
import { FormCard, FormRow, SwitchRow } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { IosPushSteps } from '@/components/app-ui/IosPushSteps';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { pushLineKey, usePushDevice } from '@/src/lib/use-push-device';
import type { PushProps } from '@/src/lib/web-push-client';

export default function PushCard({ userId, push, onDevices }: { userId: number; push: PushProps; onDevices: (update: (count: number) => number) => void }) {
  const t = useTranslations('settings');
  const locale = useLocale();
  const device = usePushDevice(userId, push, locale, onDevices);
  const said = pushLineKey(device.line);
  const working = (text: string) => (
    <>
      <Loader2 size={16} className="ch-spin" aria-hidden="true" /> {text}
    </>
  );

  let card: ReactNode;
  if (device.support === null) {
    card = (
      <FormCard>
        <div className="ch-form-row">
          <p className="ch-form-fixed ch-working" role="status">
            {working(t('push.checking'))}
          </p>
        </div>
      </FormCard>
    );
  } else if (device.support === 'unsupported') {
    card = (
      <FormCard>
        <FormRow label={t('push.unsupported')} />
      </FormCard>
    );
  } else if (device.support === 'ios-install') {
    card = (
      <FormCard>
        <FormRow label={t('push.ios.title')} hint={t('push.ios.body')} />
        <div className="ch-form-row">
          <IosPushSteps className="ch-sheet-list" />
        </div>
      </FormCard>
    );
  } else if (device.phase === 'stale' || device.phase === 'leaving') {
    const leaving = device.phase === 'leaving';
    card = (
      <>
        <FormCard>
          <FormRow label={t('push.switchOff')} hint={t('push.offHint')} />
          <button type="button" className="ch-form-row ch-action-row" disabled={leaving} aria-busy={leaving || undefined} onClick={device.press}>
            {leaving ? working(t('push.signInAgain')) : t('push.signInAgain')}
          </button>
        </FormCard>
        <Notice>{t('push.staleNote')}</Notice>
      </>
    );
  } else {
    const on = device.phase === 'on' || device.phase === 'stopping';
    // The bell marks the row at rest; a spinner takes its place while a press or the open's check is out
    const rested = (text: string) => (
      <span className="ch-working">
        <Bell size={16} aria-hidden="true" focusable="false" style={{ flex: 'none' }} />
        {text}
      </span>
    );
    const label =
      device.phase === 'checking'
        ? working(t('push.checking'))
        : device.phase === 'busy'
          ? working(t('push.turningOn'))
          : device.phase === 'stopping'
            ? working(t('push.turningOff'))
            : on
              ? rested(t('push.switchOn'))
              : device.line === 'again'
                ? rested(t('push.again'))
                : rested(t('push.switchOff'));
    card = (
      <FormCard>
        <SwitchRow label={label} hint={on ? t('push.onHint') : t('push.offHint')} checked={on} disabled={device.phase !== 'on' && device.phase !== 'off'} busy={device.phase !== 'on' && device.phase !== 'off'} onChange={device.press} />
      </FormCard>
    );
  }

  return (
    <>
      <SectionLabel>{t('push.title')}</SectionLabel>
      {card}
      {said ? <Notice tone={said.problem ? 'error' : 'info'}>{t(said.key)}</Notice> : null}
    </>
  );
}
