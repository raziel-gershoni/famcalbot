'use client';

// Settings' "Google Calendar" section and its confirmation (docs/superpowers/specs/
// 2026-10-25-disconnect-google-design.md). The section is shown while Google is connected; the
// button opens a dialog with the "Also delete the FamCal copies from Google" box (ticked by
// default); the result says Google is disconnected and lists the copy calendars that stayed.
//
// GoogleDisconnectView is presentational (the smoke renders every phase); GoogleDisconnect owns
// the state and the request. The look is the Settings page's own (indigo accent, 16px section
// title with the underline, the modal's overlay) with 44 px targets, no hover-only styling and
// logical properties, so it mirrors in Hebrew. The page is light, but the dialog also follows
// the device's dark setting. The rules are plain classes with a gd- prefix: the page's global
// "* { margin: 0; padding: 0 }" would override utility classes.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, Unplug } from 'lucide-react';
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

export const GOOGLE_DISCONNECT_CSS = `
  .gd-title { font-size: 16px; font-weight: 600; color: #374151; margin: 24px 0 8px 0; padding-block-end: 8px; border-block-end: 2px solid #667eea; }
  .gd-hint { font-size: 13px; color: #6b7280; margin-block: 0 12px; line-height: 1.4; }
  .gd-btn { min-height: 44px; padding-inline: 16px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
  .gd-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .gd-btn-open { background: #fef2f2; color: #b91c1c; }
  .gd-btn-confirm { background: #dc2626; color: #ffffff; }
  .gd-btn-quiet { background: #f3f4f6; color: #374151; }
  .gd-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px; }
  .gd-dialog { background: #ffffff; color: #374151; border-radius: 12px; padding: 24px; max-width: 360px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2); text-align: start; }
  .gd-dialog-title { font-size: 18px; font-weight: 600; margin: 0 0 8px 0; display: flex; align-items: center; gap: 8px; }
  .gd-body { font-size: 14px; line-height: 1.5; margin: 0 0 16px 0; }
  .gd-check { display: flex; align-items: flex-start; gap: 12px; min-height: 44px; margin: 0 0 16px 0; cursor: pointer; }
  .gd-check input { width: 22px; height: 22px; flex-shrink: 0; margin-block-start: 1px; accent-color: #dc2626; }
  .gd-check-label { font-size: 14px; font-weight: 600; display: block; }
  .gd-check-hint { font-size: 13px; color: #6b7280; display: block; margin-block-start: 2px; line-height: 1.4; }
  .gd-list { margin: 0 0 16px 0; padding-inline-start: 20px; font-size: 14px; }
  .gd-list li { margin-block: 4px; overflow-wrap: anywhere; }
  .gd-error { margin: 0 0 16px 0; padding: 12px 14px; border-radius: 12px; background: #fef2f2; color: #b91c1c; font-size: 14px; line-height: 1.4; }
  .gd-working { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #6b7280; margin: 0 0 16px 0; }
  .gd-buttons { display: flex; gap: 12px; flex-wrap: wrap; }
  .gd-buttons .gd-btn { flex: 1; }
  .gd-spin { animation: gd-spin 1s linear infinite; }
  @keyframes gd-spin { to { transform: rotate(360deg); } }
  @media (prefers-color-scheme: dark) {
    .gd-dialog { background: #1f2937; color: #f3f4f6; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); }
    .gd-check-hint, .gd-working { color: #9ca3af; }
    .gd-error { background: #450a0a; color: #fecaca; }
    .gd-btn-confirm { background: #dc2626; color: #ffffff; }
    .gd-btn-quiet { background: #374151; color: #f3f4f6; }
  }
`;

export function GoogleDisconnectView(props: GoogleDisconnectViewProps) {
  const t = useTranslations('settings.googleDisconnect');
  const { phase, connected, deleteCopies, leftover, error } = props;
  if (!connected && phase === 'idle') return null;
  const working = phase === 'working';

  return (
    <>
      <style>{GOOGLE_DISCONNECT_CSS}</style>
      {connected && (
        <div>
          <h3 className="gd-title">{t('sectionTitle')}</h3>
          <p className="gd-hint">{t('sectionHint')}</p>
          <button type="button" className="gd-btn gd-btn-open" onClick={props.onOpen}>
            <Unplug size={18} aria-hidden="true" /> {t('button')}
          </button>
        </div>
      )}
      {phase !== 'idle' && (
        <div className="gd-overlay" onClick={phase === 'confirm' ? props.onCancel : phase === 'done' ? props.onClose : undefined}>
          <div className="gd-dialog" role="dialog" aria-modal="true" aria-labelledby="gd-dialog-title" onClick={(e) => e.stopPropagation()}>
            {phase === 'done' ? (
              <>
                <h2 id="gd-dialog-title" className="gd-dialog-title">
                  <CheckCircle2 size={22} aria-hidden="true" /> {t('doneTitle')}
                </h2>
                <p className="gd-body">{t('doneBody')}</p>
                {leftover.length > 0 && (
                  <>
                    <p className="gd-body">{t('leftoverIntro')}</p>
                    <ul className="gd-list">
                      {leftover.map((name, i) => (
                        <li key={`${i}:${name}`} dir="auto">{name}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="gd-buttons">
                  <button type="button" className="gd-btn gd-btn-quiet" onClick={props.onClose}>{t('close')}</button>
                </div>
              </>
            ) : (
              <>
                <h2 id="gd-dialog-title" className="gd-dialog-title">{t('confirmTitle')}</h2>
                <p className="gd-body">{t('confirmBody')}</p>
                <p className="gd-body">{t('confirmShared')}</p>
                <label className="gd-check">
                  <input type="checkbox" checked={deleteCopies} onChange={props.onToggleCopies} disabled={working} />
                  <span>
                    <span className="gd-check-label">{t('copiesLabel')}</span>
                    <span className="gd-check-hint">{t('copiesHint')}</span>
                    <span className="gd-check-hint">{t('copiesKeptNote')}</span>
                  </span>
                </label>
                {error && <p role="alert" className="gd-error">{t(error === 'busy' ? 'errorBusy' : 'errorFailed')}</p>}
                {working && (
                  <p className="gd-working"><Loader2 size={16} className="gd-spin" aria-hidden="true" /> {t('working')}</p>
                )}
                <div className="gd-buttons">
                  <button type="button" className="gd-btn gd-btn-quiet" onClick={props.onCancel} disabled={working}>{t('cancel')}</button>
                  <button type="button" className="gd-btn gd-btn-confirm" onClick={props.onConfirm} disabled={working}>{t('confirm')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface GoogleDisconnectProps {
  userId: number;
  connected: boolean;
  /** Called when the user closes the result: Google is no longer connected. */
  onDisconnected: () => void;
}

export default function GoogleDisconnect({ userId, connected, onDisconnected }: GoogleDisconnectProps) {
  const [phase, setPhase] = useState<DisconnectPhase>('idle');
  const [deleteCopies, setDeleteCopies] = useState(true);
  const [leftover, setLeftover] = useState<string[]>([]);
  const [error, setError] = useState<DisconnectErrorCode | null>(null);

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
