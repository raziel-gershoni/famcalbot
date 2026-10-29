'use client';

// A row of a list that leads somewhere (plan A): a person, an entry of a log, a message. It is a form-kit row (a 48 px
// button, the whole row the target) with the title, a quiet line under it, a row of tags under that, and the chevron at its
// end. Its CSS is FORM_CSS's (.ch-list-row*), which the screen renders; it sits on a FormCard.
//
// - `title` is what the row is called, `meta` a line of muted text (13 px), `tags` the statuses (Tag); a long title or
//   meta wraps instead of cutting. `describedBy` is the id of text that describes the row.
// - Title and meta come in already translated; a value that must read left to right (an id, a number) is the caller's
//   <bdi dir="ltr">. A title that is plain text takes its own direction (a name); a title the caller built (an id in a <bdi>) follows
//   the page, so a Hebrew row starts on the right whatever its id is made of. Free text in the meta is a <bdi dir="auto"> the same way.
//
// Client-safe: no import beyond React and the form kit.

import type { ReactNode } from 'react';
import { Chevron } from './form-kit';

export interface ListRowProps {
  title: ReactNode;
  meta?: ReactNode;
  tags?: ReactNode;
  onClick: () => void;
  describedBy?: string;
  /** The row takes no tap (its screen is working); the kit dims a disabled row button. */
  disabled?: boolean;
}

export function ListRow({ title, meta, tags, onClick, describedBy, disabled }: ListRowProps) {
  return (
    <button type="button" className="ch-form-row ch-list-row" aria-describedby={describedBy} disabled={disabled} onClick={onClick}>
      <span className="ch-form-label">
        <span className="ch-list-title" dir={typeof title === 'string' ? 'auto' : undefined}>
          {title}
        </span>
        {meta ? <span className="ch-form-hint">{meta}</span> : null}
        {tags ? <span className="ch-list-tags">{tags}</span> : null}
      </span>
      <Chevron />
    </button>
  );
}
