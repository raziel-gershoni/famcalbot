import { NotFoundCard } from '@/components/app-ui/StateCard';

// The 404 for a notFound() thrown under the Mini App's root layout, app/[locale]/(app) (PageGate's,
// Subscription's, and any path under a locale that no page claims: the catch-all beside this file hands
// it to notFound()): the app's own card, in the page's language,
// with the way back to the calendar. Limits: a bad locale is thrown by the layout itself and gets Next's
// plain 404; a dotted path under a locale prefix (/he/foo.png) is outside the proxy's matcher, so the
// request has no locale and the app's card is in English.
export default function NotFound() {
  return <NotFoundCard />;
}
