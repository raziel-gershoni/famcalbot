// Today's weather in the calendar home's header, as the Mini App reads it (GET /api/home-weather): the answer's shape,
// the request and the home's dependency on it. Client-safe and pure apart from fetch: it imports nothing from
// src/services (the weather services are server only). The server words the condition; the client words the rest.
//
// Nothing here throws: a request that fails, or answers in a form this file does not know, reads as `failed`.

import { initDataHeaders } from '../read-init-data';

/**
 * Today at the person's saved place, in whole degrees Celsius. `icon` is the name of the icon for today's code (the day's
 * most notable weather, weatherIconName on the server); `condition` is that code worded in the person's language, for
 * the block's label. `now` is the temperature now; `low` and `high` are today's.
 */
export interface HomeWeather {
  now: number;
  low: number;
  high: number;
  icon: string;
  condition: string;
}

/** What a request came to: `weather` is null when the person has no place saved. */
export type HomeWeatherOutcome = { kind: 'ok'; weather: HomeWeather | null } | { kind: 'failed'; status: number | null };

/** The home's dependency for the weather, so a smoke can fake the request. */
export interface HomeWeatherApi {
  load: (userId: number, locale: string) => Promise<HomeWeatherOutcome>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** The fields the header reads, so a body that is not a forecast is a failure to show, not a crash. */
export function isHomeWeather(value: unknown): value is HomeWeather {
  return isObject(value) && isWhole(value.now) && isWhole(value.low) && isWhole(value.high) && typeof value.icon === 'string' && typeof value.condition === 'string';
}

/** Today's weather. The init data goes in the header only; in a browser the session cookie rides along. user_id is the page's own. */
export async function fetchHomeWeather(userId: number, locale: string): Promise<HomeWeatherOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/home-weather?${new URLSearchParams({ user_id: String(userId), locale })}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: initDataHeaders(),
    });
  } catch (error) {
    console.error('[home-weather] the request did not reach the server:', error);
    return { kind: 'failed', status: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (error) {
    console.error(`[home-weather] the answer (${res.status}) was not JSON:`, error);
  }
  if (res.status === 200 && isObject(body)) {
    if (body.weather === null) return { kind: 'ok', weather: null };
    if (isHomeWeather(body.weather)) return { kind: 'ok', weather: body.weather };
  }
  console.error(`[home-weather] the forecast was not delivered: status ${res.status}`);
  return { kind: 'failed', status: res.status };
}

export const REAL_HOME_WEATHER: HomeWeatherApi = { load: fetchHomeWeather };
