'use client';

// The Subscription screen, in the home's design (spec 2026-10-19 §4, §5; plan W1b): an AppScreen on the grouped
// ground, a header with its back, the current plan with what the month has used (a meter per limit), and the plans
// to move to, each with its price in Telegram Stars.
//
// - The current plan is the effective plan (a trial or early access counts as Pro), with one tag (Current, Trial,
//   Early access) and one status line (early access, the trial's days left, or when a paid plan runs until). The
//   limits come from PLAN_CONFIGS, the same constants that enforce them; the calendar count arrives as a prop.
// - Only Basic and Pro have a card. A card offers its button when it is above the user's plan (a Pro user is never
//   offered Basic), or when it is the user's own paid plan while its month runs (ACTIVE or CANCELED with a period end,
//   until the expiry run moves them to Free): paying again renews it, and the new month starts that day, as the Terms
//   say (the renewal reminders' Renew lands here). Telegram must be linked: paying is a Telegram Stars invoice the bot
//   sends to the user's chat. A user with no Telegram is told that, in place of the buttons. A free gift has no period
//   end, so it offers nothing. Early access shows no plans at all.
// - Before the first pay button (Consumer Protection Law s.14C; Telegram's Stars checklist; the legal review of
//   2026-10-29, issue 4): the seller, one month that never renews, the 14-day full refund and the Terms, as a static
//   notice wherever a button shows (with the Terms' line on paying again before the month ends, for a paid month that
//   runs); each card's price stands above its button. The button agrees to the Terms ("I agree
//   to the Terms, pay"), never "I have read" (Standard Contracts Law s.4(12)). The Terms open in the person's language
//   outside the Mini App: Telegram's openLink, or a new tab in a browser (openExternalLink).
// - Choosing sends the request the upgrade route has always read; the invoice itself waits in the chat. In Telegram
//   the answer is Telegram's pop-up (the window closes once it is dismissed); in a browser it is a notice on the
//   page. A failure is a notice in the page's language, never the server's text, and is logged. While one request is
//   in flight every Choose button waits, so a second tap cannot send a second invoice.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser); both go to the calendar.

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Star } from 'lucide-react';
import { PLAN_CONFIGS, type PlanId } from '@/src/config/plans';
import { readInitData } from '@/src/lib/read-init-data';
import { openExternalLink, showTelegramAlert, telegramWebApp } from '@/src/lib/telegram-ui';
import { policyUrl, sellerName } from '@/src/lib/plan-disclosure';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS } from '@/components/app-ui/form-kit';
import { Meter } from '@/components/app-ui/Meter';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';
import { Tag } from '@/components/app-ui/Tag';
import { SUBSCRIPTION_CSS } from './subscription-css';

/** The plans from lowest to highest. */
const PLAN_ORDER: PlanId[] = ['FREE', 'BASIC', 'PRO'];
/** The plans that have a card to choose from. */
const CARD_PLANS = ['BASIC', 'PRO'] as const;
/** The date's language: Gregorian, in the device's zone (a period end is a point in time, not a Hebrew date). */
const DATE_LOCALES: Record<string, string> = { he: 'he-IL', ru: 'ru-RU', en: 'en-US' };

interface SubscriptionProps {
  plan: string;
  status: string;
  effectivePlan: PlanId;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface UsageProps {
  textSummaries: number;
  voiceSummaries: number;
  voiceEvents: number;
  reminders: number;
  cycleStartDate: string;
}

interface TrialProps {
  isTrialing: boolean;
  daysRemaining: number;
  trialEndsAt: string | null;
}

interface SubscriptionClientProps {
  userId: number;
  locale: string;
  subscription: SubscriptionProps;
  usage: UsageProps;
  trial: TrialProps;
  isEarlyAdopter: boolean;
  /** The user's calendars, counted the way the plan's limit counts them (calendarTotal). */
  calendarsUsed: number;
  /** Whether the user has a Telegram account: the invoice is sent to their chat. */
  telegramLinked: boolean;
}

export default function SubscriptionClient({ userId, locale, subscription, usage, trial, isEarlyAdopter, calendarsUsed, telegramLinked }: SubscriptionClientProps) {
  const t = useTranslations('subscription.screen');
  const names = useTranslations('subscription.plans');
  // The trial's days left is the home's own line (its banner), read from there so the two never say it twice
  const home = useTranslations('calendarHome');
  const ui = useTranslations('ui');
  const router = useRouter();
  const ids = useId();
  const [choosing, setChoosing] = useState<PlanId | null>(null);
  const [outcome, setOutcome] = useState<'sent' | 'failed' | null>(null);
  // Two taps can land before React shows the first one's busy state: the ref is what holds the second back
  const inFlight = useRef(false);

  const back = () => router.push(`/${locale}/dashboard?user_id=${userId}`);
  const nameOf = (id: PlanId) => names(`${id.toLowerCase()}.name`);
  const price = new Intl.NumberFormat(locale);

  // A plan above the user's own can be chosen (Pro is never offered Basic); the user's own is marked Current, unless it is a trial
  const canUpgrade = (id: PlanId) => PLAN_ORDER.indexOf(subscription.plan as PlanId) < PLAN_ORDER.indexOf(id);
  // The user's own paid month runs (a free gift has no period end): its card renews it
  const runningPaid = subscription.plan !== 'FREE' && subscription.currentPeriodEnd !== null && (subscription.status === 'ACTIVE' || subscription.status === 'CANCELED');
  const canPay = (id: PlanId) => canUpgrade(id) || (runningPaid && id === subscription.plan);
  const isCurrent = (id: PlanId) => id === subscription.plan && !trial.isTrialing;
  const anyPay = CARD_PLANS.some(canPay);
  const showButtons = anyPay && telegramLinked;

  const choose = async (plan: PlanId) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChoosing(plan);
    setOutcome(null);
    try {
      const response = await fetch('/api/subscription/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, plan, initData: readInitData(), recurring: false }),
      });
      if (response.ok) {
        const data: { success?: boolean } = await response.json();
        if (data.success) {
          // The invoice is in the chat. In Telegram its own pop-up says so and the window closes once it is dismissed;
          // elsewhere, or if the client can't show one, the page says it.
          if (!showTelegramAlert(t('invoiceSent'), () => telegramWebApp()?.close())) setOutcome('sent');
          return;
        }
      }
      console.warn('[subscription] upgrade refused:', response.status);
      setOutcome('failed');
      showTelegramAlert(t('upgradeFailed'));
    } catch (error) {
      console.error('[subscription] upgrade failed:', error);
      setOutcome('failed');
      showTelegramAlert(t('upgradeFailed'));
    } finally {
      inFlight.current = false;
      setChoosing(null);
    }
  };

  const openTerms = () => {
    const url = policyUrl('terms', locale);
    if (!openExternalLink(url)) console.warn('[subscription] could not open the Terms:', url);
  };

  const limits = PLAN_CONFIGS[subscription.effectivePlan].limits;
  const unlimited = t('unlimited');
  const measure = (label: string, used: number, limit: number) =>
    Number.isFinite(limit) ? <Meter label={label} used={used} limit={limit} valueText={t('usageOf', { used, limit })} /> : <Meter label={label} used={used} limit={null} valueText={unlimited} />;

  const tag = isEarlyAdopter ? t('badge.earlyAccess') : trial.isTrialing ? t('badge.trial') : t('badge.current');
  const status = isEarlyAdopter
    ? t('earlyAccessNote')
    : trial.isTrialing
      ? home('banner.trial', { count: trial.daysRemaining })
      : subscription.plan !== 'FREE' && subscription.currentPeriodEnd
        ? t('activeUntil', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString(DATE_LOCALES[locale] ?? 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }) })
        : null;

  const bullets: Record<(typeof CARD_PLANS)[number], string[]> = {
    BASIC: [t('basicSummaries'), t('calendarsUpTo', { count: PLAN_CONFIGS.BASIC.limits.calendars })],
    PRO: [t('proEverything'), t('proVoice'), t('proReminders')],
  };

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <style>{SUBSCRIPTION_CSS}</style>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={back} />
      <div className="ch-plan-page">
        <section className="ch-panel ch-plan-current" aria-labelledby={`${ids}-current`}>
          <div className="ch-plan-top">
            <div className="ch-plan-head ch-plan-head-current">
              <h2 id={`${ids}-current`} className="ch-plan-title">
                {nameOf(subscription.effectivePlan)}
              </h2>
              <Tag>{tag}</Tag>
            </div>
            {status ? <p className="ch-plan-note">{status}</p> : null}
          </div>
          <p className="ch-plan-note">{t('thisMonth')}</p>
          {measure(t('textSummaries'), usage.textSummaries, limits.textSummaries)}
          {measure(t('voiceSummaries'), usage.voiceSummaries, limits.voiceSummaries)}
          {measure(t('calendars'), calendarsUsed, limits.calendars)}
          {limits.voiceEvents ? <Meter label={t('voiceEvents')} used={usage.voiceEvents} limit={null} valueText={unlimited} /> : null}
          {limits.reminders ? <Meter label={t('reminders')} used={usage.reminders} limit={null} valueText={unlimited} /> : null}
        </section>

        {isEarlyAdopter ? null : (
          <>
            <SectionLabel>{t('plansLabel')}</SectionLabel>
            {showButtons ? (
              <Notice live={false} action={{ label: t('termsLink'), onClick: openTerms }}>
                {t('seller', { name: sellerName(locale) })}
                <br />
                {t('oneMonth')}
                <br />
                {t('refund')}
                {runningPaid ? (
                  <>
                    <br />
                    {t('renewNote')}
                  </>
                ) : null}
              </Notice>
            ) : null}
            {CARD_PLANS.map((id) => (
              <section key={id} className={id === 'PRO' ? 'ch-panel ch-panel-ring' : 'ch-panel'} aria-labelledby={`${ids}-${id}`}>
                <div className="ch-plan-head">
                  <h3 id={`${ids}-${id}`} className="ch-plan-name">
                    {nameOf(id)}
                  </h3>
                  <span className="ch-plan-price" aria-hidden="true">
                    <Star className="ch-plan-star" fill="currentColor" aria-hidden="true" />
                    <bdi dir="ltr">{price.format(PLAN_CONFIGS[id].priceStars)}</bdi>
                    <span className="ch-plan-per">{t('perMonth')}</span>
                  </span>
                  <span className="ch-visually-hidden">{t('priceA11y', { price: PLAN_CONFIGS[id].priceStars })}</span>
                  {isCurrent(id) ? <Tag>{t('badge.current')}</Tag> : null}
                </div>
                <ul className="ch-plan-list" role="list">
                  {bullets[id].map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {showButtons && canPay(id) ? (
                  <button
                    type="button"
                    className={id === 'PRO' ? 'ch-btn ch-btn-primary ch-plan-choose ch-plan-choose-pro' : 'ch-btn ch-btn-outline ch-plan-choose'}
                    disabled={choosing !== null}
                    aria-busy={choosing === id || undefined}
                    onClick={() => void choose(id)}
                  >
                    {choosing === id ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
                    {t('agreeAndPay')}
                  </button>
                ) : null}
              </section>
            ))}
            {outcome === 'sent' ? <Notice>{t('invoiceSent')}</Notice> : null}
            {outcome === 'failed' ? <Notice tone="error">{t('upgradeFailed')}</Notice> : null}
            {showButtons ? <p className="ch-plan-fine">{t('starsNote')}</p> : null}
            {anyPay && !telegramLinked ? <Notice>{t('needsTelegram')}</Notice> : null}
          </>
        )}
      </div>
    </AppScreen>
  );
}
