// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
import { MediaPlayer, type MediaLease } from '../src/renderer/src/components/MediaPlayer'
import { api } from '../src/renderer/src/lib/api'
import { classifyStream, describeMediaFailure, liveEdgeState, resolveMediaKey, seekableWindow, type MediaKeyEvent } from '../src/renderer/src/lib/media-player'

function ranges(...pairs: [number, number][]): TimeRanges {
  return { length: pairs.length, start: (index: number) => pairs[index]![0], end: (index: number) => pairs[index]![1] } as TimeRanges
}
function key(key: string, extra: Partial<MediaKeyEvent> = {}, target: EventTarget | null = document.body): MediaKeyEvent {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, repeat: false, target, ...extra }
}

describe('stream classification and live edge', () => {
  it('reads live only from an unbounded duration, and a scrubbable window only past 30 seconds', () => {
    expect(classifyStream(90, null)).toBe('on-demand')
    expect(classifyStream(Number.NaN, null)).toBe('unknown')
    expect(classifyStream(Number.POSITIVE_INFINITY, null)).toBe('live')
    expect(classifyStream(Number.POSITIVE_INFINITY, { start: 100, end: 129 })).toBe('live')
    expect(classifyStream(Number.POSITIVE_INFINITY, { start: 100, end: 130 })).toBe('live-window')
  })
  it('is at live within 10 seconds of the window end, behind past it, unknown with no window', () => {
    expect(liveEdgeState(150, { start: 100, end: 160 })).toBe('at-live')
    expect(liveEdgeState(149.9, { start: 100, end: 160 })).toBe('behind')
    expect(liveEdgeState(0, null)).toBe('unknown')
    expect(seekableWindow(ranges())).toBeNull()
    expect(seekableWindow(ranges([0, 10], [20, 60]))).toEqual({ start: 20, end: 60 })
  })
})

describe('player keys stay inside the player', () => {
  const onDemand = { stream: 'on-demand' as const, video: true }
  it('maps the player keys', () => {
    expect(resolveMediaKey(key(' '), onDemand)).toEqual({ kind: 'toggle-play' })
    expect(resolveMediaKey(key('K'), onDemand)).toEqual({ kind: 'toggle-play' })
    expect(resolveMediaKey(key('ArrowRight'), onDemand)).toEqual({ kind: 'seek-by', seconds: 5 })
    expect(resolveMediaKey(key('j'), onDemand)).toEqual({ kind: 'seek-by', seconds: -10 })
    expect(resolveMediaKey(key('7'), onDemand)).toEqual({ kind: 'seek-to-fraction', fraction: 0.7 })
    expect(resolveMediaKey(key('>', { shiftKey: true }), onDemand)).toEqual({ kind: 'rate', direction: 1 })
    expect(resolveMediaKey(key('f'), { ...onDemand, video: false })).toBeNull()
  })
  it('never claims app chords, composing input, consumed keys, editable targets or a terminal', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) expect(resolveMediaKey(key('k', { [modifier]: true }), onDemand), modifier).toBeNull()
    expect(resolveMediaKey(key('k', { shiftKey: true }), onDemand)).toBeNull()
    expect(resolveMediaKey(key('k', { isComposing: true }), onDemand)).toBeNull()
    expect(resolveMediaKey(key('k', { defaultPrevented: true }), onDemand)).toBeNull()
    const textarea = document.createElement('textarea'), input = document.createElement('input'), terminal = document.createElement('div')
    terminal.className = 'xterm'; const inside = document.createElement('span'); terminal.append(inside)
    for (const target of [textarea, input, inside]) expect(resolveMediaKey(key('k', {}, target), onDemand)).toBeNull()
  })
  it('leaves keys the focused control owns to that control', () => {
    const slider = Object.assign(document.createElement('input'), { type: 'range' }), button = document.createElement('button')
    expect(resolveMediaKey(key('ArrowRight', {}, slider), onDemand)).toBeNull()
    expect(resolveMediaKey(key('k', {}, slider), onDemand)).toEqual({ kind: 'toggle-play' })
    expect(resolveMediaKey(key(' ', {}, button), onDemand)).toBeNull()
    expect(resolveMediaKey(key('k', {}, button), onDemand)).toEqual({ kind: 'toggle-play' })
  })
  it('live without a window keeps play, mute, volume and go-live; seeking and speed are absent', () => {
    const live = { stream: 'live' as const, video: true }
    expect(resolveMediaKey(key(' '), live)).toEqual({ kind: 'toggle-play' })
    expect(resolveMediaKey(key('ArrowUp'), live)).toEqual({ kind: 'volume-by', amount: 0.05 })
    expect(resolveMediaKey(key('End'), live)).toEqual({ kind: 'seek-end' })
    for (const value of ['ArrowLeft', 'l', '5', 'Home']) expect(resolveMediaKey(key(value), live), value).toBeNull()
    expect(resolveMediaKey(key('>', { shiftKey: true }), live)).toBeNull()
    expect(resolveMediaKey(key('ArrowLeft'), { stream: 'live-window', video: true })).toEqual({ kind: 'seek-by', seconds: -5 })
  })
})

describe('failure explanation', () => {
  it('names the lease owner fact before any media error code', () => {
    expect(describeMediaFailure('deleted', 4)?.title).toBe('File was deleted')
    expect(describeMediaFailure('changed', 2)?.title).toBe('File changed while playing')
    expect(describeMediaFailure('external-reference', 4)?.title).toBe('Playlist points outside the Workspace')
    expect(describeMediaFailure('released', 4)).toBeNull()
  })
  it('only an active lease lets code 4 mean an unsupported format; otherwise the cause stays unknown', () => {
    expect(describeMediaFailure('active', 4)?.title).toBe('Format not supported')
    expect(describeMediaFailure('unknown', 4)?.title).toBe('Playback failed')
    expect(describeMediaFailure('active', 3)?.title).toBe('Media could not be decoded')
    expect(describeMediaFailure('active', 2)?.title).toBe('Playback was interrupted')
    expect(describeMediaFailure('active', 1)).toBeNull()
  })
})

describe('mounted player', () => {
  let root: Root, container: HTMLDivElement
  const lease = (kind: MediaLease['kind'] = 'video'): MediaLease => ({ id: `lease-${kind}`, url: `http://127.0.0.1:1/lease-${kind}/clip`, kind, byteLength: 55_314_157 })
  async function render(node: ReactNode) { await act(async () => root.render(node)); await act(async () => { await vi.dynamicImportSettled() }) }
  function media(): HTMLMediaElement { return container.querySelector('video, audio')! }
  function define(element: HTMLMediaElement, facts: Record<string, unknown>) {
    for (const [name, value] of Object.entries(facts)) Object.defineProperty(element, name, { configurable: true, get: () => value })
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('plays the lease URL with its own chrome: no native controls, no autoplay, metadata preload', async () => {
    await render(<MediaPlayer lease={lease()} name="clips/promo.mp4" onRetry={() => {}} />)
    const video = media()
    expect(video.tagName).toBe('VIDEO'); expect(video.getAttribute('src')).toBe(lease().url)
    expect(video.hasAttribute('controls')).toBe(false); expect(video.hasAttribute('autoplay')).toBe(false)
    expect(video.getAttribute('preload')).toBe('metadata')
    const group = container.querySelector('[role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('Video player: clips/promo.mp4'); expect(group.getAttribute('tabindex')).toBe('0')
    expect(container.querySelector('button[aria-label="Play"]')).not.toBeNull()
  })

  it('keys pressed inside the player act on it; the same key elsewhere does not', async () => {
    const outside = document.createElement('textarea'); document.body.append(outside)
    await render(<MediaPlayer lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { paused: true, ended: false })
    await act(async () => { outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })) })
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    const group = container.querySelector<HTMLElement>('[role="group"]')!
    await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })) })
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
    await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })) })
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
    outside.remove()
  })

  it('a live stream shows the live badge, never a duration, and goes back to live when behind', async () => {
    await render(<MediaPlayer lease={lease('playlist')} name="live/index.m3u8" onRetry={() => {}} />)
    const video = media()
    let current = 158
    define(video, { duration: Number.POSITIVE_INFINITY, seekable: ranges([100, 160]), buffered: ranges([100, 160]), paused: false, ended: false })
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => current, set: (value: number) => { current = value } })
    await act(async () => { video.dispatchEvent(new Event('durationchange')) })
    const badge = () => container.querySelector<HTMLButtonElement>('.media-player__live')!
    expect(badge().getAttribute('aria-label')).toBe('Playing live'); expect(badge().getAttribute('aria-disabled')).toBe('true')
    expect(container.textContent).not.toMatch(/Infinity|NaN/)
    expect(container.querySelector('.media-player__time')).toBeNull()
    expect(container.querySelector('.media-player__slider')?.getAttribute('aria-valuetext')).toBe('Live')
    current = 120
    await act(async () => { video.dispatchEvent(new Event('timeupdate')) })
    expect(badge().getAttribute('aria-label')).toBe('Go to live')
    await act(async () => badge().click())
    expect(current).toBe(160)
  })

  it('explains a failure by the lease owner fact, not by the media error code alone', async () => {
    const status = vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'deleted', path: 'clip.mp4' })
    const retry = vi.fn()
    await render(<MediaPlayer lease={lease()} name="clip.mp4" onRetry={retry} />)
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    expect(status).toHaveBeenCalledWith('lease-video')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('File was deleted')
    expect(container.textContent).not.toContain('Format not supported')
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === 'Retry')!
    await act(async () => button.click()); expect(retry).toHaveBeenCalledTimes(1)
  })

  it('an active lease with code 4 reads as an unsupported format', async () => {
    vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'active' })
    await render(<MediaPlayer lease={lease()} name="clip.mov" onRetry={() => {}} />)
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Format not supported')
  })

  it('video with no decodable picture says so and moves to the audio card without reloading the element', async () => {
    await render(<MediaPlayer lease={lease()} name="voice.mp4" onRetry={() => {}} />)
    const video = media()
    define(video, { videoWidth: 0, videoHeight: 0, duration: 30 })
    await act(async () => { video.dispatchEvent(new Event('loadeddata')) })
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Audio player: voice.mp4')
    expect(media()).toBe(video); expect(video.hidden).toBe(true)
    expect(container.textContent).toContain('No video picture could be decoded')
  })

  it('a first frame that arrived before the listeners still reads as decoded', async () => {
    // The engine has the frame already: the fact lives on the element, and no loadeddata will follow.
    const facts = { readyState: 4, videoWidth: 1920, videoHeight: 1080, duration: 12 }
    const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState')
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get() { return facts.readyState } })
    Object.defineProperty(HTMLMediaElement.prototype, 'videoWidth', { configurable: true, get() { return facts.videoWidth } })
    Object.defineProperty(HTMLMediaElement.prototype, 'videoHeight', { configurable: true, get() { return facts.videoHeight } })
    try {
      await render(<MediaPlayer lease={lease()} name="cached.mp4" onRetry={() => {}} />)
      expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
    } finally {
      if (original) Object.defineProperty(HTMLMediaElement.prototype, 'readyState', original); else delete (HTMLMediaElement.prototype as { readyState?: number }).readyState
      delete (HTMLMediaElement.prototype as { videoWidth?: number }).videoWidth; delete (HTMLMediaElement.prototype as { videoHeight?: number }).videoHeight
    }
  })

  it('an audio file uses the always-visible card with a primary play disc', async () => {
    await render(<MediaPlayer lease={lease('audio')} name="music/track.mp3" onRetry={() => {}} />)
    expect(media().tagName).toBe('AUDIO')
    expect(container.querySelector('.media-player__card')).not.toBeNull()
    expect(container.querySelector('.media-player__primary')?.getAttribute('aria-label')).toBe('Play')
  })

  it('leaving stops reading: pause, drop the source and reload the empty element', async () => {
    await render(<MediaPlayer lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const video = media()
    await act(async () => root.render(<></>))
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(video.hasAttribute('src')).toBe(false)
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
  })
})
