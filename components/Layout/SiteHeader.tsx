import Link from 'next/link';
import Image from 'next/image';

const TG_BOT_URL = 'https://t.me/family_calendar_telegram_bot';

interface NavLink {
  href: string;
  label: string;
}

export default function SiteHeader({
  locale,
  ctaText,
  navLinks,
  waUrl,
}: {
  locale: string;
  ctaText: string;
  navLinks?: NavLink[];
  waUrl?: string;
}) {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-white/80 border-b border-gray-100">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href={`/${locale}`} className="flex items-center gap-2">
            <Image src="/icon.png" alt="FamCal" width={32} height={32} />
            <span className="text-lg font-semibold text-text-primary">FamCal</span>
          </Link>
          {navLinks && navLinks.length > 0 && (
            <nav className="hidden md:flex items-center gap-4 text-sm">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-text-secondary transition-colors hover:text-text-primary"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
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
          <span className="hidden sm:inline text-sm font-medium text-text-secondary">{ctaText}</span>
          <div className="flex items-center gap-1.5">
            <a
              href={TG_BOT_URL}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-telegram text-white transition-opacity hover:opacity-90"
              title="Telegram"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.123-2.678-1.799-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.015-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.442-.752-.244-1.349-.374-1.297-.789.027-.216.324-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.015 3.333-1.386 4.025-1.627 4.477-1.635.099-.002.321.023.465.141.121.099.154.232.17.325.015.093.034.306.019.472z" />
              </svg>
            </a>
            {waUrl && (
              <a
                href={waUrl}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-whatsapp text-white transition-opacity hover:opacity-90"
                title="WhatsApp"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                </svg>
              </a>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
