'use client';

// How much of a limit is used (spec 2026-10-19 §4; W1b): the label and the count on one line, and under them a
// 6 px track with a fill. The label and the count text come in already translated, the count as it is shown
// ("7 of 10"), which is also what a screen reader hears (aria-valuetext).
// - The count is a whole translated sentence, so it sits in a bare <bdi>: it takes its own direction ("7 מתוך 10"
//   reads right to left). Never dir="ltr": that would turn the Hebrew sentence into "10 of 7". Only a value that is
//   numbers alone (a price) is forced left to right, by its caller.
//
// - The track is role="meter" from 0 to the limit; aria-valuenow is the used count, never above the limit. The
//   fill is the used share of the limit, never over 100%. The fill's inline-size makes it follow the reading direction.
// - Near the limit (from NEAR_LIMIT of it, and over it) the meter takes is-near: the fill and the count turn to
//   the warn colours (--ch-warn, --ch-warn-text), so the nearness shows by colour and by the count's words alike.
// - limit null is "no limit": the label and the text, no track and no role (a bar with no end means nothing).
//
// Client-safe: no import beyond React.

/** The share of the limit from which a meter is near it. */
export const NEAR_LIMIT = 0.8;

export interface MeterProps {
  label: string;
  used: number;
  /** The most there is, or null for unlimited. */
  limit: number | null;
  /** The count as it is shown and read: "7 of 10", or "Unlimited". */
  valueText: string;
}

export function Meter({ label, used, limit, valueText }: MeterProps) {
  const head = (
    <div className="ch-meter-head">
      <span className="ch-meter-label">{label}</span>
      <span className="ch-meter-value">
        <bdi>{valueText}</bdi>
      </span>
    </div>
  );
  if (limit === null) return <div className="ch-meter">{head}</div>;
  // A limit of 0 has no share to take: a full bar if anything was used, an empty one if not
  const share = limit > 0 ? Math.min(used / limit, 1) : used > 0 ? 1 : 0;
  const near = limit > 0 && used / limit >= NEAR_LIMIT;
  return (
    <div className={near ? 'ch-meter is-near' : 'ch-meter'}>
      {head}
      <div className="ch-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} aria-valuetext={valueText}>
        <div className="ch-meter-fill" style={{ inlineSize: `${share * 100}%` }} />
      </div>
    </div>
  );
}
