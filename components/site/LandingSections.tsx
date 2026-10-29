import type { ComponentType, SVGProps } from 'react';
import {
  BellRing,
  Cake,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Camera,
  Check,
  CirclePause,
  CloudRain,
  HeartHandshake,
  Info,
  Languages,
  Link2,
  Mic,
  Minus,
  Palette,
  PilcrowRight,
  Radio,
  Star,
  Sun,
  Sunrise,
  Sunset,
  Users,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { TRIAL_DURATION_DAYS } from '@/src/config/plans';
import { cheapestPlanWith, planCards, type PlanFlag } from '@/src/site/plans';
import { LegalInline, sellerView } from './LegalInline';
import { ReminderPing } from './ReminderPing';
import { HonestLine, StartButtons, type StartWords } from './StartButtons';

// The landing's sections after the hero, in the spec's order (2026-10-28-public-website §3.2): How it works (#how),
// What it does, Telegram or WhatsApp, Plans (#plans), From the founder, and Start again (#start). Every word is a
// message; every icon is lucide's. Server components: no client code.
//
// The plans end with the "Cancel a payment" link to the Terms' cancellation part, with the four ways to cancel next to
// it (Consumer Protection Law s.14I(b), (e)(2)): the bot's /paysupport, email, post and phone, the seller's details
// from src/lib/seller.ts.

type Translate = ((key: string, values?: Record<string, string | number>) => string) & { raw: (key: string) => unknown };
type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const icon = (Glyph: Icon, className = 'site-icon') => <Glyph className={className} aria-hidden="true" focusable="false" />;

export function HowItWorks({ t }: { t: Translate }) {
  return (
    <section id="how" className="site-section" aria-labelledby="how-title">
      <div className="site-wrap">
        <h2 id="how-title" className="site-h2">
          {t('landing.how.title')}
        </h2>
        <ol className="site-steps">
          {([1, 2, 3] as const).map((n) => (
            <li key={n} className="site-step">
              <span className="site-step-number" aria-hidden="true">
                {n}
              </span>
              <h3 className="site-h3">{t(`landing.how.step${n}.title`)}</h3>
              <p>{t(`landing.how.step${n}.body`, { days: TRIAL_DURATION_DAYS })}</p>
            </li>
          ))}
        </ol>
        <p className="site-note">
          {icon(Link2)}
          <span>{t('landing.how.google')}</span>
        </p>
      </div>
    </section>
  );
}

/**
 * The groups of What it does (copy deck §2.3): each item's key, its icon, whether it is on Telegram alone, and the plan
 * table's switch it needs (src/config/plans.ts: reminders, voiceEvents), for a group or for one item. A feature that
 * needs a switch Free doesn't have is tagged with the cheapest plan that has it ("Pro").
 */
const FEATURES: { group: string; telegram?: boolean; plan?: PlanFlag; items: { key: string; icon: Icon; telegram?: boolean; plan?: PlanFlag }[] }[] = [
  {
    group: 'calendar',
    items: [
      { key: 'own', icon: CalendarDays },
      { key: 'colours', icon: Palette },
      { key: 'partner', icon: HeartHandshake },
    ],
  },
  {
    group: 'jewish',
    items: [
      { key: 'dates', icon: CalendarRange },
      { key: 'holidays', icon: Star },
      { key: 'hebrewRepeat', icon: Cake },
      { key: 'sunList', icon: Sun },
      { key: 'zmanReminders', icon: Sunset, telegram: true, plan: 'reminders' },
      { key: 'pause', icon: CirclePause },
    ],
  },
  {
    group: 'adding',
    plan: 'voiceEvents',
    items: [
      { key: 'voice', icon: Mic },
      { key: 'photo', icon: Camera, telegram: true },
    ],
  },
  {
    group: 'reminders',
    telegram: true,
    plan: 'reminders',
    items: [
      { key: 'doneSnooze', icon: BellRing },
      { key: 'both', icon: Users },
    ],
  },
  {
    group: 'summaries',
    items: [
      { key: 'daily', icon: Sunrise },
      { key: 'week', icon: CalendarClock },
      { key: 'weather', icon: CloudRain },
      { key: 'show', icon: Radio },
    ],
  },
  {
    group: 'languages',
    items: [
      { key: 'three', icon: Languages },
      { key: 'rtl', icon: PilcrowRight },
    ],
  },
];

export function Features({ t }: { t: Translate }) {
  const tag = <span className="site-tag">{t('landing.features.telegramTag')}</span>;
  const planTag = (flag: PlanFlag | undefined) => {
    const plan = flag ? cheapestPlanWith(flag) : null;
    return plan && plan !== 'FREE' ? <span className="site-tag">{t(`landing.plans.${plan.toLowerCase()}.name`)}</span> : null;
  };
  return (
    <section className="site-section site-band" aria-labelledby="features-title">
      <div className="site-wrap">
        <h2 id="features-title" className="site-h2">
          {t('landing.features.title')}
        </h2>
        <div className="site-groups">
          {FEATURES.map(({ group, telegram, plan, items }) => (
            <section key={group} className="site-group" aria-labelledby={`features-${group}`}>
              <h3 id={`features-${group}`} className="site-group-title">
                {t(`landing.features.${group}.title`)}
                {telegram ? tag : null}
                {planTag(plan)}
              </h3>
              <ul className="site-list">
                {items.map((item) => (
                  <li key={item.key} className="site-list-row">
                    {icon(item.icon, 'site-icon site-list-icon')}
                    <span>
                      {t(`landing.features.${group}.${item.key}`)}
                      {item.telegram ? <> {tag}</> : null}
                      {planTag(item.plan) ? <> {planTag(item.plan)}</> : null}
                    </span>
                  </li>
                ))}
              </ul>
              {group === 'reminders' ? <ReminderPing t={t} /> : null}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Telegram or WhatsApp (copy deck §2.4): each row's Telegram and WhatsApp cells, a word of their own or Yes or No. */
const CHANNEL_ROWS: { key: string; telegram: 'text' | 'yes'; whatsapp: 'text' | 'yes' | 'no' }[] = [
  { key: 'summaries', telegram: 'text', whatsapp: 'text' },
  { key: 'show', telegram: 'text', whatsapp: 'text' },
  { key: 'onRequest', telegram: 'yes', whatsapp: 'yes' },
  { key: 'voice', telegram: 'text', whatsapp: 'text' },
  { key: 'photo', telegram: 'yes', whatsapp: 'no' },
  { key: 'reminders', telegram: 'text', whatsapp: 'no' },
  { key: 'calendar', telegram: 'text', whatsapp: 'text' },
  { key: 'partner', telegram: 'yes', whatsapp: 'yes' },
  { key: 'pause', telegram: 'yes', whatsapp: 'yes' },
  { key: 'pay', telegram: 'text', whatsapp: 'no' },
];

export function Channels({ t }: { t: Translate }) {
  const cell = (row: string, channel: 'telegram' | 'whatsapp', kind: 'text' | 'yes' | 'no') => {
    if (kind === 'no') {
      return (
        <span className="site-cell site-cell-no">
          {icon(Minus)}
          {t('landing.channels.no')}
        </span>
      );
    }
    return (
      <span className="site-cell">
        {icon(Check, 'site-icon site-cell-yes')}
        {kind === 'yes' ? t('landing.channels.yes') : t(`landing.channels.rows.${row}.${channel}`)}
      </span>
    );
  };
  const telegram = t('landing.channels.colTelegram');
  const whatsapp = t('landing.channels.colWhatsapp');
  return (
    <section className="site-section" aria-labelledby="channels-title">
      <div className="site-wrap">
        <h2 id="channels-title" className="site-h2">
          {t('landing.channels.title')}
        </h2>
        <p className="site-lead">{t('landing.channels.intro')}</p>
        <table className="site-table" role="table">
          <thead>
            <tr role="row">
              <td role="presentation" />
              <th scope="col" role="columnheader">
                {telegram}
              </th>
              <th scope="col" role="columnheader">
                {whatsapp}
              </th>
            </tr>
          </thead>
          <tbody>
            {CHANNEL_ROWS.map((row) => (
              <tr key={row.key} role="row">
                <th scope="row" role="rowheader">
                  {t(`landing.channels.rows.${row.key}.label`)}
                </th>
                <td role="cell" data-channel={telegram}>
                  {cell(row.key, 'telegram', row.telegram)}
                </td>
                <td role="cell" data-channel={whatsapp}>
                  {cell(row.key, 'whatsapp', row.whatsapp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="site-note">
          {icon(Link2)}
          <span>{t('landing.channels.link')}</span>
        </p>
      </div>
    </section>
  );
}

export function Plans({ t, locale }: { t: Translate; locale: string }) {
  const cards = planCards(t);
  const seller = sellerView(locale);
  return (
    <section id="plans" className="site-section site-band" aria-labelledby="plans-title">
      <div className="site-wrap">
        <h2 id="plans-title" className="site-h2">
          {t('landing.plans.title')}
        </h2>
        <p className="site-lead">{t('landing.plans.subtitle', { days: TRIAL_DURATION_DAYS })}</p>
        <ul className="site-plans">
          {cards.map((card) => (
            <li key={card.id} className={card.top ? 'site-plan is-top' : 'site-plan'} aria-labelledby={`plan-${card.id}`}>
              <h3 id={`plan-${card.id}`} className="site-plan-name">
                {card.name}
              </h3>
              {card.priceA11y ? (
                <p className="site-plan-price">
                  <span aria-hidden="true">{card.price}</span>
                  <span className="ch-visually-hidden">{card.priceA11y}</span>
                </p>
              ) : (
                <p className="site-plan-price">{card.price}</p>
              )}
              <ul className="site-plan-bullets">
                {card.bullets.map((bullet) => (
                  <li key={bullet}>
                    {icon(Check, 'site-icon site-plan-check')}
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <p className="site-plans-all">{t('landing.plans.allPlans')}</p>
        <ul className="site-plan-notes">
          {[t('landing.plans.notes.trial', { days: TRIAL_DURATION_DAYS }), t('landing.plans.notes.monthly'), t('landing.plans.notes.stars')].map((note) => (
            <li key={note}>
              {icon(Info)}
              <span>{note}</span>
            </li>
          ))}
        </ul>
        <div className="site-cancel">
          <Link className="site-cancel-link" href={{ pathname: '/terms', hash: 'cancel' }}>
            {t('landing.plans.cancel.link')}
          </Link>
          <ul className="site-cancel-ways">
            {(['bot', 'email', 'post', 'phone'] as const).map((way) => (
              <li key={way}>
                <LegalInline text={String(t.raw(`landing.plans.cancel.${way}`))} seller={seller} missing={t('legal.sellerMissing')} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function Founder({ t }: { t: Translate }) {
  return (
    <section className="site-section" aria-labelledby="founder-title">
      <div className="site-wrap">
        <h2 id="founder-title" className="site-h2">
          {t('landing.founder.title')}
        </h2>
        <figure className="site-founder">
          <blockquote>
            <p>{t('landing.founder.quote')}</p>
          </blockquote>
          <figcaption>{t('landing.founder.author')}</figcaption>
        </figure>
        <p className="site-more">
          <Link href="/blog/why-i-built-famcal">{t('landing.founder.readMore')}</Link>
        </p>
      </div>
    </section>
  );
}

export function StartAgain({ t, words }: { t: Translate; words: StartWords }) {
  return (
    <section id="start" className="site-section site-final" aria-labelledby="start-title">
      <div className="site-wrap">
        <h2 id="start-title" className="site-h2">
          {t('landing.final.title')}
        </h2>
        <p className="site-lead">{t('landing.final.body')}</p>
        <StartButtons words={words} />
        <HonestLine text={t('site.cta.honest')} />
      </div>
    </section>
  );
}
