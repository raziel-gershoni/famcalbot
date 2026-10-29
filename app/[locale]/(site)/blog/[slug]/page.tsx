import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MDXRemote } from 'next-mdx-remote/rsc';
import { SitePage } from '@/components/site/SitePage';
import { HonestLine, StartButtons, startWords } from '@/components/site/StartButtons';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { getAllSlugs, getPostBySlug } from '@/src/lib/blog';

// A blog post (spec 2026-10-28-public-website §3.3): the post in the site's chrome, its type in the app's tokens
// (.site-article), and at its end the two start buttons with the honest line. Static per locale and post.

type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = getPostBySlug(slug, locale);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    openGraph: { type: 'article', title: post.title, description: post.description },
  };
}

export function generateStaticParams() {
  return getAllSlugs().flatMap((slug) => routing.locales.map((locale) => ({ locale, slug })));
}

export default async function BlogPostPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const post = getPostBySlug(slug, locale);
  if (!post) notFound();
  const t = await getTranslations({ locale });
  return (
    <SitePage locale={locale} path={`/blog/${slug}`}>
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <p className="site-back">
            <Link href="/blog">{t('blog.backToBlog')}</Link>
          </p>
          <h1 className="site-h1 site-page-title">{post.title}</h1>
          <p className="site-byline">{t('blog.byline', { author: post.author })}</p>
          <article className="site-article">
            <MDXRemote source={post.content} />
          </article>
          <aside className="site-cta" aria-labelledby="cta-title">
            <h2 id="cta-title" className="site-h3">
              {t('blog.tryFamcal')}
            </h2>
            <p className="site-cta-text">{t('blog.ctaText')}</p>
            <StartButtons words={startWords(t)} />
            <HonestLine text={t('site.cta.honest')} />
          </aside>
        </div>
      </main>
    </SitePage>
  );
}
