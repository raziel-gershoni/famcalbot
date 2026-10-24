// Auto-create the user's main FamCal calendar: at signup (getOrCreateUser /
// getOrCreateUserByWhatsApp), and lazily for anyone who has none ("Google as a
// connection" spec §1: FamCal is for everyone), e.g. a legacy Google user whose FamCal
// was hidden by an old connect. Calendars hidden that way stay hidden.
//
// One calendar, name = user's name (or "My calendar"), labels: primary + yours, or only
// yours when the user has any Google choices (spec §3): with a Google primary that makes
// no double primary, and without one the default stays the first Google "yours" (a
// FamCal primary would win defaultCalendarFor's first rule). Privacy: PRIVATE for
// unpaired users; SHARED_EDITOR if the user is already paired.

import { prisma } from '../../utils/prisma';
import { autoCalendarColour } from './colour';
import { liveGoogleChoices, type GoogleChoicesOwner } from '../../lib/google-state';

const FALLBACK_NAME = {
  en: 'My calendar',
  he: 'היומן שלי',
  ru: 'Мой календарь',
} as const;

/** True when the user has Google choices that count (liveGoogleChoices): with a token, or a legacy Google user's without one. */
export function hasGoogleChoices(user: GoogleChoicesOwner): boolean {
  return liveGoogleChoices(user).length > 0;
}

export async function ensurePrimaryNativeCalendar(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, language: true, pairingId: true, googleRefreshToken: true, calendarSource: true, calendarAssignments: true },
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

  await prisma.nativeCalendar.create({
    data: {
      ownerUserId: userId,
      name,
      color: await autoCalendarColour(user),
      labels: hasGoogleChoices(user) ? ['yours'] : ['primary', 'yours'],
      privacy,
    },
  });
}
