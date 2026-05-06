'use client';

// Pair management — generate / show / revoke invite, view active partner, unlink.

import { useState } from 'react';
import { Copy, Check, X, Link as LinkIcon, AlertTriangle } from 'lucide-react';

interface Props {
  userId: number;
  locale: string;
  initial: {
    partner: { name: string; acceptedAt: string | null } | null;
    invite: { token: string; url: string; expiresAt: string } | null;
  };
}

const COPY: Record<string, Record<string, string>> = {
  en: {
    title: 'Partner sharing',
    notPairedSubtitle: 'Pair with one other person to share calendars between your accounts.',
    pairedWith: 'Paired with {name}',
    pairedSince: 'Since {when}',
    generateInvite: 'Generate invite link',
    revoke: 'Revoke link',
    unlink: 'Unlink',
    unlinkConfirm: 'Unlink? Your partner will lose access to your shared calendars immediately.',
    copyLink: 'Copy link',
    copied: 'Copied!',
    expires: 'Expires {when}',
    activeLink: 'Send this link to your partner. It expires in 7 days.',
    errorGeneric: 'Something went wrong.',
    creating: 'Creating…',
    revoking: 'Revoking…',
    unlinking: 'Unlinking…',
    nativeOnly: 'This page is for the in-bot calendar only.',
  },
  he: {
    title: 'שיתוף עם פרטנר',
    notPairedSubtitle: 'אפשר להתחבר עם בן/בת זוג אחד/ת כדי לראות אחד את היומן של השני.',
    pairedWith: 'מחובר/ת עם {name}',
    pairedSince: 'מאז {when}',
    generateInvite: 'יצירת קישור הזמנה',
    revoke: 'ביטול הקישור',
    unlink: 'ניתוק',
    unlinkConfirm: 'לבצע ניתוק? הפרטנר יאבד את הגישה ליומנים המשותפים מיד.',
    copyLink: 'העתקת קישור',
    copied: 'הועתק!',
    expires: 'תוקף עד {when}',
    activeLink: 'שלחו את הקישור לפרטנר. תוקף 7 ימים.',
    errorGeneric: 'משהו השתבש.',
    creating: 'יוצר…',
    revoking: 'מבטל…',
    unlinking: 'מנתק…',
    nativeOnly: 'הדף זמין רק ליומן הפנימי.',
  },
  ru: {
    title: 'Связь с партнёром',
    notPairedSubtitle: 'Свяжитесь с одним человеком, чтобы делиться календарями.',
    pairedWith: 'В паре с {name}',
    pairedSince: 'С {when}',
    generateInvite: 'Создать ссылку',
    revoke: 'Отменить ссылку',
    unlink: 'Разорвать',
    unlinkConfirm: 'Разорвать пару? Партнёр сразу потеряет доступ к общим календарям.',
    copyLink: 'Копировать ссылку',
    copied: 'Скопировано!',
    expires: 'Истекает {when}',
    activeLink: 'Отправь ссылку партнёру. Срок 7 дней.',
    errorGeneric: 'Что-то пошло не так.',
    creating: 'Создаём…',
    revoking: 'Отменяем…',
    unlinking: 'Разрываем…',
    nativeOnly: 'Эта страница только для внутреннего календаря.',
  },
};

function fmt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function getInitData(): string | undefined {
  return typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
}

export default function PairClient({ userId, locale, initial }: Props) {
  const t = COPY[locale] || COPY.en;
  const isRTL = locale === 'he';

  const [partner, setPartner] = useState(initial.partner);
  const [invite, setInvite] = useState(initial.invite);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const createInvite = async () => {
    setBusy('create');
    setError('');
    try {
      const res = await fetch(`/api/pair/invite?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: getInitData() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || t.errorGeneric);
        return;
      }
      setInvite({ token: data.token, url: data.url, expiresAt: data.expiresAt });
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy('revoke');
    setError('');
    try {
      const res = await fetch(`/api/pair/invite?user_id=${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: getInitData() }),
      });
      if (!res.ok) {
        setError(t.errorGeneric);
        return;
      }
      setInvite(null);
    } finally {
      setBusy(null);
    }
  };

  const unlink = async () => {
    if (!confirm(t.unlinkConfirm)) return;
    setBusy('unlink');
    setError('');
    try {
      const res = await fetch(`/api/pair?user_id=${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: getInitData() }),
      });
      if (!res.ok) {
        setError(t.errorGeneric);
        return;
      }
      setPartner(null);
    } finally {
      setBusy(null);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older WebViews — fall back silently. The user can long-press to select.
    }
  };

  const expiresWhen = (iso: string) =>
    new Date(iso).toLocaleString(
      locale === 'he' ? 'he-IL' : locale === 'ru' ? 'ru-RU' : 'en-US',
      { dateStyle: 'medium', timeStyle: 'short' }
    );

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 p-4 md:p-8">
      <div className="max-w-md mx-auto">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-800 mb-6">{t.title}</h1>

        {error && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-4 text-rose-700 text-sm flex items-start gap-2">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {partner ? (
          <div className="bg-white rounded-2xl shadow-xl p-6 text-center">
            <div className="text-5xl mb-3">🤝</div>
            <h2 className="text-xl font-bold text-gray-800">{fmt(t.pairedWith, { name: partner.name })}</h2>
            {partner.acceptedAt && (
              <p className="text-sm text-gray-500 mt-1">
                {fmt(t.pairedSince, { when: new Date(partner.acceptedAt).toLocaleDateString(
                  locale === 'he' ? 'he-IL' : locale === 'ru' ? 'ru-RU' : 'en-US',
                  { dateStyle: 'medium' }
                ) })}
              </p>
            )}
            <button
              onClick={unlink}
              disabled={busy === 'unlink'}
              className="mt-6 w-full bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium py-3 rounded-xl transition-colors disabled:opacity-60"
            >
              {busy === 'unlink' ? t.unlinking : t.unlink}
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <p className="text-gray-600 text-sm mb-4">{t.notPairedSubtitle}</p>

            {invite ? (
              <div className="bg-blue-50 rounded-xl p-4 mb-3">
                <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-2">{t.activeLink}</p>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    readOnly
                    value={invite.url}
                    className="flex-1 bg-white border border-blue-200 rounded-lg px-3 py-2 text-sm font-mono text-gray-700 select-all"
                  />
                  <button
                    onClick={() => copyToClipboard(invite.url)}
                    className="bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-lg flex items-center justify-center"
                    aria-label={t.copyLink}
                  >
                    {copied ? <Check size={18} /> : <Copy size={18} />}
                  </button>
                </div>
                <p className="text-xs text-blue-600">{fmt(t.expires, { when: expiresWhen(invite.expiresAt) })}</p>
              </div>
            ) : null}

            <div className="flex gap-2">
              <button
                onClick={createInvite}
                disabled={busy === 'create'}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                <LinkIcon size={16} />
                {busy === 'create' ? t.creating : t.generateInvite}
              </button>
              {invite && (
                <button
                  onClick={revoke}
                  disabled={busy === 'revoke'}
                  className="bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-4 rounded-xl transition-colors disabled:opacity-60"
                  aria-label={t.revoke}
                >
                  {busy === 'revoke' ? '…' : <X size={16} />}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
