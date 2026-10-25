'use client';

// Drag to move, the Month's side of it (editor upgrades spec §4; ruling C: Month picked and
// browse, never the Agenda). The library is @dnd-kit/core: a mouse sensor (6 px), a touch sensor
// (a 450 ms press under 8 px of movement lifts; moving sooner scrolls, a short tap still opens),
// auto-scroll at the page's edges and a drag overlay for the ghost.
//
// This file only draws and reports. The rules (what lifts, where it lands, which occurrences) are
// drag-model.ts's, and the save is the container's (CalendarHome), through the editor's own path.
//
// - DragLayer wraps the Month's views. Without one around them (the Agenda, a view drawn alone) the
//   hooks below are inert: nothing is draggable and no marker shows.
// - An item is a draggable (useItemDrag): a row of the picked day's list, or a chip of a browse cell.
//   One that can't move still takes the press, so the same long-press says why (a warning haptic and
//   the container's note), and is then inert until the finger lifts: no ghost, no outline, no drop.
// - A day cell is a drop target (useDayDrop), found under the finger by a hit test, so a right-to-left
//   grid is right without any x maths. In picked, the month chevrons are targets too (useNavDrop):
//   600 ms over one turns the month, and again every 600 ms while the finger stays.
// - The ghost follows the finger, the origin dims, the day under the finger gets a 2 px --ch-accent
//   outline. Motion respects prefers-reduced-motion.
// - On a lift the container gives a medium impact, per new day a selection tick and, for an item that
//   can't move, a warning (onLift, onTarget, onBlocked: no Telegram code is loaded here). It locks Telegram's vertical
//   swipes while `onDraggingChange(true)`; here `touchmove` is blocked while lifted, and a drag's items
//   have no text menu (user-select and -webkit-touch-callout off, the context menu cancelled).
// - The container's BackButton cancels a lift through `cancelRef` (Escape is the library's own cancel).
// - A tap that ends a drag must not open the item: the guard (suppressClick) holds for a moment after.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import { dayOfDrop, dropId, liftVerdict, type CantLift } from '@/src/lib/calendar-view/drag-model';
import type { DayKey } from '@/src/lib/calendar-view/types';

/** The press that lifts an item, and the movement that starts a drag with a mouse (spec §4). */
export const LIFT_DELAY_MS = 450;
export const LIFT_TOLERANCE_PX = 8;
export const MOUSE_DISTANCE_PX = 6;
/** Time over a month chevron before the month turns, and between turns while the finger stays. */
export const NAV_DWELL_MS = 600;
/** A click this soon after a drag ended is the drag's, not a tap. */
const CLICK_GUARD_MS = 400;

/** What a draggable carries to the layer. */
interface DragData {
  key: string;
  /** The day the item was grabbed on (a cell's day, or the picked day). */
  day: DayKey;
  title: string;
  verdict: CantLift | null;
}

/** A drop the layer reports: the item, the day it was grabbed on and the day it was dropped on. */
export interface DropEvent {
  key: string;
  grabbedDay: DayKey;
  dropDay: DayKey;
}

interface DragContextValue {
  /** Inside a DragLayer: items are draggable. */
  enabled: boolean;
  /** The key of the item lifted now (its ghost is up), else null. */
  liftedKey: string | null;
  /** The key of the item whose move is saving: the pending look. */
  pendingKey: string | null;
  /** The month chevron under the finger, for its outline. */
  overNav: 'prev' | 'next' | null;
  suppressClick: () => boolean;
}

const OFF: DragContextValue = { enabled: false, liftedKey: null, pendingKey: null, overNav: null, suppressClick: () => false };
const DragContext = createContext<DragContextValue>(OFF);

export interface DragLayerProps {
  children: ReactNode;
  /** The key of the item whose save is running. */
  pendingKey: string | null;
  /** A lift of an item that can't move: why (the container gives the warning and shows the note). */
  onBlocked: (reason: CantLift) => void;
  /** An item was lifted (the medium impact), and the finger came over a new day or chevron (the selection tick). */
  onLift: () => void;
  onTarget: () => void;
  /** A drop on another day. */
  onDrop: (drop: DropEvent) => void;
  /** 600 ms over a month chevron: turn the month (picked). */
  onNav: (delta: -1 | 1) => void;
  /** A lift began or ended: the container locks Telegram's vertical swipes while true. */
  onDraggingChange: (dragging: boolean) => void;
  /** Filled with a function that cancels the lift in progress (the BackButton). */
  cancelRef: MutableRefObject<(() => void) | null>;
}

/** An element as the hit test reads it (a DOM Element, or a plain object in a smoke). */
export interface HitElement {
  contains: (other: HitElement) => boolean;
  closest?: (selector: string) => unknown;
}

/** The class of the drag overlay's wrapper: it is on top of everything and never a drop target. */
export const OVERLAY_CLASS = 'ch-drag-overlay';

/**
 * The drop targets under the pointer, by what the page draws there. `hits` are the registered cells whose
 * rect holds the pointer; `stack` is what the browser draws at that point, top first
 * (document.elementsFromPoint). The ghost's wrapper is skipped (it also takes no pointer events), so it can
 * never hide the cell under the finger; a sticky bar over a cell still hides it. With no stack (no
 * elementsFromPoint) the rect test stands.
 */
export function visibleHits<T extends { id: string | number }>(hits: readonly T[], nodeOf: (id: T['id']) => HitElement | null | undefined, stack: readonly HitElement[] | null): T[] {
  if (!stack) return [...hits];
  const under = stack.find((el) => !el.closest?.(`.${OVERLAY_CLASS}`));
  if (!under) return [...hits];
  return hits.filter((hit) => {
    const node = nodeOf(hit.id);
    return !node || node.contains(under);
  });
}

const hitTest: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const point = args.pointerCoordinates;
  const canStack = typeof document !== 'undefined' && typeof document.elementsFromPoint === 'function';
  return visibleHits(
    hits,
    (id) => args.droppableContainers.find((c) => c.id === id)?.node.current as HitElement | null | undefined,
    point && canStack ? (document.elementsFromPoint(point.x, point.y) as unknown as HitElement[]) : null,
  );
};

/** Gap between the ghost and the finger, px. */
const GHOST_GAP_PX = 14;
const EDGE_PX = 4;

/**
 * Where the ghost goes so it follows the finger and never sits under it: centred on the finger, its bottom
 * edge a few px above it, kept inside the screen. `transform` is the library's (the finger's movement),
 * `finger` where the press began, `origin` the lifted element's top-left (the overlay's natural position),
 * `ghost` the overlay's own size. Returns the translation to apply; direction-independent (RTL included).
 */
export function ghostTranslation(
  transform: { x: number; y: number },
  finger: { x: number; y: number } | null,
  origin: { left: number; top: number } | null,
  ghost: { width: number; height: number } | null,
  screen: { width: number; height: number } | null = null,
): { x: number; y: number } {
  if (!finger || !origin) return transform;
  const w = ghost?.width ?? 0;
  const h = ghost?.height ?? 0;
  let left = finger.x + transform.x - w / 2;
  let top = finger.y + transform.y - h - GHOST_GAP_PX;
  if (screen) left = Math.min(Math.max(left, EDGE_PX), Math.max(EDGE_PX, screen.width - w - EDGE_PX));
  top = Math.max(top, EDGE_PX);
  return { x: left - origin.left, y: top - origin.top };
}

/** Where a press began (client coordinates), from the event that started the drag. */
function fingerOf(event: Event | null | undefined): { x: number; y: number } | null {
  const e = event as { clientX?: number; clientY?: number; touches?: ArrayLike<{ clientX: number; clientY: number }>; changedTouches?: ArrayLike<{ clientX: number; clientY: number }> } | null | undefined;
  if (!e) return null;
  const touch = e.touches?.[0] ?? e.changedTouches?.[0];
  if (touch) return { x: touch.clientX, y: touch.clientY };
  return typeof e.clientX === 'number' && typeof e.clientY === 'number' ? { x: e.clientX, y: e.clientY } : null;
}

const ghostModifier: Modifier = ({ transform, activatorEvent, activeNodeRect, overlayNodeRect }) => {
  const screen = typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight };
  const moved = ghostTranslation(transform, fingerOf(activatorEvent), activeNodeRect, overlayNodeRect ?? null, screen);
  return { ...transform, x: moved.x, y: moved.y };
};

/** The screen-reader texts are the library's keyboard ones; there is no keyboard drag (the date picker is the accessible way), so none. */
const ACCESSIBILITY = {
  announcements: { onDragStart: () => undefined, onDragMove: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined },
  screenReaderInstructions: { draggable: '' },
};

function preventTouchMove(event: TouchEvent) {
  if (event.cancelable) event.preventDefault();
}

export function DragLayer({ children, pendingKey, onBlocked, onLift, onTarget, onDrop, onNav, onDraggingChange, cancelRef }: DragLayerProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: MOUSE_DISTANCE_PX } }),
    useSensor(TouchSensor, { activationConstraint: { delay: LIFT_DELAY_MS, tolerance: LIFT_TOLERANCE_PX } }),
  );
  /** The lifted item's ghost; null when nothing is lifted (a refused lift is inert and never sets it). */
  const [lifted, setLifted] = useState<DragData | null>(null);
  const [overNav, setOverNav] = useState<'prev' | 'next' | null>(null);
  /** The drag in progress, for the end of it (the library forgets a draggable whose node left the page). */
  const session = useRef<{ data: DragData; inert: boolean; cancelled: boolean } | null>(null);
  const guardUntil = useRef(0);
  const latest = useRef({ onBlocked, onLift, onTarget, onDrop, onNav, onDraggingChange });
  useEffect(() => {
    latest.current = { onBlocked, onLift, onTarget, onDrop, onNav, onDraggingChange };
  });

  // A refused lift reports once the press has lasted; a real one lifts.
  const start = (event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined;
    if (!data) return;
    if (data.verdict) {
      session.current = { data, inert: true, cancelled: false };
      latest.current.onBlocked(data.verdict);
      return;
    }
    session.current = { data, inert: false, cancelled: false };
    latest.current.onLift();
    setLifted(data);
    latest.current.onDraggingChange(true);
  };
  const over = (event: DragOverEvent) => {
    if (!session.current || session.current.inert) return;
    const id = event.over?.id;
    setOverNav(id === 'nav:prev' ? 'prev' : id === 'nav:next' ? 'next' : null);
    if (dayOfDrop(id) !== null || id === 'nav:prev' || id === 'nav:next') latest.current.onTarget();
  };
  const finish = (): typeof session.current => {
    const ended = session.current;
    session.current = null;
    guardUntil.current = Date.now() + CLICK_GUARD_MS;
    setLifted(null);
    setOverNav(null);
    if (ended && !ended.inert) latest.current.onDraggingChange(false);
    return ended;
  };
  const end = (event: DragEndEvent) => {
    const ended = finish();
    if (!ended || ended.inert || ended.cancelled) return;
    const dropDay = dayOfDrop(event.over?.id);
    if (dropDay !== null && dropDay !== ended.data.day) latest.current.onDrop({ key: ended.data.key, grabbedDay: ended.data.day, dropDay });
  };
  const cancel = () => {
    finish();
  };

  // The BackButton cancels a lift: Escape is the library's own cancel, and `cancelled` makes sure
  // that nothing is dropped whatever order the events come in.
  useEffect(() => {
    cancelRef.current = () => {
      if (!session.current) return;
      session.current.cancelled = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    };
    return () => {
      cancelRef.current = null;
    };
  }, [cancelRef]);

  // A layer that goes while an item is lifted (a tab switch) lets go of the swipe lock.
  useEffect(
    () => () => {
      if (session.current && !session.current.inert) latest.current.onDraggingChange(false);
    },
    [],
  );

  // While lifted the page must not scroll under the finger (auto-scroll moves it at the edges).
  useEffect(() => {
    if (!lifted) return;
    document.addEventListener('touchmove', preventTouchMove, { passive: false });
    return () => document.removeEventListener('touchmove', preventTouchMove);
  }, [lifted]);

  // Over a month chevron: after the dwell the month turns, and again each dwell while the finger stays.
  useEffect(() => {
    if (!lifted || !overNav) return;
    const delta = overNav === 'prev' ? -1 : 1;
    const id = setInterval(() => latest.current.onNav(delta), NAV_DWELL_MS);
    return () => clearInterval(id);
  }, [lifted, overNav]);

  const value = useMemo<DragContextValue>(
    () => ({ enabled: true, liftedKey: lifted?.key ?? null, pendingKey, overNav: lifted ? overNav : null, suppressClick: () => Date.now() < guardUntil.current }),
    [lifted, pendingKey, overNav],
  );

  return (
    <DragContext.Provider value={value}>
      <style>{DRAG_CSS}</style>
      <DndContext sensors={sensors} collisionDetection={hitTest} autoScroll={lifted !== null} accessibility={ACCESSIBILITY} onDragStart={start} onDragOver={over} onDragEnd={end} onDragCancel={cancel}>
        {children}
        <DragOverlay dropAnimation={null} className={OVERLAY_CLASS} modifiers={[ghostModifier]} style={{ inlineSize: 'auto', blockSize: 'auto', maxInlineSize: '72vw', pointerEvents: 'none' }}>
          {lifted ? (
            <div className="ch-drag-ghost" dir="auto" aria-hidden="true">
              <bdi>{lifted.title}</bdi>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </DragContext.Provider>
  );
}

/** What an item or chip hands its element: a ref, the listeners and the look. Inert outside a DragLayer. */
export interface ItemDrag {
  /** Spread on the element: the library's ref and listeners, and the one marker. Empty outside a DragLayer. */
  props: Record<string, unknown>;
  className: string;
  /** True for a tap that ends a drag: the click must not open the item. */
  suppressClick: () => boolean;
}

const INERT: ItemDrag = { props: {}, className: '', suppressClick: () => false };

/**
 * Makes an item draggable from the day it is shown on. `liftable` is data-lift (the one marker); an
 * item that can't move has the listeners but no marker, so its long-press can say why.
 */
export function useItemDrag(item: { key: string; title: string; canEdit: boolean; repeatsEveryDay: boolean }, day: DayKey): ItemDrag {
  const ctx = useContext(DragContext);
  const verdict = liftVerdict(item);
  const data: DragData = { key: item.key, day, title: item.title, verdict };
  const { setNodeRef: setNode, listeners } = useDraggable({ id: `${item.key}@${day}`, data, disabled: !ctx.enabled });
  if (!ctx.enabled) return INERT;
  const classes = ['ch-liftable', ctx.liftedKey === item.key ? 'is-lifted' : '', ctx.pendingKey === item.key ? 'is-pending' : ''].filter(Boolean).join(' ');
  return {
    props: { ref: setNode, ...listeners, ...(verdict === null ? { 'data-lift': 'yes' } : {}), onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault() },
    className: ` ${classes}`,
    suppressClick: ctx.suppressClick,
  };
}

/** A day cell as a drop target. `over` is true while a lifted item is over it. */
export function useDayDrop(day: DayKey): { props: Record<string, unknown>; over: boolean } {
  const ctx = useContext(DragContext);
  const { setNodeRef: setNode, isOver } = useDroppable({ id: dropId(day), disabled: !ctx.enabled || ctx.liftedKey === null });
  return ctx.enabled ? { props: { ref: setNode }, over: isOver && ctx.liftedKey !== null } : { props: {}, over: false };
}

/** A month chevron as a drop target (picked): 600 ms over it turns the month. */
export function useNavDrop(side: 'prev' | 'next'): { props: Record<string, unknown>; over: boolean } {
  const ctx = useContext(DragContext);
  const { setNodeRef: setNode } = useDroppable({ id: `nav:${side}`, disabled: !ctx.enabled || ctx.liftedKey === null });
  return ctx.enabled ? { props: { ref: setNode }, over: ctx.overNav === side } : { props: {}, over: false };
}

/**
 * The drag's styles, on the home's tokens. The ghost is the home's section colour with a 2 px accent
 * line; the origin dims; the cell under the finger gets a 2 px --ch-accent outline (inset, so the
 * grid never shifts); a saving item pulses softly. No text menu on an item, and none of it moves
 * under prefers-reduced-motion.
 */
export const DRAG_CSS = `
.ch-liftable {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
.ch-liftable.is-lifted {
  opacity: 0.35;
}
.ch-liftable.is-pending {
  opacity: 0.6;
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-drag-overlay {
  pointer-events: none;
}
.ch-drag-ghost {
  padding: 10px 14px;
  border: 2px solid var(--ch-accent);
  border-radius: 12px;
  background: var(--ch-section);
  box-shadow: var(--ch-sheet-shadow);
  color: var(--ch-text);
  font-size: 16px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.is-drop {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-mp-chev.is-drop-nav {
  background: var(--ch-pill-bg);
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .ch-liftable.is-pending {
    animation: none;
  }
}
`;
