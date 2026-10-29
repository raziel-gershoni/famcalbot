import { getTranslations } from 'next-intl/server';
import { intlLocale } from '@/src/lib/calendar-view/format';
import { LEGAL_UPDATED, type LegalDoc, type LegalItem, type LegalSection, type SellerArg } from '@/src/site/legal';
import { LegalInline, sellerView } from './LegalInline';
import { SitePage } from './SitePage';

// Privacy and Terms (spec 2026-10-28-public-website §7): the text lives in messages (legal.privacy, legal.terms), in
// each language; the page draws it in the site's chrome. A page is its title, its "last updated" date (LEGAL_UPDATED),
// then sections in the order messages give them, each with an id to link to, a heading, and blocks
// (src/site/legal.ts): a string is a paragraph, an array a bulleted list (an item may hold its own list, and
// paragraphs after it), and { title, id } a sub-heading. LegalInline draws each line's marks and the seller's details.

type Line = { seller: Record<SellerArg, string | null>; missing: string };

function Item({ item, line }: { item: LegalItem; line: Line }) {
  if (typeof item === 'string')
    return (
      <li>
        <LegalInline text={item} {...line} />
      </li>
    );
  return (
    <li>
      <LegalInline text={item.text} {...line} />
      <ul className="site-legal-list">
        {item.items.map((sub, i) => (
          <Item key={i} item={sub} line={line} />
        ))}
      </ul>
      {item.after?.map((text, i) => (
        <p key={i}>
          <LegalInline text={text} {...line} />
        </p>
      ))}
    </li>
  );
}

export async function LegalPage({ locale, doc }: { locale: string; doc: LegalDoc }) {
  const t = await getTranslations({ locale });
  const sections = t.raw(`legal.${doc}.sections`) as Record<string, LegalSection>;
  const line: Line = { seller: sellerView(locale), missing: t('legal.sellerMissing') };
  const updated = new Date(`${LEGAL_UPDATED[doc]}T12:00:00Z`).toLocaleDateString(intlLocale(locale), {
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
          {Object.entries(sections).map(([id, section]) => (
            <section key={id} id={id} className="site-legal-section" aria-labelledby={`${id}-title`}>
              <h2 id={`${id}-title`} className="site-h3">
                {section.heading}
              </h2>
              {section.blocks.map((block, i) => {
                if (typeof block === 'string')
                  return (
                    <p key={i}>
                      <LegalInline text={block} {...line} />
                    </p>
                  );
                if (Array.isArray(block))
                  return (
                    <ul key={i} className="site-legal-list">
                      {block.map((item, j) => (
                        <Item key={j} item={item} line={line} />
                      ))}
                    </ul>
                  );
                return (
                  <h3 key={i} id={block.id} className="site-legal-h3">
                    {block.title}
                  </h3>
                );
              })}
            </section>
          ))}
        </article>
      </main>
    </SitePage>
  );
}
