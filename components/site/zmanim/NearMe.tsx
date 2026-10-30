'use client';

// "Near me" (spec 2026-10-30-public-zmanim §4.1.2), the zmanim index's only script. A tap asks the browser for the
// position (src/lib/geolocation.ts, the Settings lookup's options), finds the nearest listed city on the device
// (src/site/near-city.ts, haversine) and answers by distance: within 30 km it opens that city's page; from 30 to 100 km,
// in the device's own UTC offset, it names the city and the distance, with a link; further away, or in another offset, it
// says no city is near yet and points to the list. A refusal, an unavailable position or a browser with no geolocation
// says so and points to the list (a refusal also says where to allow location). The button shows a loading state until
// any answer. Nothing is sent anywhere: no map, no lookup, no request; only the city's page is opened. It imports nothing
// from src/services (CLAUDE.md).

import { useState, type ReactNode } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import { currentPosition } from '@/src/lib/geolocation';
import { nearAnswer } from '@/src/site/near-city';
import type { NearMeCity, NearMeWords } from '@/src/site/zmanim/near-words';

type State =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'opening'; city: NearMeCity }
  | { kind: 'near'; city: NearMeCity; km: number }
  | { kind: 'none' | 'denied' | 'unavailable' | 'unsupported' };

/** A template's {name}s filled in. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

export function NearMe({ cities, words }: { cities: NearMeCity[]; words: NearMeWords }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const find = async () => {
    setState({ kind: 'locating' });
    try {
      const found = await currentPosition();
      if (found.kind !== 'ok') {
        console.warn(`[near-me] no position: ${found.kind}`);
        setState({ kind: found.kind });
        return;
      }
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const answer = nearAnswer({ latitude: found.latitude, longitude: found.longitude }, zone, new Date(), cities);
      const city = answer.kind === 'none' ? undefined : cities.find((c) => c.slug === answer.slug);
      if (answer.kind === 'open' && city) {
        setState({ kind: 'opening', city });
        window.location.assign(city.href);
        return;
      }
      if (answer.kind === 'near' && city) {
        setState({ kind: 'near', city, km: Math.round(answer.km) });
        return;
      }
      setState({ kind: 'none' });
    } catch (error) {
      console.error('[near-me] the nearest city could not be found:', error);
      setState({ kind: 'unavailable' });
    }
  };

  const busy = state.kind === 'locating';
  const toList = (
    <p>
      <a className="site-zm-near-list" href="#cities">
        {words.toList}
      </a>
    </p>
  );
  let answer: ReactNode = null;
  if (state.kind === 'opening') answer = <p>{fill(words.opening, { city: state.city.name })}</p>;
  else if (state.kind === 'near') {
    const [before, after = ''] = words.near.split('{city}');
    const km = String(state.km);
    answer = (
      <p>
        {fill(before, { km })}
        <a href={state.city.href}>{state.city.name}</a>
        {fill(after, { km })}
      </p>
    );
  } else if (state.kind === 'none' || state.kind === 'denied' || state.kind === 'unavailable' || state.kind === 'unsupported') {
    answer = (
      <>
        <p>{words[state.kind]}</p>
        {toList}
      </>
    );
  }

  return (
    <div className="site-zm-near-body">
      <button type="button" className="site-zm-near-button" onClick={find} disabled={busy} aria-busy={busy}>
        {busy ? <Loader2 className="site-icon site-zm-spin" aria-hidden="true" focusable="false" /> : <MapPin className="site-icon" aria-hidden="true" focusable="false" />}
        {busy ? words.locating : words.button}
      </button>
      <p className="site-zm-near-privacy">{words.privacy}</p>
      <div className="site-zm-near-status" role="status" aria-live="polite">
        {answer}
      </div>
    </div>
  );
}
