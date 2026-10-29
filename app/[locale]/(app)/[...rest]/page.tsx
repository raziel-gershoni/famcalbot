import { notFound } from 'next/navigation';

// Any path under a locale that no page claims lands here, so it gets the app's 404
// (app/[locale]/(app)/not-found.tsx) and not Next's plain one.
export default function UnknownPath() {
  notFound();
}
