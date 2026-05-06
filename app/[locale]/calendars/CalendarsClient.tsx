'use client';

// Native calendar management — list owned + partner-shared calendars,
// create new, rename / recolor / relabel / change privacy. View-only for
// partner-owned shared calendars.
//
// Voice CRUD remains the primary creation surface; this page is for the
// long tail of organization (renaming a calendar, moving a label, hiding
// one as private) where typed UI is faster than dictating.

import { useState } from 'react';
import { Lock, Eye, Edit3, Trash2, Plus, Check } from 'lucide-react';

interface Calendar {
  rawId: string;
  name: string;
  color: string;
  labels: string[];
  privacy: 'PRIVATE' | 'SHARED_VIEWER' | 'SHARED_EDITOR';
  ownerUserId: number;
  isOwner: boolean;
  personName?: string | null;
  personEnglishName?: string | null;
  personGender?: string | null;
  rules: string[];
  createdAt: string;
}

interface Props {
  userId: number;
  locale: string;
  initialCalendars: Calendar[];
}

const COLOR_PALETTE = [
  '#039BE5', '#7986CB', '#33B679', '#8E24AA', '#E67C73',
  '#F6BF26', '#F4511E', '#039BE5', '#616161', '#3F51B5',
  '#0B8043', '#D50000',
];

const VALID_LABELS = ['primary', 'yours', 'spouse', 'kids', 'birthdays'] as const;

const COPY: Record<string, Record<string, string>> = {
  en: {
    title: 'Your calendars',
    yours: 'Yours',
    sharedFromPartner: 'Shared from partner',
    addCalendar: 'New calendar',
    addCalendarPrompt: 'Calendar name',
    save: 'Save',
    cancel: 'Cancel',
    rename: 'Rename',
    delete: 'Delete',
    deleteConfirm: 'Delete this calendar?',
    privacyPrivate: 'Private (only you)',
    privacySharedViewer: 'Partner can view',
    privacySharedEditor: 'Partner can edit',
    labels: 'Labels',
    color: 'Color',
    privacyHeading: 'Visibility',
    canView: 'Partner can view',
    canEdit: 'Partner can edit',
    private: 'Private',
    cantDeleteLast: 'Cannot delete your only calendar.',
    saving: 'Saving…',
    deleting: 'Deleting…',
    creating: 'Creating…',
    namePlaceholder: 'e.g. Work, Family, Soccer',
    errorGeneric: 'Something went wrong.',
    paywall: 'Upgrade to add more calendars.',
  },
  he: {
    title: 'היומנים שלך',
    yours: 'שלך',
    sharedFromPartner: 'משותף מהפרטנר',
    addCalendar: 'יומן חדש',
    addCalendarPrompt: 'שם היומן',
    save: 'שמירה',
    cancel: 'ביטול',
    rename: 'שינוי שם',
    delete: 'מחיקה',
    deleteConfirm: 'למחוק את היומן הזה?',
    privacyPrivate: 'פרטי (רק את/ה)',
    privacySharedViewer: 'הפרטנר רואה',
    privacySharedEditor: 'הפרטנר יכול לערוך',
    labels: 'תוויות',
    color: 'צבע',
    privacyHeading: 'נראות',
    canView: 'פרטנר רואה',
    canEdit: 'פרטנר יכול לערוך',
    private: 'פרטי',
    cantDeleteLast: 'אי אפשר למחוק את היומן היחיד שלך.',
    saving: 'שומר…',
    deleting: 'מוחק…',
    creating: 'יוצר…',
    namePlaceholder: 'למשל: עבודה, משפחה, כדורגל',
    errorGeneric: 'משהו השתבש.',
    paywall: 'שדרוג כדי להוסיף עוד יומנים.',
  },
  ru: {
    title: 'Твои календари',
    yours: 'Твои',
    sharedFromPartner: 'От партнёра',
    addCalendar: 'Новый календарь',
    addCalendarPrompt: 'Название календаря',
    save: 'Сохранить',
    cancel: 'Отмена',
    rename: 'Переименовать',
    delete: 'Удалить',
    deleteConfirm: 'Удалить этот календарь?',
    privacyPrivate: 'Приватный (только ты)',
    privacySharedViewer: 'Партнёр видит',
    privacySharedEditor: 'Партнёр редактирует',
    labels: 'Метки',
    color: 'Цвет',
    privacyHeading: 'Видимость',
    canView: 'Партнёр видит',
    canEdit: 'Партнёр редактирует',
    private: 'Приватный',
    cantDeleteLast: 'Нельзя удалить единственный календарь.',
    saving: 'Сохраняем…',
    deleting: 'Удаляем…',
    creating: 'Создаём…',
    namePlaceholder: 'напр. Работа, Семья, Футбол',
    errorGeneric: 'Что-то пошло не так.',
    paywall: 'Обнови подписку, чтобы добавить календари.',
  },
};

function getInitData(): string | undefined {
  return typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
}

export default function CalendarsClient(props: Props) {
  const { userId, locale, initialCalendars } = props;
  const t = COPY[locale] || COPY.en;
  const isRTL = locale === 'he';

  const [calendars, setCalendars] = useState<Calendar[]>(initialCalendars);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>('');

  const owned = calendars.filter((c) => c.isOwner);
  const shared = calendars.filter((c) => !c.isOwner);

  const reload = async () => {
    const initData = getInitData();
    const url = `/api/native-calendars?user_id=${userId}${initData ? `&initData=${encodeURIComponent(initData)}` : ''}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      setCalendars(data.calendars);
    }
  };

  const create = async () => {
    if (!newName.trim()) return;
    setBusy('creating');
    setError('');
    try {
      const res = await fetch(`/api/native-calendars?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), initData: getInitData() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error === 'calendar_limit_reached' ? t.paywall : t.errorGeneric);
        return;
      }
      setNewName('');
      setCreating(false);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const patch = async (rawId: string, body: Record<string, unknown>) => {
    setBusy(rawId);
    setError('');
    try {
      const res = await fetch(`/api/native-calendars/${rawId}?user_id=${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, initData: getInitData() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t.errorGeneric);
        return;
      }
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (rawId: string) => {
    if (!confirm(t.deleteConfirm)) return;
    setBusy(rawId);
    setError('');
    try {
      const res = await fetch(`/api/native-calendars/${rawId}?user_id=${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: getInitData() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error === 'cannot_delete_last' ? t.cantDeleteLast : t.errorGeneric);
        return;
      }
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-800 mb-6">{t.title}</h1>

        {error && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-4 text-rose-700 text-sm">{error}</div>
        )}

        {/* Owned calendars */}
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-500 mb-2 uppercase tracking-wide">{t.yours}</h2>
          <div className="space-y-2">
            {owned.map((c) => (
              <CalendarCard
                key={c.rawId}
                calendar={c}
                t={t}
                isRTL={isRTL}
                editing={editingId === c.rawId}
                busy={busy === c.rawId}
                onStartEdit={() => setEditingId(c.rawId)}
                onCancelEdit={() => setEditingId(null)}
                onSave={async (body) => {
                  await patch(c.rawId, body);
                  setEditingId(null);
                }}
                onDelete={() => remove(c.rawId)}
              />
            ))}

            {creating ? (
              <div className="bg-white rounded-2xl shadow p-4 flex flex-col gap-3">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t.namePlaceholder}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  maxLength={60}
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setCreating(false); setNewName(''); }}
                    className="px-4 py-2 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 font-medium"
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={create}
                    disabled={!newName.trim() || busy === 'creating'}
                    className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-50"
                  >
                    {busy === 'creating' ? t.creating : t.save}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full bg-white rounded-2xl shadow border-2 border-dashed border-gray-300 hover:border-blue-400 p-4 flex items-center justify-center gap-2 text-gray-600 font-medium transition-colors"
              >
                <Plus size={18} /> {t.addCalendar}
              </button>
            )}
          </div>
        </div>

        {shared.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-500 mb-2 uppercase tracking-wide">{t.sharedFromPartner}</h2>
            <div className="space-y-2">
              {shared.map((c) => (
                <CalendarCard
                  key={c.rawId}
                  calendar={c}
                  t={t}
                  isRTL={isRTL}
                  editing={false}
                  busy={false}
                  readOnly
                  onStartEdit={() => {}}
                  onCancelEdit={() => {}}
                  onSave={async () => {}}
                  onDelete={() => {}}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  calendar: Calendar;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
  isRTL: boolean;
  editing: boolean;
  busy: boolean;
  readOnly?: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}

function CalendarCard(props: CardProps) {
  const { calendar: c, t, editing, busy, readOnly, onStartEdit, onCancelEdit, onSave, onDelete } = props;
  const [name, setName] = useState(c.name);
  const [color, setColor] = useState(c.color);
  const [labels, setLabels] = useState<string[]>(c.labels);
  const [privacy, setPrivacy] = useState(c.privacy);

  const PrivacyIcon = c.privacy === 'PRIVATE' ? Lock : c.privacy === 'SHARED_VIEWER' ? Eye : Edit3;
  const privacyLabel =
    c.privacy === 'PRIVATE' ? t.private : c.privacy === 'SHARED_VIEWER' ? t.canView : t.canEdit;

  if (editing) {
    return (
      <div className="bg-white rounded-2xl shadow p-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-blue-400"
          maxLength={60}
        />

        <div className="mb-3">
          <p className="text-xs font-semibold text-gray-500 mb-1">{t.color}</p>
          <div className="flex flex-wrap gap-1.5">
            {COLOR_PALETTE.map((swatch) => (
              <button
                key={swatch}
                onClick={() => setColor(swatch)}
                className={`w-7 h-7 rounded-full border-2 ${color === swatch ? 'border-gray-800' : 'border-transparent'}`}
                style={{ backgroundColor: swatch }}
                aria-label={swatch}
              />
            ))}
          </div>
        </div>

        <div className="mb-3">
          <p className="text-xs font-semibold text-gray-500 mb-1">{t.labels}</p>
          <div className="flex flex-wrap gap-1.5">
            {VALID_LABELS.map((label) => {
              const active = labels.includes(label);
              return (
                <button
                  key={label}
                  onClick={() =>
                    setLabels(active ? labels.filter((l) => l !== label) : [...labels, label])
                  }
                  className={`text-xs px-2.5 py-1 rounded-full ${active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-3">
          <p className="text-xs font-semibold text-gray-500 mb-1">{t.privacyHeading}</p>
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as Calendar['privacy'])}
            className="w-full border border-gray-200 rounded-xl px-3 py-2"
          >
            <option value="PRIVATE">{t.privacyPrivate}</option>
            <option value="SHARED_VIEWER">{t.privacySharedViewer}</option>
            <option value="SHARED_EDITOR">{t.privacySharedEditor}</option>
          </select>
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={onCancelEdit} className="px-4 py-2 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 font-medium">
            {t.cancel}
          </button>
          <button
            onClick={() => onSave({ name: name.trim(), color, labels, privacy })}
            disabled={!name.trim() || busy}
            className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-50"
          >
            {busy ? t.saving : t.save}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow p-4 flex items-center gap-3">
      <div className="w-3 h-12 rounded-full" style={{ backgroundColor: c.color }} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-gray-800 truncate">{c.name}</h3>
        </div>
        <div className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
          <PrivacyIcon size={12} /> {privacyLabel}
          {c.labels.length > 0 && <span className="ml-1">· {c.labels.join(' · ')}</span>}
        </div>
      </div>
      {!readOnly && (
        <div className="flex gap-1">
          <button
            onClick={onStartEdit}
            disabled={busy}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label={t.rename}
          >
            <Edit3 size={18} />
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="p-2 rounded-lg text-gray-500 hover:bg-rose-50 hover:text-rose-600"
            aria-label={t.delete}
          >
            {busy ? <Check size={18} /> : <Trash2 size={18} />}
          </button>
        </div>
      )}
    </div>
  );
}
