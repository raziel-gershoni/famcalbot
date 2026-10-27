'use client';

// Settings' location sheet: the place as a field, "Use my current location" under it, and what the
// check of the place says (checking, or why it is not a place). A place the device finds fills the
// field itself, with no second question. The page owns the draft and the check; this sheet shows
// them, so Telegram's Back can close it the same way its Done button does (the page calls the
// same closer). Closing hands the draft to the page, which checks a changed one.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, MapPin } from 'lucide-react';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { FormCard, TextField } from '@/components/app-ui/form-kit';
import { devicePosition, reverseLookup } from './location-lookup';

/** What the check of the page's last place came to (shown here too, while the field still holds that place). */
export type LocationProblem = 'notFound' | 'failed';

export interface LocationSheetProps {
  draft: string;
  onDraft: (draft: string) => void;
  /** The page is checking the place it was handed. */
  checking: boolean;
  problem: LocationProblem | null;
  onClose: () => void;
}

export function LocationSheet({ draft, onDraft, checking, problem, onClose }: LocationSheetProps) {
  const t = useTranslations('settings');
  const ui = useTranslations('ui');
  // What the page's check was about: the place the sheet opened with. A check's problem or progress is that place's, so
  // it shows only while the field still holds it; typing, or a place the device found, hides it until the next check.
  const [opened] = useState(draft);
  const sameAsChecked = draft === opened;
  const [locating, setLocating] = useState(false);
  const [deviceProblem, setDeviceProblem] = useState<'noDeviceLocation' | 'deviceFailed' | null>(null);

  const useCurrent = async () => {
    if (!navigator.geolocation) {
      setDeviceProblem('noDeviceLocation');
      return;
    }
    setLocating(true);
    setDeviceProblem(null);
    try {
      const position = await devicePosition();
      const place = await reverseLookup(position.coords.latitude, position.coords.longitude);
      if (place) onDraft(place);
      else setDeviceProblem('deviceFailed');
    } catch (error) {
      console.error('[settings] current location failed:', error);
      setDeviceProblem('deviceFailed');
    } finally {
      setLocating(false);
    }
  };

  const checkProblem = sameAsChecked ? problem : null;
  const error = deviceProblem ? t(`location.${deviceProblem}`) : checkProblem ? t(checkProblem === 'notFound' ? 'location.notFound' : 'location.checkFailed') : null;

  return (
    <BottomSheet label={t('location.label')} closeLabel={ui('done')} onClose={onClose}>
      <h2 className="ch-sheet-heading">{t('location.label')}</h2>
      <div className="ch-sheet-stack">
        <FormCard>
          <TextField
            label={t('location.label')}
            value={draft}
            onChange={(value) => {
              setDeviceProblem(null);
              onDraft(value);
            }}
            placeholder={t('location.placeholder')}
            error={error}
          />
        </FormCard>
        <button type="button" className="ch-btn" onClick={useCurrent} disabled={locating}>
          {locating ? <Loader2 size={18} className="ch-spin" aria-hidden="true" /> : <MapPin size={18} aria-hidden="true" />}
          {t('location.useCurrent')}
        </button>
        {checking && sameAsChecked ? (
          <p className="ch-form-fixed" role="status">
            {t('location.checking')}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
