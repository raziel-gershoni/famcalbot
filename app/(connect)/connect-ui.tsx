'use client';

// The pieces the Google connect pages share beside the kit (plan W4-3), drawn by ./connect-css.ts:
// - ConnectHero: the icon, the title (a page with no header has its h1 here) and the lead;
// - ConnectLoader: the app's loader (.ch-loader, the spinner), with what it waits for said, or only heard.
// The text comes in already translated. Client-safe: React and lucide only.

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export function ConnectHero({ icon, title, lead }: { icon: ReactNode; title?: string; lead: ReactNode }) {
  return (
    <div className={title ? 'ch-connect-hero is-titled' : 'ch-connect-hero'}>
      <span className="ch-connect-icon">{icon}</span>
      {title ? <h1 className="ch-connect-title">{title}</h1> : null}
      <p className="ch-connect-lead">{lead}</p>
    </div>
  );
}

/** `shown`: the words under the spinner; without it a screen reader hears them and nothing else shows. */
export function ConnectLoader({ label, shown = false }: { label: string; shown?: boolean }) {
  return (
    <div className="ch-loader ch-connect-loader" role="status">
      <Loader2 size={32} className="ch-spin" aria-hidden="true" />
      <span className={shown ? 'ch-connect-loader-text' : 'ch-visually-hidden'}>{label}</span>
    </div>
  );
}
