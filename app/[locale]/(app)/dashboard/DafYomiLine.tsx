'use client';

// The day's Daf Yomi page as one quiet line, "Daf Yomi · Arachin 3" (spec §6, release 1).
// It shows under the selected day's header in the Month (DayPanel) and under each day header
// in the Agenda (DayList), never on a fold line and nowhere else. Muted like the holiday
// line (.ch-daf in AGENDA_CSS). A day before the first cycle has no page: nothing is drawn.
// The words come from FamCal's own table (calendarHome.dafYomi); the page is worked out in the
// browser by src/lib/calendar-view/daf-yomi.ts.

import { BookOpen } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { dafYomiWords } from '@/src/lib/calendar-view/daf-yomi';
import type { DayKey } from '@/src/lib/calendar-view/types';

export function DafYomiLine({ day }: { day: DayKey }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const words = dafYomiWords(day, locale, t.raw('dafYomi.tractates') as Record<string, string>);
  if (!words) return null;
  return (
    <p className="ch-daf">
      <BookOpen className="ch-daf-icon" size={14} aria-hidden="true" focusable="false" />
      <span>{t('dafYomi.line', words)}</span>
    </p>
  );
}
