'use client';

// The time sheet (editor upgrades spec §1): an hours wheel and a minutes wheel, looping and
// always left to right, in a bottom sheet. 5-minute steps in the editor, 15 in Settings
// (`step`). A stored minute off the step (10:07 from Google or the bot) joins the wheel, so
// opening and closing changes nothing. Done applies; the scrim, Back, Escape and Cancel close
// without applying.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { hourOptions, joinTime, minuteOptions, splitTime } from '@/src/lib/calendar-view/picker-model';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { PICKER_CSS, Wheel, WheelPickerWrapper } from './picker-kit';

export interface TimePickerSheetProps {
  /** The sheet's accessible name ("Start time"). */
  label: string;
  /** The current time, HH:mm; anything else opens on 09:00. */
  value: string;
  /** Minutes between the wheel's stops. */
  step: number;
  onPick: (time: string) => void;
  onClose: () => void;
}

/** What a sheet opens on when the field holds no time. */
const FALLBACK_TIME = '09:00';

export function TimePickerSheet({ label, value, step, onPick, onClose }: TimePickerSheetProps) {
  const t = useTranslations('calendarHome');
  const start = splitTime(value) ?? (splitTime(FALLBACK_TIME) as { hour: string; minute: string });
  const [hour, setHour] = useState(start.hour);
  const [minute, setMinute] = useState(start.minute);
  // The list is built from the time the sheet opened on, so an off-step minute stays on the wheel after it is moved.
  const [minutes] = useState(() => minuteOptions(step, start.minute));
  const [hours] = useState(hourOptions);
  // Built once: a fresh array on a render makes the library re-snap a wheel that is still spinning.
  const hourItems = useMemo(() => hours.map((h) => ({ value: h, label: h })), [hours]);
  const minuteItems = useMemo(() => minutes.map((m) => ({ value: m, label: m })), [minutes]);

  return (
    <>
      <style>{PICKER_CSS}</style>
      <BottomSheet label={label} closeLabel={t('editor.cancel')} onClose={onClose}>
        <div className="ch-picker">
          <div className="ch-picker-body" dir="ltr">
            <WheelPickerWrapper className="ch-wheels">
              <Wheel label={t('picker.hour')} options={hourItems} value={hour} onChange={setHour} infinite />
              <span className="ch-wheel-colon" aria-hidden="true">
                :
              </span>
              <Wheel label={t('picker.minute')} options={minuteItems} value={minute} onChange={setMinute} infinite />
            </WheelPickerWrapper>
          </div>
          <button type="button" className="ch-btn ch-btn-primary ch-picker-done" onClick={() => onPick(joinTime(hour, minute))}>
            {t('picker.done')}
          </button>
        </div>
      </BottomSheet>
    </>
  );
}
