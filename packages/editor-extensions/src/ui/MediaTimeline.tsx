import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

/** The timeline's native value range. */
const TIMELINE_STEPS = 1_000

/**
 * The player's timeline: a native range over the seekable span and the time under the pointer.
 * Pointing lives here, so a moving pointer re-renders the timeline, never the player around it.
 */
export function MediaTimeline({ bounds, fraction, buffered, label, valueText, clock, onScrub, onLand }: {
  /** The seekable span in media seconds; without one, pointing and scrubbing do nothing. */
  bounds: { start: number; end: number } | null
  /** The shown position and the buffered end, as fractions of the span. */
  fraction: number
  buffered: number
  label: string
  valueText: string
  /** How a pointed time reads. */
  clock(time: number): string
  onScrub(time: number): void
  /** Pointer release, key release and blur each end a scrub; whichever comes first lands it. */
  onLand(): void
}) {
  const [hover, setHover] = useState<{ fraction: number; time: number } | null>(null)
  const span = bounds ? Math.max(0, bounds.end - bounds.start) : 0
  const onPointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (!bounds || span <= 0) return
    const box = event.currentTarget.getBoundingClientRect()
    const at = box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 0
    setHover({ fraction: at, time: bounds.start + at * span })
  }
  const style = { '--media-fill': `${fraction * 100}%`, '--media-buffered': `${buffered * 100}%`,
    ...(hover ? { '--media-hover': `${hover.fraction * 100}%` } : {}) } as CSSProperties
  return <div className="media-player__timeline">
    <input className="media-player__slider" type="range" data-media-timeline="" aria-label={label} aria-valuetext={valueText}
      min={0} max={TIMELINE_STEPS} step={1} value={Math.round(fraction * TIMELINE_STEPS)} style={style}
      onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}
      onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId) }}
      onChange={event => { if (bounds) onScrub(bounds.start + Number(event.currentTarget.value) / TIMELINE_STEPS * span) }}
      onPointerUp={onLand} onKeyUp={onLand} onBlur={onLand} />
    {hover ? <output className="media-player__bubble" aria-hidden="true" style={{ left: `${hover.fraction * 100}%` }}>{clock(hover.time)}</output> : null}
  </div>
}
