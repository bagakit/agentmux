import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'
import { classifyStream, describeMediaFailure, formatClock, liveEdgeState, nextPlaybackRate, resolveMediaKey, seekableWindow, spokenDuration,
  type MediaFailureView, type MediaPlayerAction, type SeekableWindow } from '../lib/media-player'
import type { WorkspaceMediaStreamKind } from '../../../shared/workspace-media-stream'
import { formatFileBytes } from './FilePreviewPane'

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
const INDICATOR_MS = 800
/** HTMLMediaElement.HAVE_CURRENT_DATA, spelled out: the first frame is decoded. */
const HAVE_CURRENT_DATA = 2

export type MediaLease = { id: string; url: string; kind: WorkspaceMediaStreamKind; byteLength: number }

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
export function MediaPlayer({ lease, name, onRetry }: { lease: MediaLease; name: string; onRetry: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLMediaElement | null>(null)
  const [facts, setFacts] = useState<Facts>(INITIAL)
  const [decode, setDecode] = useState<'loading' | 'ready' | 'no-picture' | 'error'>('loading')
  const [failure, setFailure] = useState<MediaFailureView | null>(null)
  const [buffering, setBuffering] = useState(false)
  const [active, setActive] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [remaining, setRemaining] = useState(false)
  const [scrub, setScrub] = useState<number | null>(null)
  const [hover, setHover] = useState<{ fraction: number; time: number } | null>(null)
  const [indicator, setIndicator] = useState<Indicator | null>(null)
  const [announcement, setAnnouncement] = useState<{ key: number; text: string } | null>(null)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null)
  const released = useRef(false)
  // The engine's own decoded fact, kept once seen: a later error never makes it unknown again.
  const decodedOnce = useRef(false)
  const audioOnly = lease.kind === 'audio' || decode === 'no-picture'
  const stream = classifyStream(facts.duration, facts.window)
  const live = stream === 'live' || stream === 'live-window'
  const edge = live ? liveEdgeState(facts.currentTime, facts.window) : 'unknown'

  const update = useCallback(() => { const element = media.current; if (element) setFacts(previous => readFacts(element, previous)) }, [])
  const flash = useCallback((next: Omit<Indicator, 'key'>) => setIndicator({ ...next, key: performance.now() }), [])
  const announce = useCallback((text: string) => setAnnouncement({ key: performance.now(), text }), [])

  // Leaving: pause and drop the source so the engine stops reading. The lease owner ends the lease.
  // The element is captured now: React clears the ref before this cleanup runs.
  useEffect(() => {
    released.current = false
    const element = media.current
    return () => {
      released.current = true
      element?.pause(); element?.removeAttribute('src'); element?.load()
    }
  }, [lease.id])

  // A cached or fast source can deliver its first frame before React attaches listeners. The element
  // keeps that fact in readyState, so read it once on mount instead of waiting for an event already gone.
  useEffect(() => {
    const element = media.current
    if (!element || !(element.readyState >= HAVE_CURRENT_DATA)) return
    decodedOnce.current = true
    setFacts(previous => readFacts(element, previous))
    setDecode(current => current !== 'loading' ? current
      : element instanceof HTMLVideoElement && (element.videoWidth === 0 || element.videoHeight === 0) ? 'no-picture' : 'ready')
  }, [lease.id])

  useEffect(() => () => { if (idle.current) clearTimeout(idle.current); if (waiting.current) clearTimeout(waiting.current) }, [])
  useEffect(() => { if (!indicator) return; const timer = setTimeout(() => setIndicator(null), INDICATOR_MS); return () => clearTimeout(timer) }, [indicator])
  useEffect(() => { if (!announcement) return; const timer = setTimeout(() => setAnnouncement(null), INDICATOR_MS); return () => clearTimeout(timer) }, [announcement])

  // Full screen belongs to this player's own document, which may be a second window.
  useEffect(() => {
    const document = root.current?.ownerDocument
    if (!document) return
    const change = () => setFullscreen(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', change)
    return () => document.removeEventListener('fullscreenchange', change)
  }, [])

  const wake = useCallback(() => {
    setActive(true)
    if (idle.current) clearTimeout(idle.current)
    idle.current = setTimeout(() => setActive(false), IDLE_HIDE_MS)
  }, [])

  const fail = useCallback(async () => {
    const element = media.current
    if (released.current || !element?.error) return
    const code = element.error.code
    // The lease owner records why it refused bytes before answering, so this read cannot race it.
    const fact = await api.files.mediaStreamStatus(lease.id).then(value => value.state, () => 'unknown' as const)
    if (released.current) return
    const view = describeMediaFailure(fact, code, decodedOnce.current)
    if (!view) return
    setDecode('error'); setFailure(view); setBuffering(false)
  }, [lease.id])

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
      case 'rate': element.playbackRate = nextPlaybackRate(element.playbackRate, action.direction); flash({ text: `${element.playbackRate}×` }); announce(`Speed ${element.playbackRate}×`); return
    }
  }, [announce, flash, live])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = resolveMediaKey(event.nativeEvent, { stream, video: !audioOnly })
    if (!action) return
    event.preventDefault()
    wake()
    run(action, 'key')
  }

  // A click on the picture plays or pauses; a double click enters full screen and leaves play state as it was.
  const onStageClick = () => { run({ kind: 'toggle-play' }, 'pointer'); wake() }
  const onStageDoubleClick = () => { run({ kind: 'toggle-play' }, 'pointer'); run({ kind: 'fullscreen' }, 'pointer') }

  const sliderBounds = live ? facts.window : Number.isFinite(facts.duration) ? { start: 0, end: facts.duration } : null
  const span = sliderBounds ? Math.max(0, sliderBounds.end - sliderBounds.start) : 0
  const shown = scrub ?? facts.currentTime
  const fraction = sliderBounds && span > 0 ? Math.min(1, Math.max(0, (shown - sliderBounds.start) / span)) : 0
  const bufferedFraction = sliderBounds && span > 0 ? Math.min(1, Math.max(0, (facts.buffered - sliderBounds.start) / span)) : 0
  const sliderVisible = stream === 'on-demand' || stream === 'live-window'
  const valueText = live ? (edge === 'at-live' ? 'Live' : edge === 'behind' && facts.window ? `${spokenDuration(facts.window.end - shown)} behind live` : 'Live position unknown')
    : `${spokenDuration(shown)} of ${spokenDuration(facts.duration)}`
  const timeText = remaining && Number.isFinite(facts.duration) ? `-${formatClock(facts.duration - shown)}` : formatClock(shown)

  const onSliderPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (!sliderBounds || span <= 0) return
    const box = event.currentTarget.getBoundingClientRect()
    const at = box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 0
    setHover({ fraction: at, time: sliderBounds.start + at * span })
  }
  const sliderStyle = { '--media-fill': `${fraction * 100}%`, '--media-buffered': `${bufferedFraction * 100}%`,
    ...(hover ? { '--media-hover': `${hover.fraction * 100}%` } : {}) } as CSSProperties

  const playing = !facts.paused && !facts.ended
  const PlayGlyph = facts.ended ? ReplayIcon : playing ? PauseIcon : PlayIcon
  const playLabel = facts.ended ? 'Play again' : playing ? 'Pause' : 'Play'
  const VolumeGlyph = facts.muted || facts.volume === 0 ? MutedIcon : facts.volume < 0.5 ? VolumeLowIcon : VolumeIcon
  const controlsVisible = !playing || active || scrub !== null || failure !== null
  const events = {
    onLoadedMetadata: update, onDurationChange: update, onTimeUpdate: update, onProgress: update, onVolumeChange: update, onRateChange: update,
    onSeeked: update,
    onLoadedData: () => {
      update()
      decodedOnce.current = true
      const element = media.current
      // Decoded data with no picture is its own honest state; it never flips back on a later event.
      setDecode(current => current !== 'loading' ? current
        : element instanceof HTMLVideoElement && (element.videoWidth === 0 || element.videoHeight === 0) ? 'no-picture' : 'ready')
    },
    onPlay: () => { update(); announce('Playing') },
    onPlaying: () => { update(); if (waiting.current) clearTimeout(waiting.current); setBuffering(false); wake() },
    onPause: () => { update(); if (!released.current) announce('Paused') },
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
  const timeline = sliderVisible ? <div className="media-player__timeline">
    <input className="media-player__slider" type="range" aria-label={live ? 'Live position' : 'Seek'} aria-valuetext={valueText}
      min={0} max={1000} step={1} value={Math.round(fraction * 1000)} style={sliderStyle}
      onPointerMove={onSliderPointer} onPointerLeave={() => setHover(null)}
      onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId) }}
      onChange={event => { if (!sliderBounds) return; setScrub(sliderBounds.start + Number(event.currentTarget.value) / 1000 * span) }}
      onPointerUp={() => { const element = media.current; if (element && scrub !== null) element.currentTime = scrub; setScrub(null) }}
      onKeyUp={() => { const element = media.current; if (element && scrub !== null) element.currentTime = scrub; setScrub(null) }}
      onBlur={() => { const element = media.current; if (element && scrub !== null) element.currentTime = scrub; setScrub(null) }} />
    {hover ? <output className="media-player__bubble" aria-hidden="true" style={{ left: `${hover.fraction * 100}%` }}>
      {live && facts.window ? `-${formatClock(facts.window.end - hover.time)}` : formatClock(hover.time)}</output> : null}
  </div> : null
  const liveBadge = live ? <button type="button" className="media-player__live" data-live-edge={edge}
    aria-disabled={edge !== 'behind'} aria-label={edge === 'behind' ? 'Go to live' : 'Playing live'} title={edge === 'behind' ? 'Go to live (End)' : 'Live'}
    onClick={() => { if (edge === 'behind') run({ kind: 'seek-end' }, 'pointer') }}>
    <span aria-hidden="true" className="media-player__live-dot" />{edge === 'behind' ? 'Go live' : 'LIVE'}
  </button> : null
  const clock = live ? null : <button type="button" className="media-player__time" aria-label={remaining ? 'Show elapsed time' : 'Show remaining time'}
    onClick={() => setRemaining(value => !value)}>
    <span aria-hidden="true">{timeText}</span>{Number.isFinite(facts.duration) ? <span aria-hidden="true" className="media-player__duration"> / {formatClock(facts.duration)}</span> : null}
  </button>
  const speed = stream === 'on-demand' ? <button type="button" className="media-player__button media-player__speed" aria-label={`Playback speed ${facts.rate}×`}
    title="Speed (< and >)" onClick={() => run({ kind: 'rate', direction: 1 }, 'pointer')}>{facts.rate}×</button> : null
  const failurePanel = failure ? <div className="media-player__failure" role="alert">
    <strong>{failure.title}</strong><span>{failure.detail}</span>
    {failure.retry ? <button type="button" className="small-button" onClick={onRetry}>Retry</button> : null}
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
    {sliderVisible ? <div className="media-player__clock" aria-hidden="true"><span>{formatClock(shown)}</span>
      <span>{live || !Number.isFinite(facts.duration) ? '' : `-${formatClock(facts.duration - shown)}`}</span></div> : null}
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
    {!facts.started && !failure ? <button type="button" className="media-player__start" aria-label="Play" title="Play (k)" onClick={() => run({ kind: 'toggle-play' }, 'pointer')}><PlayIcon size={22} /></button> : null}
    {buffering && !failure ? <span className="media-player__buffering" aria-hidden="true"><LoadingIcon size={20} animation="spin" /></span> : null}
    {indicator ? <span key={indicator.key} className="media-player__indicator" data-side={indicator.side ?? 'top'} aria-hidden="true">
      {indicator.icon === 'play' ? <PlayIcon size={22} /> : indicator.icon === 'pause' ? <PauseIcon size={22} /> : indicator.text}</span> : null}
    {failurePanel}
    <div className="media-player__scrim" aria-hidden="true" />
    <div className="media-player__controls">
      {timeline}
      <div className="media-player__bar">
        {playButton(false)}
        <div className="media-player__volume-group">{muteButton}{volume}</div>
        {clock}{liveBadge}
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
    onKeyDown={onKeyDown} onPointerMove={audioOnly ? undefined : wake} onPointerLeave={() => { if (!audioOnly && playing) setActive(false) }} onFocus={audioOnly ? undefined : wake}>
    <div className="media-player__stage" hidden={audioOnly}>
      {element}
      {audioOnly ? null : videoChrome}
    </div>
    {audioOnly ? audioCard : statusLine}
    {announcer}
  </div>
}
