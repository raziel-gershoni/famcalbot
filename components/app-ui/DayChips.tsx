'use client';

// A row of day chips (lifted from the Repeat sheet, W1a): toggle buttons in a labelled group, each
// with the short day shown and the full day as its name. The order is the caller's (the
// person's week start), so in RTL the row mirrors on its own. The CSS is FORM_CSS's
// (.ch-daychips, .ch-daychip), which the screen renders.
//
// A pinned chip is the one that cannot be turned off (the Repeat sheet's start day, the last
// day left in a summary's days): it stays focusable and is announced as disabled
// (aria-disabled, not `disabled`), described by the hint that says why, and a tap does nothing.
//
// Client-safe: no import beyond React; the strings come in already translated.

export interface DayChip {
  id: string;
  /** What the chip shows ("Sun"). */
  short: string;
  /** The chip's accessible name ("Sunday"). */
  full: string;
  on: boolean;
  /** On and cannot be turned off. */
  pinned?: boolean;
}

export function DayChips({ label, days, onToggle, describedBy }: { label: string; days: DayChip[]; onToggle: (id: string) => void; describedBy?: string }) {
  return (
    <div className="ch-daychips" role="group" aria-label={label}>
      {days.map((day) => (
        <button
          key={day.id}
          type="button"
          className="ch-daychip"
          data-day={day.id}
          aria-pressed={day.on}
          aria-disabled={day.pinned || undefined}
          aria-describedby={day.pinned ? describedBy : undefined}
          aria-label={day.full}
          onClick={() => {
            if (!day.pinned) onToggle(day.id);
          }}
        >
          {day.short}
        </button>
      ))}
    </div>
  );
}
