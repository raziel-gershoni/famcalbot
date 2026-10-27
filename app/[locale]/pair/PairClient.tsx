'use client';

// The Partner screen, in the home's design (spec 2026-10-19 §4, §5; plan W3): an AppScreen on the grouped ground, a header
// with its back, and the state the person is in.
//
// - Paired: a card with the partner's name and since when, and an Unlink row. The row asks in a bottom sheet (what the
//   server does: you stop seeing each other's calendars and every shared calendar goes back to private), never in the
//   browser's own pop-up.
// - Not paired: the intro, then, when a link exists, a card with the link in a copy field, how long it lasts and a
//   Revoke row; then Generate. Generating again replaces the link (the server revokes the old one).
// - One request at a time: the button of the request that runs is busy, and every action is disabled meanwhile. A failure
//   is said in the page's language, and logged. The page's errors sit at the top of the page; the unlink's sit in its
//   sheet, since the sheet covers the page.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser). It closes the unlink
//   sheet when that is open (and does nothing while the unlink works), else returns to the calendar.
// - The requests are /api/pair/invite (POST, DELETE) and /api/pair (DELETE), with the Telegram launch data in the body.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link as LinkIcon } from 'lucide-react';
import { readInitData } from '@/src/lib/read-init-data';
import { formatDeviceDate, formatDeviceDayTime } from '@/src/lib/calendar-view/device-time';
import { useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { CopyField } from '@/components/app-ui/CopyField';
import { FORM_CSS, FormCard, FormRow } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';

interface Props {
  userId: number;
  locale: string;
  initial: {
    partner: { name: string; acceptedAt: string | null } | null;
    invite: { token: string; url: string; expiresAt: string } | null;
  };
}

function getInitData(): string {
  return readInitData();
}

type Request = 'create' | 'revoke' | 'unlink';
type Failure = 'generic' | 'alreadyPaired';

export default function PairClient({ userId, locale, initial }: Props) {
  const t = useTranslations('pair');
  const ui = useTranslations('ui');
  const router = useRouter();

  const [partner, setPartner] = useState(initial.partner);
  const [invite, setInvite] = useState(initial.invite);
  const [busy, setBusy] = useState<Request | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinkFailed, setUnlinkFailed] = useState(false);
  // A swipe down in the sheet must not minimize the app.
  useTelegramVerticalSwipes(unlinkOpen);

  const unlinking = busy === 'unlink';

  const send = (method: 'POST' | 'DELETE', path: string) =>
    fetch(`${path}?user_id=${userId}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: getInitData() }),
    });

  /** One request at a time: `kind` is busy while `work` runs; a throw is logged and `fail` tells the person. */
  const run = async (kind: Request, work: () => Promise<void>, fail: () => void) => {
    if (busy) return;
    setBusy(kind);
    try {
      await work();
    } catch (error) {
      console.error(`[pair] ${kind} failed:`, error);
      fail();
    } finally {
      setBusy(null);
    }
  };

  const createInvite = () =>
    run(
      'create',
      async () => {
        setFailure(null);
        const res = await send('POST', '/api/pair/invite');
        const data = await res.json();
        if (!res.ok || !data.success) {
          console.warn('[pair] create refused:', res.status, data.error);
          setFailure(data.error === 'INVITER_ALREADY_PAIRED' ? 'alreadyPaired' : 'generic');
          return;
        }
        setInvite({ token: data.token, url: data.url, expiresAt: data.expiresAt });
      },
      () => setFailure('generic'),
    );

  const revoke = () =>
    run(
      'revoke',
      async () => {
        setFailure(null);
        const res = await send('DELETE', '/api/pair/invite');
        if (!res.ok) {
          console.warn('[pair] revoke refused:', res.status);
          setFailure('generic');
          return;
        }
        setInvite(null);
      },
      () => setFailure('generic'),
    );

  const unlink = () =>
    run(
      'unlink',
      async () => {
        setUnlinkFailed(false);
        const res = await send('DELETE', '/api/pair');
        if (!res.ok) {
          console.warn('[pair] unlink refused:', res.status);
          setUnlinkFailed(true);
          return;
        }
        setPartner(null);
        setUnlinkOpen(false);
      },
      () => setUnlinkFailed(true),
    );

  const openUnlink = () => {
    setUnlinkFailed(false);
    setUnlinkOpen(true);
  };
  // Not while the unlink works: the sheet stays until the server has answered
  const closeUnlink = () => {
    if (unlinking) return;
    setUnlinkOpen(false);
    setUnlinkFailed(false);
  };
  const back = () => {
    if (unlinkOpen) closeUnlink();
    else router.push(`/${locale}/dashboard?user_id=${userId}`);
  };

  const since = partner?.acceptedAt ? formatDeviceDate(partner.acceptedAt, locale) : '';
  const anyBusy = busy !== null;

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={back} />
      <div className="ch-form-page">
        {failure ? <Notice tone="error">{failure === 'alreadyPaired' ? t('errorAlreadyPaired') : t('errorGeneric')}</Notice> : null}

        {partner ? (
          <FormCard>
            <FormRow label={t('pairedWith', { name: partner.name })} hint={since ? t('pairedSince', { when: since }) : undefined} />
            <button type="button" className="ch-form-row ch-danger-row" aria-haspopup="dialog" disabled={anyBusy} onClick={openUnlink}>
              {t('unlink')}
            </button>
          </FormCard>
        ) : (
          <>
            <p className="ch-form-fixed">{t('notPairedSubtitle')}</p>
            {invite ? (
              <div className="ch-form-group">
                <SectionLabel>{t('linkLabel')}</SectionLabel>
                <FormCard>
                  <CopyField label={t('linkLabel')} value={invite.url} copyLabel={t('copyLink')} copiedLabel={t('copied')} />
                  <div className="ch-form-row">
                    <span className="ch-form-label">
                      <span className="ch-form-hint">{t('activeLink')}</span>
                      <span className="ch-form-hint">{t('expires', { when: formatDeviceDayTime(invite.expiresAt, locale) })}</span>
                    </span>
                  </div>
                  <button type="button" className="ch-form-row ch-danger-row" disabled={anyBusy} aria-busy={busy === 'revoke' || undefined} onClick={revoke}>
                    {t('revoke')}
                    {busy === 'revoke' ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
                  </button>
                </FormCard>
              </div>
            ) : null}
            <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={anyBusy} aria-busy={busy === 'create' || undefined} onClick={createInvite}>
              {busy === 'create' ? <span className="ch-form-spinner" aria-hidden="true" /> : <LinkIcon size={18} aria-hidden="true" />}
              {busy === 'create' ? t('creating') : t('generateInvite')}
            </button>
          </>
        )}
      </div>

      {unlinkOpen && partner ? (
        <BottomSheet label={t('unlinkTitle', { name: partner.name })} closeLabel={ui('cancel')} closeDisabled={unlinking} onClose={closeUnlink}>
          <h2 className="ch-sheet-heading">{t('unlinkTitle', { name: partner.name })}</h2>
          <p className="ch-sheet-sub">{t('unlinkBody')}</p>
          <div className="ch-sheet-stack">
            {unlinkFailed ? <Notice tone="error">{t('errorGeneric')}</Notice> : null}
            <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" disabled={unlinking} aria-busy={unlinking || undefined} onClick={unlink}>
              {unlinking ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
              {unlinking ? t('unlinking') : t('unlink')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
    </AppScreen>
  );
}
