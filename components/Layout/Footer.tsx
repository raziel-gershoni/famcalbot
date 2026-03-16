import Link from 'next/link';
import Image from 'next/image';

interface FooterProps {
  locale: string;
  tagline: string;
  privacy: string;
  terms: string;
  contact: string;
  madeIn: string;
  copyright: string;
}

export default function Footer({
  locale,
  tagline,
  privacy,
  terms,
  contact,
  madeIn,
  copyright,
}: FooterProps) {
  return (
    <footer className="bg-text-primary px-6 py-12 text-white">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex flex-col items-center justify-between gap-8 sm:flex-row">
          <div className="flex items-center gap-3">
            <Image src="/icon.png" alt="FamCal" width={28} height={28} />
            <div>
              <span className="font-semibold">FamCal</span>
              <p className="text-sm text-white/60">{tagline}</p>
            </div>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link href={`/${locale}/privacy`} className="text-white/60 transition-colors hover:text-white">
              {privacy}
            </Link>
            <Link href={`/${locale}/terms`} className="text-white/60 transition-colors hover:text-white">
              {terms}
            </Link>
            <a
              href="https://t.me/family_calendar_telegram_bot?start=feedback"
              className="text-white/60 transition-colors hover:text-white"
            >
              {contact}
            </a>
          </nav>
        </div>
        <div className="flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
          <nav className="flex items-center gap-2 text-sm">
            {(['en', 'he', 'ru'] as const).map((loc) => (
              <Link
                key={loc}
                href={`/${loc}`}
                className={`rounded px-2 py-1 transition-colors ${
                  locale === loc ? 'text-white' : 'text-white/40 hover:text-white/70'
                }`}
              >
                {loc === 'en' ? 'English' : loc === 'he' ? 'עברית' : 'Русский'}
              </Link>
            ))}
          </nav>
          <div className="text-center text-sm text-white/40">
            <p>{madeIn}</p>
            <p>{copyright}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
