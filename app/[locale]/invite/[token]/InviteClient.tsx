'use client';

// Client-side invite landing.
//
// Three states:
//  1. Inside Telegram WebApp → one-tap accept via /api/pair/accept (uses initData)
//  2. Outside any app → "Open in Telegram" + "Open in WhatsApp" deep links
//  3. After successful accept → confirmation screen
//
// We intentionally keep this minimal: no design library, just Tailwind, matching
// the rest of the miniapp's plain-but-polished aesthetic.

import { useEffect, useState } from 'react';

interface Props {
  token: string;
  inviterName: string;
  locale: string;
  tgDeepLink: string;
  waDeepLink: string;
  expiresAt: string;
}

// Window.Telegram.WebApp is already typed in src/types/telegram-webapp.d.ts

type AcceptState = 'idle' | 'pending' | 'success' | 'error';

const COPY: Record<string, Record<string, string>> = {
  en: {
    title: 'Pair with {name}?',
    subtitle: 'You will share calendars between your accounts. Each calendar can be marked private later.',
    accept: 'Accept invite',
    accepting: 'Pairing…',
    success: 'You are now paired with {name}.',
    closeApp: 'Close',
    notInApp: 'Open in your bot to accept:',
    openTg: 'Open in Telegram',
    openWa: 'Open in WhatsApp',
    expires: 'Link expires {when}',
    errorGeneric: 'Could not accept the invite. Try the bot directly.',
  },
  he: {
    title: 'להתחבר עם {name}?',
    subtitle: 'תוכלו לראות אחד את היומנים של השני. אפשר לסמן יומן ספציפי כפרטי בהמשך.',
    accept: 'אישור חיבור',
    accepting: 'מתחבר…',
    success: 'אתם מחוברים עכשיו עם {name}.',
    closeApp: 'סגירה',
    notInApp: 'לפתוח בבוט כדי לאשר:',
    openTg: 'לפתוח בטלגרם',
    openWa: 'לפתוח בוואטסאפ',
    expires: 'הקישור פג תוקף {when}',
    errorGeneric: 'לא הצלחנו להשלים את החיבור. נסה דרך הבוט.',
  },
  ru: {
    title: 'Связать с {name}?',
    subtitle: 'Календари будут видны обоим. Любой календарь можно сделать приватным позже.',
    accept: 'Принять приглашение',
    accepting: 'Соединяем…',
    success: 'Вы теперь связаны с {name}.',
    closeApp: 'Закрыть',
    notInApp: 'Открыть в боте, чтобы принять:',
    openTg: 'Открыть в Telegram',
    openWa: 'Открыть в WhatsApp',
    expires: 'Ссылка истекает {when}',
    errorGeneric: 'Не удалось принять приглашение. Попробуйте через бот.',
  },
};

function fmt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

export default function InviteClient(props: Props) {
  const { token, inviterName, locale, tgDeepLink, waDeepLink, expiresAt } = props;
  const t = COPY[locale] || COPY.en;
  const [state, setState] = useState<AcceptState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [tgUser, setTgUser] = useState<number | null>(null);
  const [tgInitData, setTgInitData] = useState<string | null>(null);

  useEffect(() => {
    // Detect TG WebApp environment
    const tg = window.Telegram?.WebApp;
    if (tg?.initData && tg.initDataUnsafe?.user?.id) {
      tg.ready?.();
      tg.expand?.();
      setTgInitData(tg.initData);
      setTgUser(tg.initDataUnsafe.user.id);
    }
  }, []);

  const accept = async () => {
    if (!tgUser || !tgInitData) return;
    setState('pending');
    setErrorMessage('');
    try {
      const res = await fetch(`/api/pair/accept?user_id=${tgUser}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, initData: tgInitData }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setState('error');
        setErrorMessage(mapError(data?.error, locale));
        return;
      }
      setState('success');
    } catch {
      setState('error');
      setErrorMessage(t.errorGeneric);
    }
  };

  const expiresWhen = new Date(expiresAt).toLocaleString(
    locale === 'he' ? 'he-IL' : locale === 'ru' ? 'ru-RU' : 'en-US',
    { dateStyle: 'medium', timeStyle: 'short' }
  );

  // Success state
  if (state === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-100 to-teal-100 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="text-6xl mb-4">🎉</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-3">{fmt(t.success, { name: inviterName })}</h1>
          <button
            onClick={() => window.Telegram?.WebApp?.close?.()}
            className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-emerald-700 transition-colors"
          >
            {t.closeApp}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-100 p-6">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="text-5xl mb-4">🤝</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">{fmt(t.title, { name: inviterName })}</h1>
          <p className="text-gray-600 text-sm">{t.subtitle}</p>
        </div>

        {state === 'error' && errorMessage && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-4 text-rose-700 text-sm">
            {errorMessage}
          </div>
        )}

        {tgUser ? (
          <button
            onClick={accept}
            disabled={state === 'pending'}
            className="w-full bg-blue-600 text-white py-4 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {state === 'pending' ? t.accepting : t.accept}
          </button>
        ) : (
          <div>
            <p className="text-gray-700 text-sm font-medium mb-3 text-center">{t.notInApp}</p>
            <div className="flex flex-col gap-2">
              {tgDeepLink && (
                <a
                  href={tgDeepLink}
                  className="block w-full bg-sky-500 text-white py-3 rounded-xl font-medium text-center hover:bg-sky-600 transition-colors"
                >
                  {t.openTg}
                </a>
              )}
              {waDeepLink && (
                <a
                  href={waDeepLink}
                  className="block w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-center hover:bg-emerald-600 transition-colors"
                >
                  {t.openWa}
                </a>
              )}
            </div>
          </div>
        )}

        <p className="text-xs text-gray-400 text-center mt-6">{fmt(t.expires, { when: expiresWhen })}</p>
      </div>
    </div>
  );
}

function mapError(code: string | undefined, locale: string): string {
  const t = COPY[locale] || COPY.en;
  if (!code) return t.errorGeneric;
  const map: Record<string, Record<string, string>> = {
    en: {
      INVITE_NOT_FOUND: 'This invite link is not valid.',
      INVITE_EXPIRED: 'This invite has expired.',
      INVITE_ALREADY_USED: 'This invite was already used.',
      INVITE_REVOKED: 'This invite was revoked.',
      CANNOT_ACCEPT_OWN_INVITE: 'You cannot accept your own invite.',
      INVITER_NOT_NATIVE: 'The inviter is on Google Calendar — pairing only works for the in-bot calendar.',
      INVITEE_NOT_NATIVE: 'You are using Google Calendar. Pairing only works with the in-bot calendar.',
      INVITER_ALREADY_PAIRED: 'The inviter is already paired with someone else.',
      INVITEE_ALREADY_PAIRED: 'You are already paired. Unlink first.',
    },
    he: {
      INVITE_NOT_FOUND: 'הקישור לא תקף.',
      INVITE_EXPIRED: 'הקישור פג תוקף.',
      INVITE_ALREADY_USED: 'הקישור כבר שומש.',
      INVITE_REVOKED: 'הקישור בוטל.',
      CANNOT_ACCEPT_OWN_INVITE: 'אי אפשר לאשר הזמנה של עצמך.',
      INVITER_NOT_NATIVE: 'השולח/ת ביומן גוגל — חיבור עובד רק עם היומן בתוך הבוט.',
      INVITEE_NOT_NATIVE: 'את/ה ביומן גוגל. חיבור עובד רק עם היומן בתוך הבוט.',
      INVITER_ALREADY_PAIRED: 'השולח/ת כבר מחובר/ת עם מישהו אחר.',
      INVITEE_ALREADY_PAIRED: 'את/ה כבר מחובר/ת. בטלו את החיבור הקיים קודם.',
    },
    ru: {
      INVITE_NOT_FOUND: 'Ссылка недействительна.',
      INVITE_EXPIRED: 'Ссылка истекла.',
      INVITE_ALREADY_USED: 'Ссылка уже использована.',
      INVITE_REVOKED: 'Ссылка отменена.',
      CANNOT_ACCEPT_OWN_INVITE: 'Нельзя принять собственное приглашение.',
      INVITER_NOT_NATIVE: 'Отправитель использует Google Calendar — привязка работает только с внутренним календарём.',
      INVITEE_NOT_NATIVE: 'Вы на Google Calendar. Привязка работает только с внутренним календарём.',
      INVITER_ALREADY_PAIRED: 'Отправитель уже связан с кем-то другим.',
      INVITEE_ALREADY_PAIRED: 'Вы уже связаны. Сначала отмените существующую связь.',
    },
  };
  const m = map[locale] || map.en;
  return m[code] || t.errorGeneric;
}
