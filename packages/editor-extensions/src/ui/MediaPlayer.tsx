import '../styles/preview-common.css'
import '../styles/media-player.css'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { classifyStream, createSeekQueue, describeMediaFailure, formatClock, liveEdgeState, nextPlaybackRate, resolveMediaKey, seekableWindow, spokenDuration,
  timelinePreviewAvailable, type MediaFailureView, type MediaPlayerAction, type SeekableWindow, type SeekQueue } from '../engines/media-player'
import { formatFileBytes } from '../format-file-bytes'
import { MediaTimeline } from './MediaTimeline'

const PlayIcon = semanticIconComponent('control.media-play')
const PauseIcon = semanticIconComponent('control.media-pause')
const ReplayIcon = semanticIconComponent('control.media-replay')
const SeekBackIcon = semanticIconComponent('control.media-seek-back')
const SeekForwardIcon = semanticIconComponent('control.media-seek-forward')
const VolumeIcon = semanticIconComponent('control.media-volume')
const VolumeLowIcon = semanticIconComponent('control.media-volume-low')
const MutedIcon = semanticIconComponent('control.media-muted')
const FullscreenIcon = semanticIconComponent('control.media-fullscreen')
const ExitFullscreenIcon = semanticIconComponent('control.media-exit-fullscreen')
const LoadingIcon = semanticIconComponent('status.loading')

/** Matches the reference players' idle delay; a moving pointer or key restarts it. */
const IDLE_HIDE_MS = 2_000
/** Waiting shorter than this is ordinary seeking; only longer stalls show the spinner. */
const BUFFERING_DELAY_MS = 500
/** How long a spoken status stays in the live region before it clears for the next one. */
const ANNOUNCEMENT_MS = 1_000
/** HTMLMediaElement.HAVE_METADATA and HAVE_CURRENT_DATA, spelled out: duration is known; the first frame is decoded. */
const HAVE_METADATA = 1, HAVE_CURRENT_DATA = 2

export type MediaLease = { id: string; url: string; kind: 'audio' | 'video' | 'playlist'; byteLength: number }
/** Where a person left one File view's playback. Presentation state, so the Renderer keeps it across that view's leases. */
export type MediaResume = { current: { time: number; volume: number; muted: boolean; rate: number } | null }

type Facts = {
  paused: boolean; ended: boolean; muted: boolean; volume: number; rate: number
  currentTime: number; duration: number; window: SeekableWindow; buffered: number
  width: number; height: number; started: boolean
}
const INITIAL: Facts = { paused: true, ended: false, muted: false, volume: 1, rate: 1, currentTime: 0, duration: Number.NaN, window: null, buffered: 0, width: 0, height: 0, started: false }

type Indicator = { key: number; text: string; icon?: 'play' | 'pause'; side?: 'left' | 'right' | 'center' }

function bufferedEnd(element: HTMLMediaElement): number {
  const ranges = element.buffered, time = element.currentTime
  for (let index = 0; index < ranges.length; index++) if (ranges.start(index) <= time + 0.5 && ranges.end(index) >= time) return ranges.end(index)
  return 0
}

function readFacts(element: HTMLMediaElement, previous: Facts): Facts {
  const video = element instanceof HTMLVideoElement ? element : null
  return { paused: element.paused, ended: element.ended, muted: element.muted, volume: element.volume, rate: element.playbackRate,
    currentTime: element.currentTime, duration: element.duration, window: seekableWindow(element.seekable), buffered: bufferedEnd(element),
    width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0, started: previous.started || !element.paused || element.currentTime > 0 }
}

/**
 * The File Region's media player. The native element plays; this owns the chrome around it.
 * Facts come only from the element's own events and the lease owner's status, never from text.
 */
export function MediaPlayer({ lease, name, onRetry, resume, readStatus }: { lease: MediaLease; name: string; onRetry: () => void; resume?: MediaResume; readStatus(id: string): Promise<{ state: import('../engines/media-player').MediaStreamFactState }> }) {
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  const media = useRef<HTMLMediaElement | null>(null)
  const [facts, setFacts] = useState<Facts>(INITIAL)
  const [decode, setDecode] = useState<'loading' | 'ready' | 'no-picture' | 'error'>('loading')
  const [failure, setFailure] = useState<MediaFailureView | null>(null)
  const [buffering, setBuffering] = useState(false)
  const [active, setActive] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [remaining, setRemaining] = useState(false)
  const [scrub, setScrub] = useState<number | null>(null)
  // A pointer held on the timeline of a video with a picture moves the picture with it; playback that was running
  // pauses while held and resumes on release. Audio and the keyboard jump on release only.
  const [held, setHeld] = useState<{ lease: string; follow: boolean; resume: boolean } | null>(null)
  const holding = useRef<{ follow: boolean; resume: boolean } | null>(null)
  const scrubbed = useRef<number | null>(null)
  const seeks = useRef<SeekQueue | null>(null)
  seeks.current ??= createSeekQueue(time => { if (media.current) media.current.currentTime = time })
  // The pause and play a held drag makes are not changes the person asked for, so they are not announced.
  const quiet = useRef({ pause: false, play: false })
  const [indicator, setIndicator] = useState<Indicator | null>(null)
  const [announcement, setAnnouncement] = useState<{ key: number; text: string } | null>(null)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null)
  const released = useRef(false)
  // The lease this player is currently showing; an answer about any other lease is stale.
  const currentLease = useRef(lease.id)
  currentLease.current = lease.id
  // The engine's own decoded fact, kept once seen: a later error never makes it unknown again.
  const decodedOnce = useRef(false)
  const audioOnly = lease.kind === 'audio' || decode === 'no-picture'
  // Contain the picture's own shape in the free box, so controls sit on the picture, not on letterbox black.
  const fitted = !fullscreen && box && box.width > 0 && box.height > 0 && facts.width > 0 && facts.height > 0
    ? (() => { const scale = Math.min(box.width / facts.width, box.height / facts.height); return { width: Math.floor(facts.width * scale), height: Math.floor(facts.height * scale) } })()
    : null
  const stream = classifyStream(facts.duration, facts.window)
  const live = stream === 'live' || stream === 'live-window'
  const edge = live ? liveEdgeState(facts.currentTime, facts.window) : 'unknown'

  const update = useCallback(() => { const element = media.current; if (element) setFacts(previous => readFacts(element, previous)) }, [])
  const flash = useCallback((next: Omit<Indicator, 'key'>) => setIndicator({ ...next, key: performance.now() }), [])
  const announce = useCallback((text: string) => setAnnouncement({ key: performance.now(), text }), [])

  // Leaving: remember where playback was, then pause and drop the source so the engine stops reading.
  // The lease owner ends the lease. The element is captured now: React clears the ref before this cleanup runs.
  useEffect(() => {
    released.current = false
    const element = media.current
    return () => {
      released.current = true
      holding.current = null; scrubbed.current = null; seeks.current?.reset(false)
      if (element && resume) resume.current = { time: element.ended ? 0 : element.currentTime, volume: element.volume, muted: element.muted, rate: element.playbackRate }
      element?.pause(); element?.removeAttribute('src'); element?.load()
    }
  }, [lease.id, resume])

  // A new lease of the same File view picks up where the person left it, paused. Only a position inside
  // a bounded duration is restored: a live stream rejoins at its own live position.
  const restore = useCallback(() => {
    const element = media.current, saved = resume?.current
    if (!element || !saved || !resume) return
    resume.current = null
    element.volume = saved.volume; element.muted = saved.muted; element.playbackRate = saved.rate
    if (Number.isFinite(element.duration) && saved.time > 0 && saved.time < element.duration) element.currentTime = saved.time
  }, [resume])

  // A cached or fast source can deliver its first frame before React attaches listeners. The element
  // keeps that fact in readyState, so read it once on mount instead of waiting for an event already gone.
  useEffect(() => {
    const element = media.current
    if (element && element.readyState >= HAVE_METADATA) restore()
    if (!element || !(element.readyState >= HAVE_CURRENT_DATA)) return
    decodedOnce.current = true
    setFacts(previous => readFacts(element, previous))
    setDecode(current => current !== 'loading' ? current
      : element instanceof HTMLVideoElement && (element.videoWidth === 0 || element.videoHeight === 0) ? 'no-picture' : 'ready')
  }, [lease.id, restore])

  useEffect(() => () => { if (idle.current) clearTimeout(idle.current); if (waiting.current) clearTimeout(waiting.current) }, [])
  // The indicator leaves when its own --dur-indicator animation ends, in both the moving and the still variant.
  useEffect(() => { if (!announcement) return; const timer = setTimeout(() => setAnnouncement(null), ANNOUNCEMENT_MS); return () => clearTimeout(timer) }, [announcement])

  // The free box the picture can use; the stage is fitted to the picture inside it.
  useEffect(() => {
    const element = frame.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setBox(current => current?.width === element.clientWidth && current.height === element.clientHeight
      ? current : { width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Full screen belongs to this player's own document, which may be a second window.
  useEffect(() => {
    const document = root.current?.ownerDocument
    if (!document) return
    const change = () => setFullscreen(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', change)
    return () => document.removeEventListener('fullscreenchange', change)
  }, [])

  // Mirrors active, so a pointer moving over controls already shown only restarts the idle timer and never renders the player.
  const activeNow = useRef(true)
  const markActive = useCallback((next: boolean) => { if (activeNow.current === next) return; activeNow.current = next; setActive(next) }, [])
  const wake = useCallback(() => {
    markActive(true)
    if (idle.current) clearTimeout(idle.current)
    idle.current = setTimeout(() => markActive(false), IDLE_HIDE_MS)
  }, [markActive])

  const fail = useCallback(async () => {
    const element = media.current
    if (released.current || !element?.error) return
    const code = element.error.code, asked = lease.id
    const fact = await readStatus(asked).then(value => value.state, () => 'unknown' as const)
    if (released.current || currentLease.current !== asked) return
    const view = describeMediaFailure(fact, code, decodedOnce.current, lease.kind === 'playlist' ? 'playlist' : 'file')
    if (!view) return
    setDecode('error'); setFailure(view); setBuffering(false)
  }, [lease.id, lease.kind, readStatus])

  const run = useCallback((action: MediaPlayerAction, origin: 'key' | 'pointer') => {
    const element = media.current
    if (!element) return
    const window = seekableWindow(element.seekable)
    const lower = live ? window?.start ?? element.currentTime : 0
    const upper = live ? window?.end ?? element.currentTime : Number.isFinite(element.duration) ? element.duration : element.currentTime
    const seek = (time: number) => { element.currentTime = Math.min(upper, Math.max(lower, time)) }
    switch (action.kind) {
      case 'toggle-play':
        if (element.paused || element.ended) { void element.play().catch(() => {}); if (origin === 'key') flash({ text: 'Play', icon: 'play', side: 'center' }) }
        else { element.pause(); if (origin === 'key') flash({ text: 'Pause', icon: 'pause', side: 'center' }) }
        return
      case 'toggle-mute': element.muted = !element.muted; announce(element.muted ? 'Muted' : 'Unmuted'); flash({ text: element.muted ? 'Muted' : `${Math.round(element.volume * 100)}%` }); return
      case 'fullscreen': {
        const document = root.current?.ownerDocument
        if (!document || !root.current) return
        void (document.fullscreenElement === root.current ? document.exitFullscreen() : root.current.requestFullscreen()).catch(() => {})
        return
      }
      case 'seek-by': seek(element.currentTime + action.seconds); flash({ text: `${action.seconds > 0 ? '+' : ''}${action.seconds}s`, side: action.seconds > 0 ? 'right' : 'left' }); return
      case 'seek-to-fraction': if (Number.isFinite(element.duration)) seek(element.duration * action.fraction); return
      case 'seek-start': seek(lower); return
      case 'seek-end': if (live) { seek(upper); announce('Live') } else seek(upper); return
      case 'volume-by': {
        element.muted = false
        element.volume = Math.min(1, Math.max(0, Math.round((element.volume + action.amount) * 20) / 20))
        flash({ text: `${Math.round(element.volume * 100)}%` }); announce(`Volume ${Math.round(element.volume * 100)}%`)
        return
      }
      case 'rate': element.playbackRate = nextPlaybackRate(element.playbackRate, action.direction, action.wrap); flash({ text: `${element.playbackRate}×` }); announce(`Speed ${element.playbackRate}×`); return
    }
  }, [announce, flash, live])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = resolveMediaKey(event.nativeEvent, { stream, video: !audioOnly })
    if (!action) return
    event.preventDefault()
    wake()
    run(action, 'key')
  }

  // A click on the picture plays or pauses. A double click arrives as two clicks, which toggle and
  // toggle back, then the double click itself; it only enters full screen, so play state stays as it was.
  const onStageClick = () => { run({ kind: 'toggle-play' }, 'pointer'); wake() }
  const onStageDoubleClick = () => { run({ kind: 'fullscreen' }, 'pointer') }

  const sliderBounds = live ? facts.window : Number.isFinite(facts.duration) ? { start: 0, end: facts.duration } : null
  const span = sliderBounds ? Math.max(0, sliderBounds.end - sliderBounds.start) : 0
  const shown = scrub ?? facts.currentTime
  const fraction = sliderBounds && span > 0 ? Math.min(1, Math.max(0, (shown - sliderBounds.start) / span)) : 0
  const bufferedFraction = sliderBounds && span > 0 ? Math.min(1, Math.max(0, (facts.buffered - sliderBounds.start) / span)) : 0
  const sliderVisible = stream === 'on-demand' || stream === 'live-window'
  const valueText = live ? (edge === 'at-live' ? 'Live' : edge === 'behind' && facts.window ? `${spokenDuration(facts.window.end - shown)} behind live` : 'Live position unknown')
    : `${spokenDuration(shown)} of ${spokenDuration(facts.duration)}`
  const onHold = () => {
    const element = media.current
    if (!element) return
    const hold = { follow: !audioOnly, resume: !audioOnly && !element.paused && !element.ended }
    holding.current = hold
    setHeld({ lease: lease.id, ...hold })
    seeks.current!.reset(true)
    if (hold.resume) { quiet.current.pause = true; element.pause() }
  }
  const onScrub = (time: number) => {
    scrubbed.current = time
    setScrub(time)
    if (holding.current?.follow) seeks.current!.request(time)
  }
  const release = () => {
    const element = media.current, hold = holding.current, time = scrubbed.current
    holding.current = null; scrubbed.current = null
    setHeld(null); setScrub(null)
    if (!element) return
    if (time !== null) { if (hold?.follow) seeks.current!.land(time); else element.currentTime = time }
    // Playing on from the very end would make the engine start over from the beginning.
    if (hold?.resume && !(time !== null && time >= element.duration)) { quiet.current.play = true; void element.play().catch(() => { quiet.current.play = false }) }
  }

  const playing = !facts.paused && !facts.ended
  const drag = held?.lease === lease.id ? held : null
  // While held, the play control shows the playback the release brings back, not the hold's own pause.
  const playingShown = drag ? drag.resume : playing
  const PlayGlyph = facts.ended ? ReplayIcon : playingShown ? PauseIcon : PlayIcon
  const playLabel = facts.ended ? 'Play again' : playingShown ? 'Pause' : 'Play'
  const VolumeGlyph = facts.muted || facts.volume === 0 ? MutedIcon : facts.volume < 0.5 ? VolumeLowIcon : VolumeIcon
  const controlsVisible = !playing || active || scrub !== null || failure !== null
  const events = {
    onLoadedMetadata: () => { restore(); update() }, onDurationChange: update, onTimeUpdate: update, onProgress: update, onVolumeChange: update, onRateChange: update,
    // A seeked event queued before a newer seek began is stale; only an element that stopped seeking settles.
    onSeeked: () => { update(); if (media.current && !media.current.seeking) seeks.current?.settle() },
    onLoadedData: () => {
      update()
      decodedOnce.current = true
      const element = media.current
      // Decoded data with no picture is its own honest state; it never flips back on a later event.
      setDecode(current => current !== 'loading' ? current
        : element instanceof HTMLVideoElement && (element.videoWidth === 0 || element.videoHeight === 0) ? 'no-picture' : 'ready')
    },
    onPlay: () => { update(); if (quiet.current.play) quiet.current.play = false; else announce('Playing') },
    onPlaying: () => { update(); if (waiting.current) clearTimeout(waiting.current); setBuffering(false); wake() },
    onPause: () => { update(); if (quiet.current.pause) quiet.current.pause = false; else if (!released.current) announce('Paused') },
    onEnded: () => { update(); announce('Ended') },
    onWaiting: () => { if (waiting.current) clearTimeout(waiting.current); waiting.current = setTimeout(() => setBuffering(true), BUFFERING_DELAY_MS) },
    onCanPlay: () => { if (waiting.current) clearTimeout(waiting.current); setBuffering(false) },
    onError: () => { void fail() }
  }

  const playButton = (primary: boolean) => <button type="button" className={primary ? 'media-player__primary' : 'media-player__button'}
    aria-label={playLabel} title={`${playLabel} (k)`} aria-keyshortcuts="k Space" onClick={() => run({ kind: 'toggle-play' }, 'pointer')}>
    <PlayGlyph size={primary ? 20 : 16} />
  </button>
  const muteButton = <button type="button" className="media-player__button" aria-label={facts.muted ? 'Unmute' : 'Mute'} title={`${facts.muted ? 'Unmute' : 'Mute'} (m)`}
    aria-keyshortcuts="m" onClick={() => run({ kind: 'toggle-mute' }, 'pointer')}><VolumeGlyph size={16} /></button>
  const volume = <input className="media-player__volume" type="range" min={0} max={100} step={5} aria-label="Volume"
    aria-valuetext={`${Math.round((facts.muted ? 0 : facts.volume) * 100)}%`} value={Math.round((facts.muted ? 0 : facts.volume) * 100)}
    style={{ '--media-fill': `${(facts.muted ? 0 : facts.volume) * 100}%` } as CSSProperties}
    onChange={event => { const element = media.current; if (!element) return; element.muted = false; element.volume = Number(event.currentTarget.value) / 100 }} />
  // A frame preview needs a decoded picture, which failed main playback no longer has, so the preview goes with it.
  const previewable = timelinePreviewAvailable(lease.kind, stream, decode === 'ready' && facts.width > 0 && facts.height > 0)
  const timeline = sliderVisible ? <MediaTimeline key={lease.id} bounds={sliderBounds} fraction={fraction} buffered={bufferedFraction}
    label={live ? 'Live position' : 'Seek'} valueText={valueText}
    clock={time => live && facts.window ? `-${formatClock(facts.window.end - time)}` : formatClock(time)}
    preview={previewable ? { url: lease.url, ratio: facts.width / facts.height } : null} within={stage} controlsShown={audioOnly || controlsVisible}
    onHold={onHold} onScrub={onScrub} onLand={release} /> : null
  const liveBadge = live ? <button type="button" className="media-player__live" data-live-edge={edge}
    aria-disabled={edge !== 'behind'} aria-label={edge === 'unknown' ? 'Live position unknown' : edge === 'behind' ? 'Go to live' : 'Playing live'}
    title={edge === 'unknown' ? 'Live position unknown' : edge === 'behind' ? 'Go to live (End)' : 'Live'}
    onClick={() => { if (edge === 'behind') run({ kind: 'seek-end' }, 'pointer') }}>
    <span aria-hidden="true" className="media-player__live-dot" />
    {edge === 'unknown' ? 'LIVE · position unknown' : edge === 'behind' && facts.window ? `-${formatClock(facts.window.end - shown)} LIVE` : 'LIVE'}
  </button> : null
  // Elapsed / total on video and audio alike; the total side toggles to remaining time.
  const endTime = remaining && Number.isFinite(facts.duration) ? `-${formatClock(facts.duration - shown)}` : formatClock(facts.duration)
  const clock = live ? null : <span className="media-player__time">
    <span aria-hidden="true">{formatClock(shown)}</span>
    {Number.isFinite(facts.duration) ? <><span aria-hidden="true" className="media-player__duration"> / </span>
      <button type="button" className="media-player__time-toggle" aria-label={remaining ? 'Show total time' : 'Show remaining time'}
        onClick={() => setRemaining(value => !value)}>{endTime}</button></> : null}
  </span>
  const speed = stream === 'on-demand' ? <button type="button" className="media-player__button media-player__speed" aria-label={`Playback speed ${facts.rate}×`}
    title="Cycle speed (< and >)" onClick={() => run({ kind: 'rate', direction: 1, wrap: true }, 'pointer')}>{facts.rate}×</button> : null
  const failurePanel = failure ? <div className="media-player__failure" role="alert">
    <strong>{failure.title}</strong><span>{failure.detail}</span>
    {failure.retry ? <button type="button" className="media-player__retry" onClick={onRetry}>Retry</button> : null}
  </div> : null
  const statusLine = <span className="file-preview__metadata media-player__metadata">
    {[facts.width && facts.height ? `${facts.width.toLocaleString()} × ${facts.height.toLocaleString()}` : null,
      live ? 'Live' : Number.isFinite(facts.duration) ? formatClock(facts.duration) : decode === 'loading' ? 'Reading media index…' : null,
      lease.kind === 'playlist' ? 'HLS playlist' : formatFileBytes(lease.byteLength)].filter(Boolean).join(' · ')}
  </span>
  const announcer = <span className="media-player__announcer" role="status" aria-live="polite" aria-atomic="true">{announcement?.text ?? ''}</span>

  // The element follows the lease kind only, so a layout change never remounts it or reloads its bytes.
  const element = lease.kind === 'audio'
    ? <audio ref={node => { media.current = node }} src={lease.url} preload="metadata" {...events} />
    : <video ref={node => { media.current = node }} src={lease.url} preload="metadata" playsInline tabIndex={-1} {...events}
      hidden={audioOnly} onClick={onStageClick} onDoubleClick={onStageDoubleClick} />

  const audioCard = <div className="media-player__card">
    <div className="media-player__heading">
      <div className="media-player__title"><strong title={name}>{name.slice(name.lastIndexOf('/') + 1)}</strong>{statusLine}</div>
      {speed}
    </div>
    {timeline}
    {sliderVisible ? <div className="media-player__clock"><span aria-hidden="true">{formatClock(shown)}</span>
      {live ? null : <button type="button" className="media-player__time-toggle media-player__time--end" aria-label={remaining ? 'Show total time' : 'Show remaining time'}
        onClick={() => setRemaining(value => !value)}>{endTime}</button>}</div> : null}
    <div className="media-player__transport">
      <div className="media-player__transport-side">{liveBadge}</div>
      <div className="media-player__transport-main">
        {sliderVisible ? <button type="button" className="media-player__button" aria-label="Back 10 seconds" title="Back 10 seconds (j)" onClick={() => run({ kind: 'seek-by', seconds: -10 }, 'pointer')}><SeekBackIcon size={18} /></button> : null}
        {playButton(true)}
        {sliderVisible ? <button type="button" className="media-player__button" aria-label="Forward 10 seconds" title="Forward 10 seconds (l)" onClick={() => run({ kind: 'seek-by', seconds: 10 }, 'pointer')}><SeekForwardIcon size={18} /></button> : null}
      </div>
      <div className="media-player__transport-side media-player__transport-side--end">{muteButton}{volume}</div>
    </div>
    {decode === 'no-picture' ? <span className="file-preview__metadata">No video picture could be decoded. Audio may still play.</span> : null}
    {failurePanel}
  </div>

  const videoChrome = <>
    {facts.paused && !facts.ended && !failure && !drag ? <button type="button" className="media-player__start" aria-label="Play" title="Play (k)" onClick={() => run({ kind: 'toggle-play' }, 'pointer')}><PlayIcon size={22} /></button> : null}
    {buffering && !failure ? <span className="media-player__buffering" aria-hidden="true"><LoadingIcon size={20} animation="spin" /></span> : null}
    {indicator ? <span key={indicator.key} className="media-player__indicator" data-side={indicator.side ?? 'top'} aria-hidden="true"
      onAnimationEnd={() => setIndicator(current => current?.key === indicator.key ? null : current)}>
      {indicator.icon === 'play' ? <PlayIcon size={22} /> : indicator.icon === 'pause' ? <PauseIcon size={22} /> : indicator.text}</span> : null}
    {failurePanel}
    <div className="media-player__scrim" aria-hidden="true" />
    <div className="media-player__controls">
      <div className="media-player__bar">
        {playButton(false)}
        <div className="media-player__volume-group">{muteButton}{volume}</div>
        {clock}{liveBadge}
        {timeline}
        <span className="media-player__spacer" />
        {speed}
        <button type="button" className="media-player__button" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={`${fullscreen ? 'Exit full screen' : 'Full screen'} (f)`}
          aria-keyshortcuts="f" onClick={() => run({ kind: 'fullscreen' }, 'pointer')}>{fullscreen ? <ExitFullscreenIcon size={16} /> : <FullscreenIcon size={16} />}</button>
      </div>
    </div>
  </>

  return <div ref={root} className={`media-player media-player--${audioOnly ? 'audio' : 'video'}`} role="group"
    aria-label={`${audioOnly ? 'Audio' : 'Video'} player: ${name}`} tabIndex={0}
    data-decode-state={decode} data-stream={stream} data-controls={audioOnly || controlsVisible ? 'visible' : 'hidden'} data-fullscreen={fullscreen || undefined}
    onKeyDown={onKeyDown} onPointerMove={audioOnly ? undefined : wake} onPointerLeave={() => { if (!audioOnly && playing) markActive(false) }} onFocus={audioOnly ? undefined : wake}>
    <div ref={frame} className="media-player__frame" hidden={audioOnly}>
      <div ref={stage} className="media-player__stage" data-fitted={fitted ? '' : undefined}
        style={fitted ? { '--media-fit-width': `${fitted.width}px`, '--media-fit-height': `${fitted.height}px` } as CSSProperties : undefined}>
        {element}
        {audioOnly ? null : videoChrome}
      </div>
    </div>
    {audioOnly ? audioCard : statusLine}
    {announcer}
  </div>
}
