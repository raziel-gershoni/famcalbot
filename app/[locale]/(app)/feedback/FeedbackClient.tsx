'use client';

// The Feedback screen, in the home's design (spec 2026-10-19 §4, §5; plan W1b): an AppScreen on the grouped ground, a header with
// its back, one text field with a count line under it, and a Send bar that stays at the bottom. A sent message gives way to a
// thank-you card in the same screen.
//
// - This page has no data of its own: its server page does no user lookup (it would tell anyone whether a user exists), so there
//   is no gate and no loader; /api/feedback proves the user when the message is sent. Telegram's full height and swipes are
//   taken on mount, as every app screen has them.
// - The count is of the trimmed text, which is what the route counts: Send is off until there are ten characters (spaces do
//   not count), and the field stops at 1000. The limits are FEEDBACK_LIMITS, the route's own.
// - Why a send failed is said in the page's language, never in the server's words: the daily limit, a page opened outside the
//   user's FamCal chat (the server could not tell who sent it), the limits again, or "couldn't send". The text stays, so a
//   failure never costs what was written.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser).

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { FEEDBACK_LIMITS } from '@/src/lib/feedback-limits';
import { readInitData } from '@/src/lib/read-init-data';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS, FormCard, SaveBar, TextField } from '@/components/app-ui/form-kit';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { StateCard } from '@/components/app-ui/StateCard';
import { startMiniApp } from '../PageGate';

interface FeedbackClientProps {
  userId: number;
  locale: string;
}

export default function FeedbackClient({ userId, locale }: FeedbackClientProps) {
  const t = useTranslations('feedback');
  const ui = useTranslations('ui');
  const router = useRouter();
  const countId = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    startMiniApp();
  }, []);

  const back = () => router.push(`/${locale}/dashboard?user_id=${userId}`);

  const trimmed = text.trim();
  const short = trimmed.length < FEEDBACK_LIMITS.minLength;

  const edit = (value: string) => {
    setText(value);
    setError(null);
  };

  const send = async () => {
    if (sending || short) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, user_id: userId, initData: readInitData() }),
      });
      if (response.status === 429) {
        setError(t('rateLimit'));
        return;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        // Nobody could say who this is: the page was opened outside the user's own chat with the bot
        console.warn('[feedback] send refused:', response.status);
        setError(t('openFromChat'));
        return;
      }
      const data: { success?: boolean; error?: string } = await response.json();
      if (response.ok && data.success) {
        setSent(true);
        return;
      }
      if (data.error === 'rateLimit') {
        setError(t('rateLimit'));
        return;
      }
      console.warn('[feedback] send refused:', response.status);
      setError(data.error === 'tooShort' ? t('tooShort', { min: FEEDBACK_LIMITS.minLength }) : data.error === 'tooLong' ? t('tooLong', { max: FEEDBACK_LIMITS.maxLength }) : t('failed'));
    } catch (err) {
      console.error('[feedback] send failed:', err);
      setError(t('failed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={back} />
      {sent ? (
        <StateCard title={t('thanksTitle')} body={t('thanksBody')} action={{ label: t('backToCalendar'), onClick: back }} />
      ) : (
        <>
          <div className="ch-form-page">
            <p className="ch-form-fixed">{t('intro')}</p>
            <div className="ch-form-group">
              <FormCard>
                <TextField multiline rows={8} label={t('fieldLabel')} placeholder={t('placeholder')} maxLength={FEEDBACK_LIMITS.maxLength} describedBy={countId} value={text} onChange={edit} />
              </FormCard>
              <div id={countId} className="ch-form-count">
                <span>{trimmed.length > 0 && short ? t('moreNeeded', { count: FEEDBACK_LIMITS.minLength - trimmed.length }) : null}</span>
                <bdi dir="ltr">{`${trimmed.length} / ${FEEDBACK_LIMITS.maxLength}`}</bdi>
              </div>
            </div>
          </div>
          <SaveBar sticky label={t('send')} busy={sending} disabled={short} error={error} onSave={send} />
        </>
      )}
    </AppScreen>
  );
}
