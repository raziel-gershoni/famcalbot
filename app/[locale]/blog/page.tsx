import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import SiteHeader from '@/components/Layout/SiteHeader';
import SiteFooter from '@/components/Layout/Footer';
import { getAllPosts } from '@/src/lib/blog';

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'blog' });

  return {
    title: t('pageTitle'),
    description: t('pageDescription'),
  };
}

export default async function BlogIndexPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'blog' });
  const tLanding = await getTranslations({ locale, namespace: 'landing' });
  const tNav = await getTranslations({ locale, namespace: 'nav' });
  const posts = getAllPosts(locale);

  const navLinks = [
    { href: `/${locale}/how-it-works`, label: tNav('howItWorks') },
    { href: `/${locale}/blog`, label: tNav('blog') },
  ];

  return (
    <>
      <SiteHeader locale={locale} ctaText={tLanding('header.startFree')} navLinks={navLinks} />

      <main className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="mb-12 text-center text-4xl font-bold text-text-primary">
          {t('pageTitle')}
        </h1>

        {posts.length === 0 ? (
          <p className="text-center text-text-muted">No posts yet.</p>
        ) : (
          <div className="grid gap-8 sm:grid-cols-2">
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/${locale}/blog/${post.slug}`}
                className="group overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-all hover:-translate-y-1 hover:shadow-md"
              >
                {post.coverImage ? (
                  <div className="relative aspect-[2/1] overflow-hidden">
                    <Image
                      src={post.coverImage}
                      alt={post.title}
                      fill
                      className="object-cover transition-transform group-hover:scale-105"
                    />
                  </div>
                ) : (
                  <div
                    className="aspect-[2/1]"
                    style={{ background: 'var(--gradient-brand)' }}
                  />
                )}
                <div className="p-5">
                  <h2 className="mb-2 text-xl font-semibold text-text-primary group-hover:text-brand-primary transition-colors">
                    {post.title}
                  </h2>
                  <p className="mb-4 text-sm leading-relaxed text-text-secondary line-clamp-2">
                    {post.description}
                  </p>
                  {post.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {post.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-bg-section px-3 py-1 text-xs text-text-muted"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
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
