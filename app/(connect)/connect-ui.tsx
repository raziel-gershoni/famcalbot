'use client';

// The pieces the Google connect pages share beside the kit (plan W4-3), drawn by ./connect-css.ts:
// - ConnectHero: the icon, the title (a page with no header has its h1 here) and the lead;
// - ConnectLoader: the app's loader (.ch-loader, the spinner) for a whole screen, its words for a screen reader;
// - ConnectChecking: a check running, said inside a notice (a small spinner and the words).
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

/** The app's loader for a whole screen: the spinner, and what it waits for for a screen reader. */
export function ConnectLoader({ label }: { label: string }) {
  return (
    <div className="ch-loader" role="status">
      <Loader2 size={32} className="ch-spin" aria-hidden="true" />
      <span className="ch-visually-hidden">{label}</span>
    </div>
  );
}

/** A check running, said inside a notice (whose role announces it): a small spinner and the words. */
export function ConnectChecking({ label }: { label: string }) {
  return (
    <span className="ch-connect-checking">
      <Loader2 size={16} className="ch-spin" aria-hidden="true" />
      {label}
    </span>
  );
}
