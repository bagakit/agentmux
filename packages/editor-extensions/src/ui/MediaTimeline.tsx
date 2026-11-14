import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject, type SyntheticEvent } from 'react'
import { createSeekQueue, type SeekQueue } from '../engines/media-player'

/** The timeline's native value range; a press lands on one of these steps. */
const TIMELINE_STEPS = 1_000
/** A frame preview is made only once the pointer has stayed on the timeline this long; a pointer crossing it makes none. */
const PREVIEW_DWELL_MS = 150
/** After a pointing ends, the preview decoder stays this long for a quick return; then it lets go of the file. */
const PREVIEW_RELEASE_MS = 3_000
/** The least room above the timeline that still fits a readable frame over the time; a shorter player points at the time only. */
const PREVIEW_MIN_ROOM = 96

/**
 * The pointed spot: the time a press there lands on, and where it sits, as a fraction of the track and in px from the
 * timeline's left; in the same px, the sides of the box a frame preview stays inside and the room above the timeline.
 */
type Pointed = { time: number; edge: number; x: number; lo: number; hi: number; room: number }

/**
 * The player's timeline: a native range over the seekable span, the time under the pointer and, where the player
 * allows it, the frame there. Pointing lives here, so a moving pointer re-renders the timeline, never the player around it.
 */
export function MediaTimeline({ bounds, fraction, buffered, label, valueText, clock, preview, within, controlsShown, onHold, onScrub, onLand }: {
  /** The seekable span in media seconds; without one, pointing and scrubbing do nothing. */
  bounds: { start: number; end: number } | null
  /** The shown position and the buffered end, as fractions of the span. */
  fraction: number
  buffered: number
  label: string
  valueText: string
  /** How a pointed time reads. */
  clock(time: number): string
  /** The file a frame preview decodes and its picture's shape; without one, pointing shows the time only. */
  preview: { url: string; ratio: number } | null
  /** The box a frame preview stays inside. */
  within: RefObject<HTMLElement | null>
  /** Whether the player's controls show; their idling away ends a pointing as leaving does. */
  controlsShown: boolean
  /** A primary press starts a held scrub; the player decides what holding does. */
  onHold(): void
  /** A scrub to a time: the pointed time at a press, then each value the range moves to. */
  onScrub(time: number): void
  /** Pointer release, cancel and lost capture, key release and blur each end a scrub; whichever comes first lands it. */
  onLand(): void
}) {
  const [hover, setHover] = useState<Pointed | null>(null)
  // The frame preview: a second decoder over the same file, made once the pointer stays a moment and let go a moment
  // after the pointing ends. Its frame shows only once a seek asked for in the current pointing has landed.
  const [decoding, setDecoding] = useState(false)
  const [frameShown, setFrameShown] = useState(false)
  const slider = useRef<HTMLInputElement>(null)
  const decoder = useRef<HTMLVideoElement | null>(null)
  // A pointing runs from the first move until the pointer leaves or presses, the controls idle away or the document hides.
  const pointing = useRef({ session: 0, active: false, time: 0, issued: -1, failed: -1 })
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null)
  const release = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewSeeks = useRef<SeekQueue | null>(null)
  previewSeeks.current ??= createSeekQueue(time => {
    if (!decoder.current) return
    pointing.current.issued = pointing.current.session
    decoder.current.currentTime = time
  }, false)
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
    const x = thumb / 2 + along * travel, sides = within.current ? within.current.getBoundingClientRect() : lane
    return { time: bounds.start + Math.round(along * TIMELINE_STEPS) / TIMELINE_STEPS * span, edge: x / track.width, x: track.left - lane.left + x,
      lo: sides.left - lane.left, hi: sides.right - lane.left, room: lane.top - sides.top }
  }

  // A pointed time the decoder already rests on shows its frame at once; any other waits for its own seek.
  const request = (time: number) => {
    const status = previewSeeks.current!.request(time)
    if (status === 'resting') setFrameShown(true)
    else if (status === 'in-flight') pointing.current.issued = pointing.current.session
  }
  const previewAt = (time: number) => {
    const now = pointing.current
    if (!now.active) {
      now.active = true; now.session += 1
      if (release.current) { clearTimeout(release.current); release.current = null }
    }
    now.time = time
    // A preview that failed in this pointing leaves the rest of it to the time alone; the next pointing tries again.
    if (now.failed === now.session) return
    if (decoding) request(time)
    else dwell.current ??= setTimeout(() => { dwell.current = null; setDecoding(true); request(pointing.current.time) }, PREVIEW_DWELL_MS)
  }
  // Ends the pointing's preview: no dwell and no frame, while the decoder stays for a return.
  const stopPreviewing = useCallback(() => {
    pointing.current.active = false
    if (dwell.current) { clearTimeout(dwell.current); dwell.current = null }
    setFrameShown(false)
  }, [])
  // The release delay counts from when the pointing ended; a later end, like the controls idling away after the pointer left, does not extend it.
  const leave = useCallback(() => {
    thumbWidth.current = null
    setHover(null)
    stopPreviewing()
    release.current ??= setTimeout(() => { release.current = null; setDecoding(false) }, PREVIEW_RELEASE_MS)
  }, [stopPreviewing])

  useEffect(() => { if (!controlsShown) leave() }, [controlsShown, leave])
  useEffect(() => {
    const document = slider.current?.ownerDocument
    if (!document) return
    const change = () => { if (document.visibilityState === 'hidden') leave() }
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [leave])
  useEffect(() => () => { if (dwell.current) clearTimeout(dwell.current); if (release.current) clearTimeout(release.current) }, [])

  // The source goes before the element does: a detached media element can keep reading.
  const attachDecoder = useCallback((node: HTMLVideoElement | null) => {
    decoder.current = node
    if (!node) return
    return () => {
      if (decoder.current === node) decoder.current = null
      previewSeeks.current?.reset(false)
      node.removeAttribute('src'); node.load()
    }
  }, [])
  const onPreviewSeeked = (event: SyntheticEvent<HTMLVideoElement>) => {
    // A seeked event queued before a newer seek began is stale; only a decoder that stopped seeking settles.
    if (event.currentTarget.seeking) return
    const now = pointing.current, fresh = now.issued === now.session
    previewSeeks.current?.settle()
    if (fresh && now.active) setFrameShown(true)
  }
  // A failed preview only folds its frame away: main playback never depends on it.
  const onPreviewError = () => {
    pointing.current.failed = pointing.current.session
    setFrameShown(false)
    setDecoding(false)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    const pointed = pointAt(event.currentTarget, event.clientX)
    if (!pointed) return
    setHover(pointed)
    // While held, the main picture follows the pointer instead.
    if (preview && !pressed.current && pointed.room >= PREVIEW_MIN_ROOM) previewAt(pointed.time)
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pressed.current = true
    stopPreviewing()
    onHold()
    // A native range only grabs a thumb pressed on itself and keeps the old value until the pointer moves.
    const pressedAt = pointAt(event.currentTarget, event.clientX)
    if (pressedAt) onScrub(pressedAt.time)
  }
  const land = () => { pressed.current = false; onLand() }
  const style = { '--media-fill': `${fraction * 100}%`, '--media-buffered': `${buffered * 100}%`,
    ...(hover ? { '--media-hover': `${hover.edge * 100}%` } : {}) } as CSSProperties
  // Losing the preview, as when main playback fails, drops the decoder in that same render.
  const decoderShown = preview !== null && decoding
  const pointedClock = hover ? clock(hover.time) : ''
  return <div className="media-player__timeline">
    <input ref={slider} className="media-player__slider" type="range" data-media-timeline="" aria-label={label} aria-valuetext={valueText}
      min={0} max={TIMELINE_STEPS} step={1} value={Math.round(fraction * TIMELINE_STEPS)} style={style}
      onPointerMove={onPointerMove} onPointerLeave={leave} onPointerDown={onPointerDown}
      onChange={event => { if (bounds) onScrub(bounds.start + Number(event.currentTarget.value) / TIMELINE_STEPS * span) }}
      onPointerUp={land} onPointerCancel={land} onLostPointerCapture={land} onKeyUp={() => { if (!pressed.current) onLand() }} onBlur={land} />
    {hover || decoderShown ? <div className="media-player__preview" aria-hidden="true" data-idle={hover ? undefined : ''}
      data-frame={hover && decoderShown && frameShown ? '' : undefined}
      style={{ ...(preview ? { '--media-preview-ratio': preview.ratio } : {}), ...(hover ? { '--media-preview-x': `${hover.x}px`,
        '--media-preview-lo': `${hover.lo}px`, '--media-preview-hi': `${hover.hi}px`, '--media-preview-room': `${hover.room}px`,
        '--media-bubble-ch': pointedClock.length } : {}) } as CSSProperties}>
      {decoderShown ? <span className="media-player__preview-frame">
        <video ref={attachDecoder} src={preview.url} muted preload="metadata" playsInline tabIndex={-1} disablePictureInPicture disableRemotePlayback
          onLoadedMetadata={() => previewSeeks.current?.open()} onSeeked={onPreviewSeeked} onError={onPreviewError} />
      </span> : null}
      {hover ? <output className="media-player__bubble">{pointedClock}</output> : null}
    </div> : null}
  </div>
}
