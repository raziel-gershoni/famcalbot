import { notFound } from 'next/navigation';
import { getUserByTelegramId, getUserById } from '@/src/services/user-service';
import { normalizeLocale } from '@/src/utils/locale';
import { getActivePartner, getActiveInvite } from '@/src/services/pairing-service';
import { buildUrl } from '@/src/config/urls';
import { AlertTriangle } from 'lucide-react';
import PairClient from './PairClient';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function PairPage({ params, searchParams }: PageProps) {
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
    redirect(`/${userLocale}/pair?user_id=${userId}`);
  }

  if (user.calendarSource !== 'NATIVE') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-50 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center">
          <div className="mb-4 text-4xl">🤝</div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">
            {locale === 'he'
              ? 'חיבור פרטנר זמין רק ביומן הפנימי'
              : locale === 'ru'
              ? 'Привязка партнёра доступна только во внутреннем календаре'
              : 'Pairing is for the in-bot calendar only'}
          </h1>
          <p className="text-gray-600 text-sm">
            {locale === 'he'
              ? 'אתה מחובר ליומן Google. שיתוף יומנים מתבצע דרך Google Calendar עצמו.'
              : locale === 'ru'
              ? 'Вы используете Google Calendar — общий доступ управляется в самом Google Calendar.'
              : 'You are using Google Calendar. Use Google Calendar sharing instead.'}
          </p>
        </div>
      </div>
    );
  }

  const [partnerInfo, activeInvite] = await Promise.all([
    getActivePartner(user.id),
    getActiveInvite(user.id),
  ]);

  const inviteUrl = activeInvite ? buildUrl(`/${userLocale}/invite/${activeInvite.token}`) : null;

  return (
    <PairClient
      userId={userId}
      locale={userLocale}
      initial={{
        partner: partnerInfo
          ? {
              name: partnerInfo.partner.name,
              acceptedAt: partnerInfo.pairing.acceptedAt?.toISOString() ?? null,
            }
          : null,
        invite: activeInvite
          ? {
              token: activeInvite.token,
              url: inviteUrl!,
              expiresAt: activeInvite.expiresAt.toISOString(),
            }
          : null,
      }}
    />
  );
}
