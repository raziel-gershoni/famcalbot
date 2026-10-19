// Auto-create the user's main FamCal calendar: at signup (getOrCreateUser /
// getOrCreateUserByWhatsApp), and lazily for anyone who has none ("Google as a
// connection" spec §1: FamCal is for everyone), e.g. a legacy Google user whose FamCal
// was hidden by an old connect. Calendars hidden that way stay hidden.
//
// One calendar, name = user's name (or "My calendar"), labels: primary + yours, or only
// yours when the user's Google choices already hold primary (no new double primary,
// spec §3). Privacy: PRIVATE for unpaired users; SHARED_EDITOR if the user is already
// paired.

import { prisma } from '../../utils/prisma';

const FALLBACK_NAME = {
  en: 'My calendar',
  he: 'היומן שלי',
  ru: 'Мой календарь',
} as const;

export async function ensurePrimaryNativeCalendar(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, language: true, pairingId: true, calendarAssignments: true },
  });
  if (!user) return;

  const existing = await prisma.nativeCalendar.findFirst({
    where: { ownerUserId: userId, isDeleted: false },
    select: { id: true },
  });
  if (existing) return;

  const lang = (user.language as keyof typeof FALLBACK_NAME) || 'en';
  const fallback = FALLBACK_NAME[lang] || FALLBACK_NAME.en;
  const name = user.name?.trim() || fallback;
  const privacy = user.pairingId ? 'SHARED_EDITOR' : 'PRIVATE';
  const googlePrimary = Array.isArray(user.calendarAssignments) &&
    (user.calendarAssignments as Array<{ labels?: unknown }>).some((a) => Array.isArray(a?.labels) && a.labels.includes('primary'));

  await prisma.nativeCalendar.create({
    data: {
      ownerUserId: userId,
      name,
      labels: googlePrimary ? ['yours'] : ['primary', 'yours'],
      privacy,
    },
  });
}
