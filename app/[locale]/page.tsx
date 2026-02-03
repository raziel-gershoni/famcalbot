import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import Link from 'next/link';
import { RotatingHeadline } from './LandingClient';

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'landing' });

  const baseUrl = 'https://famcal.bot';

  return {
    title: t('meta.title'),
    description: t('meta.description'),
    openGraph: {
      title: t('meta.ogTitle'),
      description: t('meta.ogDescription'),
      type: 'website',
      images: [{ url: `${baseUrl}/og-image.png` }],
    },
    alternates: {
      canonical: locale === 'en' ? baseUrl : `${baseUrl}/${locale}`,
      languages: {
        en: baseUrl,
        he: `${baseUrl}/he`,
        ru: `${baseUrl}/ru`,
        'x-default': baseUrl,
      },
    },
  };
}

// Telegram SVG icon component
function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 24, height: 24 }}>
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.123-2.678-1.799-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.015-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.442-.752-.244-1.349-.374-1.297-.789.027-.216.324-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.015 3.333-1.386 4.025-1.627 4.477-1.635.099-.002.321.023.465.141.121.099.154.232.17.325.015.093.034.306.019.472z" />
    </svg>
  );
}

export default async function LandingPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'landing' });

  const headlines = t.raw('headlines') as string[];

  const features = [
    { key: 'voiceSummaries', icon: '🎙️' },
    { key: 'voiceCommands', icon: '🗣️' },
    { key: 'aiSummaries', icon: '🤖' },
    { key: 'multiCalendar', icon: '👨‍👩‍👧‍👦' },
    { key: 'conflictDetection', icon: '⚠️' },
    { key: 'weather', icon: '🌤️' },
    { key: 'reminders', icon: '⏰' },
    { key: 'hebrewCalendar', icon: '🕎' },
    { key: 'multiLanguage', icon: '🌍' },
  ] as const;

  const botUrl = 'https://t.me/family_calendar_telegram_bot';
  const feedbackUrl = 'https://t.me/family_calendar_telegram_bot?start=feedback';

  return (
    <>
      <style>{`
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        :root {
          --telegram-blue: #0088cc;
          --telegram-blue-dark: #006699;
          --text-primary: #1a1a1a;
          --text-secondary: #666;
          --bg-light: #f8f9fa;
          --accent: #0088cc;
        }

        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          color: var(--text-primary);
          line-height: 1.6;
        }

        [dir="rtl"] body {
          font-family: 'Heebo', -apple-system, BlinkMacSystemFont, sans-serif;
          line-height: 1.7;
        }

        .header {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          padding: 1rem 2rem;
          display: flex;
          justify-content: flex-end;
          z-index: 100;
        }

        .lang-switcher {
          display: flex;
          gap: 0.5rem;
        }

        .lang-switcher a {
          color: var(--text-secondary);
          text-decoration: none;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.9rem;
          transition: background 0.2s, color 0.2s;
        }

        .lang-switcher a:hover {
          background: rgba(0,0,0,0.05);
          color: var(--text-primary);
        }

        .lang-switcher a.active {
          background: var(--telegram-blue);
          color: white;
        }

        .hero {
          min-height: 90vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          text-align: center;
          padding: 2rem;
          background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
        }

        .hero-badge {
          background: var(--telegram-blue);
          color: white;
          padding: 0.5rem 1rem;
          border-radius: 50px;
          font-size: 0.85rem;
          font-weight: 500;
          margin-bottom: 1.5rem;
        }

        .hero h1 {
          font-size: clamp(2rem, 5vw, 3.5rem);
          font-weight: 700;
          margin-bottom: 1rem;
          max-width: 700px;
          min-height: 2.5em;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        [dir="rtl"] .hero h1 {
          font-size: clamp(1.8rem, 5vw, 3rem);
        }

        .hero .subtitle {
          font-size: 1.25rem;
          color: var(--text-secondary);
          max-width: 500px;
          margin-bottom: 2rem;
        }

        [dir="rtl"] .hero .subtitle {
          font-size: 1.2rem;
          max-width: 550px;
        }

        .cta-group {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          align-items: center;
        }

        .cta-button {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          background: var(--telegram-blue);
          color: white;
          padding: 1rem 2rem;
          border-radius: 8px;
          text-decoration: none;
          font-weight: 600;
          font-size: 1.1rem;
          transition: background 0.2s, transform 0.2s;
        }

        .cta-button:hover {
          background: var(--telegram-blue-dark);
          transform: translateY(-2px);
        }

        .cta-secondary {
          color: var(--text-secondary);
          font-size: 0.9rem;
        }

        .features {
          padding: 5rem 2rem;
          background: var(--bg-light);
        }

        .features-grid {
          max-width: 1000px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 2rem;
        }

        .feature-card {
          background: white;
          padding: 2rem;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.06);
          text-align: start;
        }

        .feature-icon {
          font-size: 2rem;
          margin-bottom: 1rem;
        }

        .feature-card h3 {
          font-size: 1.2rem;
          margin-bottom: 0.5rem;
        }

        .feature-card p {
          color: var(--text-secondary);
          font-size: 0.95rem;
        }

        .how-it-works {
          padding: 5rem 2rem;
          background: white;
          text-align: center;
        }

        .how-it-works h2 {
          font-size: 2rem;
          margin-bottom: 3rem;
        }

        .steps {
          max-width: 800px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }

        .step {
          display: flex;
          align-items: flex-start;
          gap: 1.5rem;
          text-align: start;
        }

        .step-number {
          background: var(--telegram-blue);
          color: white;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          flex-shrink: 0;
        }

        .step-content h3 {
          font-size: 1.1rem;
          margin-bottom: 0.25rem;
        }

        .step-content p {
          color: var(--text-secondary);
        }

        .pricing {
          padding: 5rem 2rem;
          background: var(--bg-light);
          text-align: center;
        }

        .pricing h2 {
          font-size: 2rem;
          margin-bottom: 1rem;
        }

        .pricing .subtitle {
          color: var(--text-secondary);
          margin-bottom: 3rem;
        }

        .pricing-grid {
          max-width: 900px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1.5rem;
          align-items: start;
        }

        .pricing-card {
          background: white;
          border-radius: 16px;
          padding: 2rem 1.5rem;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
        }

        .pricing-card.featured {
          border: 2px solid var(--telegram-blue);
          transform: scale(1.05);
          position: relative;
        }

        .pricing-card h3 {
          font-size: 1.3rem;
          margin-bottom: 0.5rem;
        }

        .pricing-badge {
          background: #ffeaa7;
          color: #6c5c00;
          padding: 0.25rem 0.75rem;
          border-radius: 50px;
          font-size: 0.8rem;
          font-weight: 600;
          display: inline-block;
          margin-bottom: 1rem;
        }

        .price {
          font-size: 2.5rem;
          font-weight: 700;
        }

        .price-period {
          color: var(--text-secondary);
          font-size: 1rem;
        }

        .pricing-features {
          list-style: none;
          margin: 2rem 0;
          text-align: start;
        }

        .pricing-features li {
          padding: 0.5rem 0;
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .pricing-features li::before {
          content: "✓";
          color: #27ae60;
          font-weight: bold;
        }

        .pricing-card .cta-button {
          width: 100%;
          justify-content: center;
          margin-top: 1rem;
        }

        .cta-secondary-btn {
          background: white;
          color: var(--telegram-blue);
          border: 2px solid var(--telegram-blue);
        }

        .cta-secondary-btn:hover {
          background: var(--bg-light);
        }

        .pricing-note {
          margin-top: 2rem;
          color: var(--text-secondary);
          font-size: 0.95rem;
        }

        .personal-note {
          padding: 4rem 2rem;
          background: white;
          text-align: center;
        }

        .personal-note-content {
          max-width: 600px;
          margin: 0 auto;
          font-size: 1.1rem;
          color: var(--text-secondary);
        }

        .personal-note-content strong {
          color: var(--text-primary);
        }

        footer {
          padding: 2rem;
          text-align: center;
          background: var(--text-primary);
          color: white;
        }

        footer a {
          color: #88c8e8;
        }

        @media (max-width: 600px) {
          .hero {
            min-height: auto;
            padding: 4rem 1.5rem;
          }

          .step {
            flex-direction: column;
            text-align: center;
            align-items: center;
          }

          .pricing-card.featured {
            transform: none;
          }
        }
      `}</style>

      {/* Header with language switcher */}
      <header className="header">
        <nav className="lang-switcher">
          <Link href="/en" className={locale === 'en' ? 'active' : ''}>
            EN
          </Link>
          <Link href="/he" className={locale === 'he' ? 'active' : ''}>
            עב
          </Link>
          <Link href="/ru" className={locale === 'ru' ? 'active' : ''}>
            RU
          </Link>
        </nav>
      </header>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-badge">📱 {t('hero.badge')}</div>
        <h1>
          <RotatingHeadline headlines={headlines} />
        </h1>
        <p className="subtitle">{t('hero.subtitle')}</p>
        <div className="cta-group">
          <a href={botUrl} className="cta-button">
            <TelegramIcon />
            {t('hero.cta')}
          </a>
          <p className="cta-secondary">{t('hero.ctaSecondary')}</p>
        </div>
      </section>

      {/* Features Section */}
      <section className="features">
        <div className="features-grid">
          {features.map(({ key, icon }) => (
            <div key={key} className="feature-card">
              <div className="feature-icon">{icon}</div>
              <h3>{t(`features.${key}.title`)}</h3>
              <p>{t(`features.${key}.description`)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it Works Section */}
      <section className="how-it-works">
        <h2>{t('howItWorks.title')}</h2>
        <div className="steps">
          {[1, 2, 3].map((num) => (
            <div key={num} className="step">
              <div className="step-number">{num}</div>
              <div className="step-content">
                <h3>{t(`howItWorks.step${num}.title`)}</h3>
                <p>{t(`howItWorks.step${num}.description`)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing Section */}
      <section className="pricing">
        <h2>{t('pricing.title')}</h2>
        <p className="subtitle">{t('pricing.subtitle')}</p>
        <div className="pricing-grid">
          {/* Free Plan */}
          <div className="pricing-card">
            <h3>{t('pricing.free.name')}</h3>
            <div className="price">{t('pricing.free.price')}</div>
            <ul className="pricing-features">
              {(t.raw('pricing.free.features') as string[]).map((feature, i) => (
                <li key={i}>{feature}</li>
              ))}
            </ul>
            <a href={botUrl} className="cta-button cta-secondary-btn">
              {t('pricing.free.cta')}
            </a>
          </div>

          {/* Basic Plan (Featured) */}
          <div className="pricing-card featured">
            <div className="pricing-badge">{t('pricing.basic.badge')}</div>
            <h3>{t('pricing.basic.name')}</h3>
            <div className="price">
              {t('pricing.basic.price')}
              <span className="price-period">{t('pricing.basic.period')}</span>
            </div>
            <ul className="pricing-features">
              {(t.raw('pricing.basic.features') as string[]).map((feature, i) => (
                <li key={i}>{feature}</li>
              ))}
            </ul>
            <a href={botUrl} className="cta-button">
              {t('pricing.basic.cta')}
            </a>
          </div>

          {/* Pro Plan */}
          <div className="pricing-card">
            <h3>{t('pricing.pro.name')}</h3>
            <div className="price">
              {t('pricing.pro.price')}
              <span className="price-period">{t('pricing.pro.period')}</span>
            </div>
            <ul className="pricing-features">
              {(t.raw('pricing.pro.features') as string[]).map((feature, i) => (
                <li key={i}>{feature}</li>
              ))}
            </ul>
            <a href={botUrl} className="cta-button cta-secondary-btn">
              {t('pricing.pro.cta')}
            </a>
          </div>
        </div>
        <p className="pricing-note">{t('pricing.note')}</p>
      </section>

      {/* Personal Note Section */}
      <section className="personal-note">
        <div className="personal-note-content">
          <p>
            <strong>{t('personalNote.text').split('.')[0]}.</strong>
            {t('personalNote.text').split('.').slice(1).join('.')}
          </p>
          <p style={{ marginTop: '1rem' }}>
            {t('personalNote.feedback').replace(
              '{link}',
              ''
            )}
            <a href={feedbackUrl}>{t('personalNote.feedbackLink')}</a>
            {t('personalNote.feedback').split('{link}')[1]}
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer>
        <p>{t('footer.copyright')}</p>
      </footer>
    </>
  );
}
