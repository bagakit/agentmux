/** Pure player decisions. The media element and the stream lease owner hold every fact these read. */

export type MediaStreamClass = 'unknown' | 'on-demand' | 'live' | 'live-window'

/** Seconds behind the end of the seekable window still read as "at live". */
export const LIVE_EDGE_TOLERANCE_SECONDS = 10
/** A live window shorter than this has nothing worth scrubbing. */
export const LIVE_WINDOW_MIN_SECONDS = 30
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export type SeekableWindow = { start: number; end: number } | null

export function seekableWindow(ranges: Pick<TimeRanges, 'length' | 'start' | 'end'> | null | undefined): SeekableWindow {
  if (!ranges || ranges.length === 0) return null
  const last = ranges.length - 1, start = ranges.start(last), end = ranges.end(last)
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null
}

/** Live is the element's own fact: an unbounded duration. A window with a real range allows scrubbing. */
export function classifyStream(duration: number, window: SeekableWindow): MediaStreamClass {
  if (duration === Number.POSITIVE_INFINITY) return window && window.end - window.start >= LIVE_WINDOW_MIN_SECONDS ? 'live-window' : 'live'
  return Number.isFinite(duration) && duration > 0 ? 'on-demand' : 'unknown'
}

/** At live, behind it, or unknown when the engine has not reported a window yet. */
export function liveEdgeState(currentTime: number, window: SeekableWindow): 'at-live' | 'behind' | 'unknown' {
  if (!window) return 'unknown'
  return currentTime >= window.end - LIVE_EDGE_TOLERANCE_SECONDS ? 'at-live' : 'behind'
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds), hours = Math.floor(whole / 3600), minutes = Math.floor((whole % 3600) / 60), rest = whole % 60
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`
}

/** The spoken form of a time, for a slider's value text. */
export function spokenDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const hours = Math.floor(whole / 3600), minutes = Math.floor((whole % 3600) / 60), rest = whole % 60
  const parts = [hours && `${hours} hour${hours === 1 ? '' : 's'}`, minutes && `${minutes} minute${minutes === 1 ? '' : 's'}`,
    (rest || (!hours && !minutes)) && `${rest} second${rest === 1 ? '' : 's'}`].filter(Boolean)
  return parts.join(' ')
}

export function nextPlaybackRate(rate: number, direction: 1 | -1): number {
  const index = PLAYBACK_RATES.findIndex(value => value >= rate - 1e-6)
  const at = index < 0 ? PLAYBACK_RATES.length - 1 : PLAYBACK_RATES[index] === rate ? index : direction > 0 ? index - 1 : index
  return PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, at + direction))]!
}

export type MediaPlayerAction =
  | { kind: 'toggle-play' } | { kind: 'toggle-mute' } | { kind: 'fullscreen' }
  | { kind: 'seek-by'; seconds: number } | { kind: 'seek-to-fraction'; fraction: number }
  | { kind: 'seek-start' } | { kind: 'seek-end' }
  | { kind: 'volume-by'; amount: number } | { kind: 'rate'; direction: 1 | -1 }

export type MediaKeyContext = { stream: MediaStreamClass; video: boolean }
export type MediaKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented' | 'repeat'> & { target: EventTarget | null }

/** Text inputs keep every key; a native control keeps the keys it already handles itself. */
function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('textarea, select, [contenteditable=""], [contenteditable="true"], .xterm')) return true
  if (target instanceof HTMLInputElement) {
    if (target.type !== 'range') return true
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)
  }
  return (key === ' ' || key === 'Enter') && target.closest('button, a[href], [role="button"], [role="menuitem"]') !== null
}

/**
 * One key for this player, or null. Never claims a chord with Meta/Ctrl/Alt (those belong to the app),
 * a composing IME, a key App's capture router already consumed, or a key the focused control owns.
 */
export function resolveMediaKey(event: MediaKeyEvent, context: MediaKeyContext): MediaPlayerAction | null {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null
  if (ownsKey(event.target, event.key)) return null
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  const seekable = context.stream === 'on-demand' || context.stream === 'live-window'
  const onDemand = context.stream === 'on-demand' || context.stream === 'unknown'
  if (event.shiftKey && key !== '<' && key !== '>') return null
  if (event.repeat && (key === ' ' || key === 'k' || key === 'm' || key === 'f')) return null
  switch (key) {
    case ' ': case 'k': return { kind: 'toggle-play' }
    case 'm': return { kind: 'toggle-mute' }
    case 'f': return context.video ? { kind: 'fullscreen' } : null
    case 'ArrowLeft': return seekable ? { kind: 'seek-by', seconds: -5 } : null
    case 'ArrowRight': return seekable ? { kind: 'seek-by', seconds: 5 } : null
    case 'j': return seekable ? { kind: 'seek-by', seconds: -10 } : null
    case 'l': return seekable ? { kind: 'seek-by', seconds: 10 } : null
    case 'ArrowUp': return { kind: 'volume-by', amount: 0.05 }
    case 'ArrowDown': return { kind: 'volume-by', amount: -0.05 }
    case 'Home': return seekable ? { kind: 'seek-start' } : null
    case 'End': return context.stream === 'unknown' ? null : { kind: 'seek-end' }
    case '<': return onDemand ? { kind: 'rate', direction: -1 } : null
    case '>': return onDemand ? { kind: 'rate', direction: 1 } : null
  }
  if (/^[0-9]$/.test(key) && context.stream === 'on-demand') return { kind: 'seek-to-fraction', fraction: Number(key) / 10 }
  return null
}

export type MediaFailureView = { title: string; detail: string; retry: boolean }
export type MediaStreamFactState = 'active' | 'released' | 'deleted' | 'changed' | 'outside-workspace' | 'external-reference' | 'unsupported-resource' | 'read-error' | 'transient'

/**
 * A playback failure, explained by the lease owner's record first. MediaError.code alone cannot tell a
 * deleted file from an unsupported codec: the engine reports both as code 4. Its message is engine debug
 * text and is never read here.
 *
 * Only a single pinned file's record covers every byte the player read: once it records a verdict on the
 * file it refuses everything. A playlist lease's record describes its latest replies, and a clean reload can
 * follow a refused segment before the player asks, so for a playlist "active" with code 4 stays unknown.
 */
export function describeMediaFailure(fact: MediaStreamFactState | 'unknown', code: number | null, decoded = false,
  source: 'file' | 'playlist' = 'file'): MediaFailureView | null {
  switch (fact) {
    case 'released': return null
    case 'deleted': return { title: 'File was deleted', detail: 'This file no longer exists in the Workspace.', retry: true }
    case 'changed': return { title: 'File changed while playing', detail: 'The file on disk was replaced or rewritten. Reload to play the current file.', retry: true }
    case 'outside-workspace': return { title: 'File left the Workspace', detail: 'This path now points outside the Workspace, so its bytes are not read.', retry: true }
    case 'external-reference': return { title: 'Playlist points outside the Workspace', detail: 'This playlist references media by an absolute address. Only files inside the Workspace can play here.', retry: false }
    case 'unsupported-resource': return { title: 'Playlist references an unsupported file', detail: 'A file this playlist names is not a media segment type that plays here.', retry: false }
    case 'read-error': return { title: 'Could not read this file', detail: 'Reading the file failed. Retry, or open it in a system application.', retry: true }
    case 'transient': return { title: 'Playback was interrupted', detail: 'The media was briefly unavailable, for example while it was being rewritten. Retry to continue.', retry: true }
    case 'active': case 'unknown': break
  }
  if (code === 1) return null
  if (code === 3) return { title: 'Media could not be decoded', detail: 'Playback stopped on bytes this engine could not decode. Try opening it in a system application.', retry: true }
  // Once this engine has decoded frames, a later source error cannot mean the format is unsupported:
  // a live window that moved past the player, or a stall, also ends as code 4.
  if (code === 4 && decoded) return { title: 'Playback stopped', detail: 'The media stopped arriving after it had started playing. Retry to continue.', retry: true }
  if (code === 4 && fact === 'active' && source === 'file') return { title: 'Format not supported', detail: 'This engine cannot play this file’s format or codec. Try opening it in a system application.', retry: false }
  if (code === 2) return { title: 'Playback was interrupted', detail: 'Reading the media stopped before it finished. Retry to continue.', retry: true }
  return { title: 'Playback failed', detail: 'The cause is unknown. Retry, or open the file in a system application.', retry: true }
}
