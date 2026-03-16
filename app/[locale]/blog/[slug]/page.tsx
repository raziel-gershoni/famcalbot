import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import SiteHeader from '@/components/Layout/SiteHeader';
import SiteFooter from '@/components/Layout/Footer';
import { getPostBySlug, getAllSlugs } from '@/src/lib/blog';

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

const BOT_URL = 'https://t.me/family_calendar_telegram_bot';

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.123-2.678-1.799-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.015-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.442-.752-.244-1.349-.374-1.297-.789.027-.216.324-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.015 3.333-1.386 4.025-1.627 4.477-1.635.099-.002.321.023.465.141.121.099.154.232.17.325.015.093.034.306.019.472z" />
    </svg>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = getPostBySlug(slug, locale);
  if (!post) return {};

  return {
    title: post.title,
    description: post.description,
    openGraph: {
      type: 'article',
      title: post.title,
      description: post.description,
      images: post.coverImage ? [{ url: post.coverImage }] : undefined,
    },
  };
}

export function generateStaticParams() {
  const slugs = getAllSlugs();
  const locales = ['en', 'he', 'ru'];
  return slugs.flatMap((slug) => locales.map((locale) => ({ locale, slug })));
}

export default async function BlogPostPage({ params }: Props) {
  const { locale, slug } = await params;
  const post = getPostBySlug(slug, locale);
  if (!post) notFound();

  const t = await getTranslations({ locale, namespace: 'blog' });
  const tLanding = await getTranslations({ locale, namespace: 'landing' });

  return (
    <>
      <SiteHeader locale={locale} ctaText={tLanding('header.startFree')} />

      <main className="mx-auto max-w-3xl px-6 py-16">
        {/* Back link */}
        <Link
          href={`/${locale}/blog`}
          className="mb-8 inline-block text-sm font-medium text-brand-primary hover:underline"
        >
          {t('backToBlog')}
        </Link>

        {/* Title + author */}
        <h1 className="mb-3 text-3xl font-bold leading-tight text-text-primary sm:text-4xl">
          {post.title}
        </h1>
        <p className="mb-12 text-text-muted">
          {locale === 'he' ? `מאת ${post.author}` : locale === 'ru' ? `Автор: ${post.author}` : `by ${post.author}`}
        </p>

        {/* MDX content */}
        <article className="prose-famcal">
          <MDXRemote source={post.content} />
        </article>

        {/* CTA banner */}
        <div
          className="mt-16 rounded-2xl px-8 py-10 text-center text-white"
          style={{ background: 'var(--gradient-brand)' }}
        >
          <h3 className="mb-2 text-2xl font-bold">{t('tryFamcal')}</h3>
          <p className="mb-6 text-white/90">{t('ctaText')}</p>
          <a
            href={BOT_URL}
            className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 font-semibold text-brand-primary shadow-lg transition-transform hover:scale-105"
          >
            <TelegramIcon />
            {t('tryFamcal')}
          </a>
        </div>
      </main>

      <SiteFooter
        locale={locale}
        tagline={tLanding('footer.tagline')}
        privacy={tLanding('footer.privacy')}
        terms={tLanding('footer.terms')}
        contact={tLanding('footer.contact')}
        madeIn={tLanding('footer.madeIn')}
        copyright={tLanding('footer.copyright')}
      />
    </>
  );
}
