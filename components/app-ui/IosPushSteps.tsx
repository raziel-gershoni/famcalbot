'use client';

// The three steps that add FamCal to the Home Screen so an iPhone or an iPad can show notifications (iOS 16.4 or later): a
// real numbered list, with the Share icon at the start of step 1 (6c-2). Settings' card and the home's banner show it; the
// words are settings.push.ios.step1..3 (IOS_STEPS), in the screen's own language.
//
// Client-safe: lucide's icon and the translations only.

import { useTranslations } from 'next-intl';
import { Share } from 'lucide-react';
import { IOS_STEPS } from '@/src/lib/use-push-device';

export function IosPushSteps({ className }: { className: string }) {
  const t = useTranslations('settings');
  return (
    <ol className={className}>
      {IOS_STEPS.map((key, index) => (
        <li key={key}>
          {index === 0 ? <Share size={14} aria-hidden="true" focusable="false" style={{ verticalAlign: '-2px', marginInlineEnd: 4 }} /> : null}
          {t(key)}
        </li>
      ))}
    </ol>
  );
}
