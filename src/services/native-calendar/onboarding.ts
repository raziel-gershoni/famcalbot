// Auto-create the primary native calendar for a brand-new NATIVE user.
// Called from getOrCreateUser / getOrCreateUserByWhatsApp at signup time.
//
// One calendar, name = user's name (or "My calendar"), labels: primary + yours.
// Privacy: PRIVATE for unpaired users; SHARED_EDITOR if the user is already
// paired (rare on first signup, but defensible if a future flow pairs the
// user before this runs).

import { prisma } from '../../utils/prisma';

const FALLBACK_NAME = {
  en: 'My calendar',
  he: 'היומן שלי',
  ru: 'Мой календарь',
} as const;

export async function ensurePrimaryNativeCalendar(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, language: true, calendarSource: true, pairingId: true },
  });
  if (!user) return;
  if (user.calendarSource !== 'NATIVE') return;

  const existing = await prisma.nativeCalendar.findFirst({
    where: { ownerUserId: userId, isDeleted: false },
    select: { id: true },
  });
  if (existing) return;

  const lang = (user.language as keyof typeof FALLBACK_NAME) || 'en';
  const fallback = FALLBACK_NAME[lang] || FALLBACK_NAME.en;
  const name = user.name?.trim() || fallback;
  const privacy = user.pairingId ? 'SHARED_EDITOR' : 'PRIVATE';

  await prisma.nativeCalendar.create({
    data: {
      ownerUserId: userId,
      name,
      labels: ['primary', 'yours'],
      privacy,
    },
  });
}
