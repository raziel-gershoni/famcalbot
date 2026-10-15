import { AlertTriangle } from 'lucide-react';
import PageGate from '../PageGate';
import { gateLinks } from '@/src/lib/gate-links';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function CalendarsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const sp = await searchParams;
  const userId = sp.user_id ? parseInt(sp.user_id) : null;

  if (!userId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-50 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center">
          <div className="mb-4 flex justify-center"><AlertTriangle size={48} className="text-amber-500" /></div>
          <h1 className="text-xl font-bold text-rose-600 mb-2">Missing user_id</h1>
        </div>
      </div>
    );
  }

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first.
  //
  // Native-only page: GCal users keep using select-calendars/. We render an
  // explanation rather than redirecting because the page may be reachable via
  // a stale link.
  return (
    <PageGate
      page="calendars"
      userId={userId}
      locale={locale}
      links={gateLinks()}
      notices={{
        notNative: (
          <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-50 p-6">
            <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center">
              <div className="mb-4 text-4xl">📅</div>
              <h1 className="text-xl font-bold text-gray-800 mb-2">
                {locale === 'he' ? 'דף זה ליומן הפנימי בלבד' : locale === 'ru' ? 'Эта страница только для внутреннего календаря' : 'This page is for the in-bot calendar'}
              </h1>
              <p className="text-gray-600 text-sm">
                {locale === 'he'
                  ? 'אתה מחובר ליומן Google. ניהול היומנים נעשה דרך דף "בחירת יומנים".'
                  : locale === 'ru'
                  ? 'Вы используете Google Calendar. Управление календарями — на странице «Выбор календарей».'
                  : 'You are using Google Calendar. Manage your calendars on the Select Calendars page.'}
              </p>
            </div>
          </div>
        ),
      }}
    />
  );
}
