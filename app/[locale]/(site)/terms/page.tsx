import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { LegalPage } from '@/components/site/LegalPage';

// The terms page (spec 2026-10-28-public-website §7): its text in messages (legal.terms), drawn by LegalPage. Static per locale.

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('site.meta.terms.title'), description: t('site.meta.terms.description') };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LegalPage locale={locale} doc="terms" />;
}
