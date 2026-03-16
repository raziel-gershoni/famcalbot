import Link from 'next/link';
import Image from 'next/image';

const BOT_URL = 'https://t.me/family_calendar_telegram_bot';

export default function SiteHeader({
  locale,
  ctaText,
}: {
  locale: string;
  ctaText: string;
}) {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-white/80 border-b border-gray-100">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
        <Link href={`/${locale}`} className="flex items-center gap-2">
          <Image src="/icon.png" alt="FamCal" width={32} height={32} />
          <span className="text-lg font-semibold text-text-primary">FamCal</span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-4">
          <nav className="hidden sm:flex items-center gap-1 text-sm">
            {(['en', 'he', 'ru'] as const).map((loc) => (
              <Link
                key={loc}
                href={`/${loc}`}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  locale === loc
                    ? 'bg-brand-primary text-white'
                    : 'text-text-secondary hover:bg-gray-100'
                }`}
              >
                {loc === 'en' ? 'EN' : loc === 'he' ? 'עב' : 'РУ'}
              </Link>
            ))}
          </nav>
          <a
            href={BOT_URL}
            className="rounded-full px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: 'var(--gradient-brand)' }}
          >
            {ctaText}
          </a>
        </div>
      </div>
    </header>
  );
}
