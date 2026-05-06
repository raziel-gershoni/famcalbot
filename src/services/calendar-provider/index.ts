// Calendar provider dispatch.
//
// PR 3: native provider exists internally; getProviderForUser still always
// returns Google so behavior is unchanged. PR 4 wires the calendarSource
// branch so NATIVE users get the native provider.

import { UserConfig } from '../../types';
import { CalendarProvider } from './types';
import { googleProvider } from './google-provider';
import { nativeProvider } from './native-provider';

export function getProviderForUser(_user: UserConfig): CalendarProvider {
  // Single provider for now. PR 4 wires the calendarSource branch.
  return googleProvider;
}

export { googleProvider, nativeProvider };
export * from './types';
