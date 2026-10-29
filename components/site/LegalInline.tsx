import { Link } from '@/i18n/navigation';
import { SELLER, type SellerLocale } from '@/src/lib/seller';
import { inlineParts, type SellerArg } from '@/src/site/legal';

// One line of the legal text as the page draws it (src/site/legal.ts, inlineParts): **bold** as <strong>, `code` as
// <code>, a marked link ([words](/privacy)) to the site's page in the page's language or to its web address, web and
// email addresses as links, bot commands (/paysupport) and @handles as plain text kept left to right, and the seller's
// details (src/lib/seller.ts) filled in. Whatever reads left to right inside Hebrew (an address, a command, a handle, a
// phone number) is isolated, so its slash, its @ or its digits never jump. A detail the owner hasn't given yet reads
// `missing`.

/** The seller's details for one page: the name in its language, the rest as they are (null: not given yet). */
export function sellerView(locale: string): Record<SellerArg, string | null> {
  const lang = (['en', 'he', 'ru'].includes(locale) ? locale : 'en') as SellerLocale;
  return { sellerName: SELLER.name[lang], idNumber: SELLER.idNumber, postalAddress: SELLER.postalAddress, phone: SELLER.phone, email: SELLER.email };
}

function Arg({ name, seller, missing }: { name: SellerArg; seller: Record<SellerArg, string | null>; missing: string }) {
  const value = seller[name]?.trim();
  if (!value) return <span className="site-legal-missing">{missing}</span>;
  if (name === 'sellerName') return <>{value}</>;
  if (name === 'email')
    return (
      <a href={`mailto:${value}`} dir="ltr">
        {value}
      </a>
    );
  if (name === 'phone')
    return (
      <a href={`tel:${value.replace(/[^\d+]/g, '')}`} dir="ltr">
        {value}
      </a>
    );
  return <bdi>{value}</bdi>;
}

export function LegalInline({ text, seller, missing }: { text: string; seller: Record<SellerArg, string | null>; missing: string }) {
  return (
    <>
      {inlineParts(text).map((part, i) => {
        switch (part.kind) {
          case 'strong':
            return <strong key={i}>{part.text}</strong>;
          case 'code':
            return (
              <code key={i} dir="ltr">
                {part.text}
              </code>
            );
          case 'command':
          case 'handle':
            return (
              <bdi key={i} dir="ltr">
                {part.text}
              </bdi>
            );
          case 'arg':
            return <Arg key={i} name={part.name} seller={seller} missing={missing} />;
          case 'link':
            if (part.href.startsWith('/'))
              return (
                <Link key={i} href={part.href}>
                  {part.text}
                </Link>
              );
            return (
              <a key={i} href={part.href} dir={part.address ? 'ltr' : undefined}>
                {part.text}
              </a>
            );
          default:
            return part.text;
        }
      })}
    </>
  );
}
