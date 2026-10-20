// Who may copy FamCal calendars to Google (google-sync spec §1, Who can use it): the plan
// feature googleSync, through the subscription service's one gate. Every place a copy is
// turned on or made again asks here first: a 'sync' consent (createGoogleConsent, for
// POST /api/oauth/start and the calendars page's turn-on) and /api/google-sync. Turning a
// copy off never asks: a lapsed plan can always take its copies out of Google.

import { checkFeatureAccess, peekFeatureAccess } from '../subscription-service';

/**
 * Whether the user's plan has google_sync. `track` false is for a page that only shows the
 * state (peekFeatureAccess: no feature_blocked logged when the user did nothing).
 */
export async function syncAllowed(userId: number, track = true): Promise<boolean> {
  const access = track ? await checkFeatureAccess(userId, 'google_sync') : await peekFeatureAccess(userId, 'google_sync');
  return access.allowed;
}
