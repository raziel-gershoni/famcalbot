import { getTranslations } from 'next-intl/server';
import { LEGAL_UPDATED, linkParts, type LegalDoc, type LegalSection } from '@/src/site/legal';
import { SitePage } from './SitePage';

// Privacy and Terms (spec 2026-10-28-public-website §7): the text lives in messages (legal.privacy, legal.terms), in
// each language; the page draws it in the site's chrome. A page is its title, its "last updated" date (LEGAL_UPDATED),
// an opening paragraph, then sections in the order messages give them, each with an id to link to, a heading, and
// blocks: a string is a paragraph, a list of strings a bulleted list. Web and email addresses in the text are links.

function Linked({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((part, i) =>
        part.href ? (
          <a key={i} href={part.href} dir="ltr">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

export async function LegalPage({ locale, doc }: { locale: string; doc: LegalDoc }) {
  const t = await getTranslations({ locale });
  const sections = t.raw(`legal.${doc}.sections`) as Record<string, LegalSection>;
  const updated = new Date(`${LEGAL_UPDATED[doc]}T12:00:00Z`).toLocaleDateString(locale === 'he' ? 'he-IL' : locale === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <SitePage locale={locale} path={`/${doc}`}>
      <main id="main" className="site-section site-page-main">
        <article className="site-wrap site-narrow site-legal">
          <h1 className="site-h1 site-page-title">{t(`site.meta.${doc}.title`)}</h1>
          <p className="site-byline">{t('legal.lastUpdated', { date: updated })}</p>
          <p className="site-legal-intro">
            <Linked text={String(t.raw(`legal.${doc}.intro`))} />
          </p>
          {Object.entries(sections).map(([id, section]) => (
            <section key={id} id={id} className="site-legal-section" aria-labelledby={`${id}-title`}>
              <h2 id={`${id}-title`} className="site-h3">
                {section.heading}
              </h2>
              {section.blocks.map((block, i) =>
                Array.isArray(block) ? (
                  <ul key={i} className="site-legal-list">
                    {block.map((item, j) => (
                      <li key={j}>
                        <Linked text={item} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p key={i}>
                    <Linked text={block} />
                  </p>
                ),
              )}
            </section>
          ))}
        </article>
      </main>
    </SitePage>
  );
}
