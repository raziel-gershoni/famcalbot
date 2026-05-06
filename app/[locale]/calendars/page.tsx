import { notFound } from 'next/navigation';
import { getUserByTelegramId, getUserById } from '@/src/services/user-service';
import { normalizeLocale } from '@/src/utils/locale';
import { listVisibleCalendars } from '@/src/services/native-calendar/event-store';
import { AlertTriangle } from 'lucide-react';
import CalendarsClient from './CalendarsClient';

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

  const user = (await getUserByTelegramId(userId)) ?? (await getUserById(userId));
  if (!user) notFound();

  const userLocale = normalizeLocale(user.language);
  if (locale !== userLocale) {
    const { redirect } = await import('next/navigation');
    redirect(`/${userLocale}/calendars?user_id=${userId}`);
  }

  // Native-only page: GCal users keep using select-calendars/. We render an
  // explanation rather than redirecting because the page may be reachable via
  // a stale link.
  if (user.calendarSource !== 'NATIVE') {
    return (
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
    );
  }

  const calendars = await listVisibleCalendars(user.id, user.pairingId ?? null);

  // Serialize for the client component (Date → ISO).
  const initial = calendars.map((c) => ({
    rawId: c.id,
    name: c.name,
    color: c.color,
    labels: c.labels,
    privacy: c.privacy,
    ownerUserId: c.ownerUserId,
    isOwner: c.ownerUserId === user.id,
    personName: c.personName,
    personEnglishName: c.personEnglishName,
    personGender: c.personGender,
    rules: c.rules,
    createdAt: c.createdAt.toISOString(),
  }));

  return <CalendarsClient userId={userId} locale={userLocale} initialCalendars={initial} />;
}
