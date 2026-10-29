import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { Link } from '@/i18n/navigation';
import { getAllPosts } from '@/src/lib/blog';

// The blog's index (spec 2026-10-28-public-website §3.3): the posts in the visitor's language, each its title (the link)
// and its line, in the site's chrome. Static per locale.

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('site.meta.blog.title'), description: t('site.meta.blog.description') };
}

export default async function BlogIndexPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });
  const posts = getAllPosts(locale);
  return (
    <SitePage locale={locale} path="/blog">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <h1 className="site-h1 site-page-title">{t('blog.pageTitle')}</h1>
          <ul className="site-posts">
            {posts.map((post) => (
              <li key={post.slug} className="site-post-card">
                <h2 className="site-h3">
                  <Link href={`/blog/${post.slug}`}>{post.title}</Link>
                </h2>
                <p>{post.description}</p>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </SitePage>
  );
}
