import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

// The locale-aware links (spec 2026-10-28-public-website §6.2). With localePrefix 'as-needed', English is unprefixed
// ("/blog") and Hebrew and Russian carry theirs ("/he/blog"), so no internal link points at a redirect. A Link with a
// `locale` prop (the language switcher) always carries the prefix, English's too ("/en/blog"): the proxy then stores
// the choice in the NEXT_LOCALE cookie and lands on the unprefixed page, so a browser that prefers another language
// is not sent back to it.
export const { Link, getPathname, redirect, permanentRedirect, usePathname, useRouter } = createNavigation(routing);
