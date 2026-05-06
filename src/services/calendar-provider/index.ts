// Calendar provider dispatch.
//
// PR 2: returns the Google provider for everyone. PR 4 will dispatch on
// `user.calendarSource` so NATIVE users hit the in-bot calendar provider
// (introduced in PR 3) and existing GOOGLE users keep their flow unchanged.

import { UserConfig } from '../../types';
import { CalendarProvider } from './types';
import { googleProvider } from './google-provider';

export function getProviderForUser(_user: UserConfig): CalendarProvider {
  // Single provider for now. PR 4 wires the calendarSource branch.
  return googleProvider;
}

export { googleProvider };
export * from './types';
