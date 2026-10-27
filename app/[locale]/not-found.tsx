import { NotFoundCard } from '@/components/app-ui/StateCard';

// The 404 for a notFound() thrown under app/[locale] (PageGate's, the blog's, an invite's, and any
// path the catch-all beside this file hands to notFound()): the app's own card, in the page's
// language, with the way back to the calendar. A bad locale is thrown by the layout itself, and a
// path with a dot is outside the proxy's matcher: both still get Next's plain 404.
export default function NotFound() {
  return <NotFoundCard />;
}
