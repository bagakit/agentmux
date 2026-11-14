import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

/** The timeline's native value range; a press lands on one of these steps. */
const TIMELINE_STEPS = 1_000

/** The pointed spot: the time a press there lands on, and where it sits, as a fraction of the track and in px from the timeline's left. */
type Pointed = { time: number; edge: number; x: number }

/**
 * The player's timeline: a native range over the seekable span and the time under the pointer.
 * Pointing lives here, so a moving pointer re-renders the timeline, never the player around it.
 */
export function MediaTimeline({ bounds, fraction, buffered, label, valueText, clock, onHold, onScrub, onLand }: {
  /** The seekable span in media seconds; without one, pointing and scrubbing do nothing. */
  bounds: { start: number; end: number } | null
  /** The shown position and the buffered end, as fractions of the span. */
  fraction: number
  buffered: number
  label: string
  valueText: string
  /** How a pointed time reads. */
  clock(time: number): string
  /** A primary press starts a held scrub; the player decides what holding does. */
  onHold(): void
  /** A scrub to a time: the pointed time at a press, then each value the range moves to. */
  onScrub(time: number): void
  /** Pointer release, cancel and lost capture, key release and blur each end a scrub; whichever comes first lands it. */
  onLand(): void
}) {
  const [hover, setHover] = useState<Pointed | null>(null)
  // A key let go while the pointer still holds the thumb does not end that drag.
  const pressed = useRef(false)
  const span = bounds ? Math.max(0, bounds.end - bounds.start) : 0
  // The thumb's width, read once per pointing: a style read on every move would cost a style pass each time.
  const thumbWidth = useRef<number | null>(null)
  const pointAt = (input: HTMLInputElement, clientX: number): Pointed | null => {
    if (!bounds || span <= 0) return null
    const track = input.getBoundingClientRect(), lane = input.parentElement!.getBoundingClientRect()
    // A native range maps a press over the thumb's travel, not the whole track, and lands on a step; the pointed time is that value.
    const thumb = thumbWidth.current ??= Number.parseFloat(getComputedStyle(input).getPropertyValue('--media-thumb')) || 0, travel = track.width - thumb
    if (travel <= 0) return null
    const along = Math.min(1, Math.max(0, (clientX - track.left - thumb / 2) / travel))
    const x = thumb / 2 + along * travel
    return { time: bounds.start + Math.round(along * TIMELINE_STEPS) / TIMELINE_STEPS * span, edge: x / track.width, x: track.left - lane.left + x }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    const pointed = pointAt(event.currentTarget, event.clientX)
    if (pointed) setHover(pointed)
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pressed.current = true
    onHold()
    // A native range only grabs a thumb pressed on itself and keeps the old value until the pointer moves.
    const pressedAt = pointAt(event.currentTarget, event.clientX)
    if (pressedAt) onScrub(pressedAt.time)
  }
  const land = () => { pressed.current = false; onLand() }
  const style = { '--media-fill': `${fraction * 100}%`, '--media-buffered': `${buffered * 100}%`,
    ...(hover ? { '--media-hover': `${hover.edge * 100}%` } : {}) } as CSSProperties
  return <div className="media-player__timeline">
    <input className="media-player__slider" type="range" data-media-timeline="" aria-label={label} aria-valuetext={valueText}
      min={0} max={TIMELINE_STEPS} step={1} value={Math.round(fraction * TIMELINE_STEPS)} style={style}
      onPointerMove={onPointerMove} onPointerLeave={() => { thumbWidth.current = null; setHover(null) }} onPointerDown={onPointerDown}
      onChange={event => { if (bounds) onScrub(bounds.start + Number(event.currentTarget.value) / TIMELINE_STEPS * span) }}
      onPointerUp={land} onPointerCancel={land} onLostPointerCapture={land} onKeyUp={() => { if (!pressed.current) onLand() }} onBlur={land} />
    {hover ? <output className="media-player__bubble" aria-hidden="true" style={{ left: `${hover.x}px` }}>{clock(hover.time)}</output> : null}
  </div>
}
