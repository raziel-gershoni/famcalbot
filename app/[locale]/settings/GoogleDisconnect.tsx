'use client';

// Settings' "Google Calendar" section and its confirmation (docs/superpowers/specs/
// 2026-10-25-disconnect-google-design.md). The section is shown while Google is connected; the
// button opens a sheet with the "Also delete the FamCal copies from Google" switch (on by
// default); the result says Google is disconnected and lists the copy calendars that stayed.
//
// GoogleDisconnectView is presentational (the smoke renders every phase); GoogleDisconnect owns
// the state and the request. Both are drawn with the app's kit (components/app-ui: a section
// label, a card of rows, a switch row, a notice, the bottom sheet), so they follow the tokens, the
// device's scheme and the page's direction. The sheet cannot be closed while the request is in
// flight. `onSheet` tells the screen what its Back should do: the sheet's closer while the sheet
// is open (one that does nothing while the request is in flight), null when it is closed.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { FormCard, SwitchRow } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { requestDisconnect, type DisconnectErrorCode } from './google-disconnect-client';

export type DisconnectPhase = 'idle' | 'confirm' | 'working' | 'done';

export interface GoogleDisconnectViewProps {
  /** Google is connected: the section shows. */
  connected: boolean;
  phase: DisconnectPhase;
  deleteCopies: boolean;
  /** The copy calendars that stayed in Google, named as Google shows them. */
  leftover: string[];
  error: DisconnectErrorCode | null;
  onOpen: () => void;
  onToggleCopies: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}

export function GoogleDisconnectView(props: GoogleDisconnectViewProps) {
  const t = useTranslations('settings.googleDisconnect');
  const { phase, connected, deleteCopies, leftover, error } = props;
  if (!connected && phase === 'idle') return null;
  const working = phase === 'working';
  const done = phase === 'done';

  return (
    <>
      {connected && (
        <>
          <SectionLabel>{t('sectionTitle')}</SectionLabel>
          <FormCard>
            <div className="ch-form-row">
              <span className="ch-form-hint">{t('sectionHint')}</span>
            </div>
            <button type="button" className="ch-form-row ch-danger-row" onClick={props.onOpen}>
              {t('button')}
            </button>
          </FormCard>
        </>
      )}
      {phase !== 'idle' && (
        <BottomSheet label={done ? t('doneTitle') : t('confirmTitle')} closeLabel={done ? t('close') : t('cancel')} closeDisabled={working} onClose={done ? props.onClose : props.onCancel}>
          {done ? (
            <>
              <h2 className="ch-sheet-heading">{t('doneTitle')}</h2>
              <p className="ch-sheet-sub">{t('doneBody')}</p>
              {leftover.length > 0 && (
                <>
                  <p className="ch-sheet-sub">{t('leftoverIntro')}</p>
                  <ul className="ch-sheet-list">
                    {leftover.map((name, i) => (
                      <li key={`${i}:${name}`} dir="auto">
                        {name}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <>
              <h2 className="ch-sheet-heading">{t('confirmTitle')}</h2>
              <p className="ch-sheet-sub">{t('confirmBody')}</p>
              <p className="ch-sheet-sub">{t('confirmShared')}</p>
              <div className="ch-sheet-stack">
                <FormCard>
                  <SwitchRow label={t('copiesLabel')} hint={t('copiesHint')} checked={deleteCopies} disabled={working} onChange={props.onToggleCopies} />
                </FormCard>
                <p className="ch-form-fixed">{t('copiesKeptNote')}</p>
                {error && <Notice tone="error">{t(error === 'busy' ? 'errorBusy' : 'errorFailed')}</Notice>}
                {working && (
                  <p className="ch-form-fixed ch-working">
                    <Loader2 size={16} className="ch-spin" aria-hidden="true" /> {t('working')}
                  </p>
                )}
                <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" onClick={props.onConfirm} disabled={working}>
                  {t('confirm')}
                </button>
              </div>
            </>
          )}
        </BottomSheet>
      )}
    </>
  );
}

interface GoogleDisconnectProps {
  userId: number;
  connected: boolean;
  /** Called when the user closes the result: Google is no longer connected. */
  onDisconnected: () => void;
  /** What Back should do while the sheet is open: its closer (a no-op during the request), or null once it is closed. */
  onSheet?: (close: (() => void) | null) => void;
}

const noop = () => {};

export default function GoogleDisconnect({ userId, connected, onDisconnected, onSheet }: GoogleDisconnectProps) {
  const [phase, setPhase] = useState<DisconnectPhase>('idle');
  const [deleteCopies, setDeleteCopies] = useState(true);
  const [leftover, setLeftover] = useState<string[]>([]);
  const [error, setError] = useState<DisconnectErrorCode | null>(null);

  // The closers run later than the render that made them: they read the parent's latest callbacks.
  const latest = useRef({ onDisconnected, onSheet });
  useEffect(() => {
    latest.current = { onDisconnected, onSheet };
  });
  useEffect(() => {
    const closer = phase === 'confirm' ? () => setPhase('idle') : phase === 'done' ? () => { setPhase('idle'); latest.current.onDisconnected(); } : phase === 'working' ? noop : null;
    latest.current.onSheet?.(closer);
  }, [phase]);
  useEffect(() => () => latest.current.onSheet?.(null), []);

  const confirm = async () => {
    setError(null);
    setPhase('working');
    const result = await requestDisconnect(userId, deleteCopies);
    if (result.kind === 'ok') {
      setLeftover(result.leftover);
      setPhase('done');
    } else {
      setError(result.code);
      setPhase('confirm');
    }
  };

  return (
    <GoogleDisconnectView
      connected={connected}
      phase={phase}
      deleteCopies={deleteCopies}
      leftover={leftover}
      error={error}
      onOpen={() => { setDeleteCopies(true); setError(null); setPhase('confirm'); }}
      onToggleCopies={() => setDeleteCopies((v) => !v)}
      onConfirm={confirm}
      onCancel={() => setPhase('idle')}
      onClose={() => { setPhase('idle'); onDisconnected(); }}
    />
  );
}
