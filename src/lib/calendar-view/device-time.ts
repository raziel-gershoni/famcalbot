// An instant as the person's own device shows it (the Partner screen's dates, the invite landing's expiry): in the
// device's timezone, 24-hour time, in the page's language. They are the home's formatters (./format.ts) with the
// device's zone filled in. Client components only: on the server the "device" is the server, so a page that is also
// rendered there must not show these before it mounts (the invite landing waits for the client).
//
// When Intl does not say the device's zone, '' goes down: format.ts's formatter() falls back to the device's own zone
// for a zone Intl rejects, which is the same zone.

import { formatDayTime, formatDayYear, instantDay } from './format';
import { deviceTimeZone } from './home-client';

const zone = () => deviceTimeZone() ?? '';

/** "Thu 15 Oct, 22:00" / "חמישי 15 באוק׳, 22:00": an instant's day and 24-hour time on the device. '' when the value isn't an instant. */
export function formatDeviceDayTime(iso: string, locale: string): string {
  return formatDayTime(iso, zone(), locale);
}

/** "3 Oct 2026" / "3 באוק׳ 2026": the day an instant falls on, on the device, with its year. '' when the value isn't an instant. */
export function formatDeviceDate(iso: string, locale: string): string {
  const day = instantDay(iso, zone());
  return day ? formatDayYear(day, locale) : '';
}
