// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
// Unchanged, but counted: the player's own render formats the file size once, so its calls count player renders.
vi.mock('@agentmux/editor-extensions/format-file-bytes', async original => {
  const actual = await original<typeof import('@agentmux/editor-extensions/format-file-bytes')>()
  return { ...actual, formatFileBytes: vi.fn(actual.formatFileBytes) }
})
import { formatFileBytes } from '@agentmux/editor-extensions/format-file-bytes'
import { MediaPlayer, type MediaLease } from '@agentmux/editor-extensions/ui/MediaPlayer'
import { api } from '../src/renderer/src/lib/api'
import { classifyStream, createSeekQueue, describeMediaFailure, liveEdgeState, resolveMediaKey, seekableWindow, type MediaKeyEvent } from '@agentmux/editor-extensions/engines/media-player'
import { readStyleSheet, stripCssComments } from './helpers/styles'

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

describe('timeline seeks that follow a pointer', () => {
  it('keeps one seek in flight and sends only the newest time once it lands', () => {
    const sent: number[] = [], queue = createSeekQueue(time => sent.push(time))
    expect(queue.request(10)).toBe('sent')
    for (const time of [20, 30, 40]) expect(queue.request(time)).toBe('queued')
    expect(sent).toEqual([10])
    queue.settle()
    expect(sent).toEqual([10, 40])
    queue.settle()
    expect(sent).toEqual([10, 40])
  })
  it('never sends the time the element rests on or is already seeking to', () => {
    const sent: number[] = [], queue = createSeekQueue(time => sent.push(time))
    queue.request(5)
    expect(queue.request(5)).toBe('in-flight')
    queue.settle()
    expect(queue.request(5)).toBe('resting')
    queue.request(8); queue.request(9)
    expect(queue.request(8)).toBe('in-flight')
    queue.settle()
    expect(sent).toEqual([5, 8])
  })
  it('holds the newest time until the element can seek, and a reset forgets every time', () => {
    const sent: number[] = [], queue = createSeekQueue(time => sent.push(time), false)
    expect(queue.request(1)).toBe('queued')
    queue.request(2)
    expect(sent).toEqual([])
    queue.open()
    expect(sent).toEqual([2])
    queue.reset(false); queue.settle(); queue.request(3)
    expect(sent).toEqual([2])
    queue.open(); queue.settle()
    expect(sent).toEqual([2, 3])
    queue.reset(true)
    expect(queue.request(3)).toBe('sent')
    expect(sent).toEqual([2, 3, 3])
  })
  it('a landing supersedes the seek in flight at once and drops the waiting time', () => {
    const sent: number[] = [], queue = createSeekQueue(time => sent.push(time))
    queue.request(10); queue.request(20); queue.land(30)
    expect(sent).toEqual([10, 30])
    queue.settle(); queue.land(30)
    expect(sent).toEqual([10, 30])
    // Landing where the element is already seeking still drops the older time waiting behind it.
    queue.request(40); queue.request(50); queue.land(40); queue.settle()
    expect(sent).toEqual([10, 30, 40])
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
  it('a focused timeline seeks by the player step, not by a thousandth of the duration', () => {
    const timeline = Object.assign(document.createElement('input'), { type: 'range' }); timeline.dataset.mediaTimeline = ''
    expect(resolveMediaKey(key('ArrowRight', {}, timeline), onDemand)).toEqual({ kind: 'seek-by', seconds: 5 })
    expect(resolveMediaKey(key('ArrowLeft', {}, timeline), onDemand)).toEqual({ kind: 'seek-by', seconds: -5 })
    expect(resolveMediaKey(key('Home', {}, timeline), onDemand)).toEqual({ kind: 'seek-start' })
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
    expect(describeMediaFailure('transient', 4)?.title).toBe('Playback was interrupted')
    expect(describeMediaFailure('transient', 4)?.retry).toBe(true)
  })
  it('a source error after frames were decoded is a stopped stream, never an unsupported format', () => {
    expect(describeMediaFailure('active', 4, true)?.title).toBe('Playback stopped')
    expect(describeMediaFailure('active', 4, true)?.retry).toBe(true)
    expect(describeMediaFailure('deleted', 4, true)?.title).toBe('File was deleted')
  })
  it('only an active lease lets code 4 mean an unsupported format; otherwise the cause stays unknown', () => {
    expect(describeMediaFailure('active', 4)?.title).toBe('Format not supported')
    expect(describeMediaFailure('unknown', 4)?.title).toBe('Playback failed')
    expect(describeMediaFailure('active', 3)?.title).toBe('Media could not be decoded')
    expect(describeMediaFailure('active', 2)?.title).toBe('Playback was interrupted')
    expect(describeMediaFailure('active', 1)).toBeNull()
  })
  it('a playlist lease reading active never proves an unsupported format: a clean reload can follow a refused segment', () => {
    const view = describeMediaFailure('active', 4, false, 'playlist')
    expect(view?.title).toBe('Playback failed'); expect(view?.retry).toBe(true)
    expect(describeMediaFailure('transient', 4, false, 'playlist')?.title).toBe('Playback was interrupted')
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
  function timeline() { return container.querySelector<HTMLInputElement>('.media-player__slider')! }
  // The track runs 200–800px inside a 1000px stage whose top is 400px above it: with a 600 s file, x - 200 is the second.
  function layout() {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this } }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('media-player__slider')) return rect(200, 500, 600, 20)
      if (this.classList.contains('media-player__timeline')) return rect(192, 500, 616, 20)
      return rect(0, 100, 1000, 450)
    })
  }
  async function point(clientX: number) {
    await act(async () => { timeline().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, pointerId: 1 })) })
  }
  const bubble = () => container.querySelector<HTMLElement>('.media-player__bubble')
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('plays the lease URL with its own chrome: no native controls, no autoplay, metadata preload', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clips/promo.mp4" onRetry={() => {}} />)
    const video = media()
    expect(video.tagName).toBe('VIDEO'); expect(video.getAttribute('src')).toBe(lease().url)
    expect(video.hasAttribute('controls')).toBe(false); expect(video.hasAttribute('autoplay')).toBe(false)
    expect(video.getAttribute('preload')).toBe('metadata')
    const group = container.querySelector('[role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('Video player: clips/promo.mp4'); expect(group.getAttribute('tabindex')).toBe('0')
    expect(container.querySelector('button[aria-label="Play"]')).not.toBeNull()
  })

  it('the rendered timeline is the one the player step drives', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { duration: 600 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    const timeline = container.querySelector<HTMLInputElement>('.media-player__slider')!, volume = container.querySelector<HTMLInputElement>('.media-player__volume')!
    const onDemand = { stream: 'on-demand' as const, video: true }
    expect(resolveMediaKey(key('ArrowRight', {}, timeline), onDemand)).toEqual({ kind: 'seek-by', seconds: 5 })
    expect(resolveMediaKey(key('ArrowRight', {}, volume), onDemand)).toBeNull()
  })

  it('keys pressed inside the player act on it; the same key elsewhere does not', async () => {
    const outside = document.createElement('textarea'); document.body.append(outside)
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
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

  it('an input indicator leaves when its own animation ends, not on a separate timer', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { paused: true, ended: false, duration: 60 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    const group = container.querySelector<HTMLElement>('[role="group"]')!
    await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true })) })
    const indicator = () => container.querySelector('.media-player__indicator')
    expect(indicator()?.textContent).toBe('+10s')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_200)) })
    expect(indicator()).not.toBeNull()
    await act(async () => { indicator()!.dispatchEvent(new Event('animationend', { bubbles: true })) })
    expect(indicator()).toBeNull()
  })

  it('a live stream shows the live badge, never a duration, and goes back to live when behind', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease('playlist')} name="live/index.m3u8" onRetry={() => {}} />)
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

  it('keeps an unreported live position unknown while playback remains available', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease('playlist')} name="live/index.m3u8" onRetry={() => {}} />)
    define(media(), { duration: Number.POSITIVE_INFINITY, seekable: ranges(), paused: true })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    const badge = () => container.querySelector<HTMLButtonElement>('.media-player__live')!
    expect(badge().getAttribute('aria-label')).toBe('Live position unknown')
    expect(badge().textContent).toContain('position unknown')
    expect(badge().dataset.liveEdge).toBe('unknown')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Play"]')!.click())
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    define(media(), { seekable: ranges([0, 10]), currentTime: 9 })
    await act(async () => { media().dispatchEvent(new Event('progress')) })
    expect(badge().getAttribute('aria-label')).toBe('Playing live')
  })

  it('cycles every speed by pointer and keeps keyboard speed changes clamped', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { duration: 60 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    for (const rate of [1.25, 1.5, 2, 0.5, 0.75, 1]) {
      await act(async () => container.querySelector<HTMLButtonElement>('.media-player__speed')!.click())
      expect(media().playbackRate).toBe(rate)
      await act(async () => { media().dispatchEvent(new Event('ratechange')) })
      expect(container.querySelector('.media-player__speed')!.textContent).toBe(`${rate}×`)
    }
    const group = container.querySelector<HTMLElement>('[role="group"]')!
    for (const [rate, key] of [[2, '>'], [0.5, '<']] as const) {
      media().playbackRate = rate
      await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true })) })
      expect(media().playbackRate).toBe(rate)
    }
  })

  it('explains a failure by the lease owner fact, not by the media error code alone', async () => {
    const status = vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'deleted', path: 'clip.mp4' })
    const retry = vi.fn()
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={retry} />)
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    expect(status).toHaveBeenCalledWith('lease-video')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('File was deleted')
    expect(container.textContent).not.toContain('Format not supported')
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === 'Retry')!
    await act(async () => button.click()); expect(retry).toHaveBeenCalledTimes(1)
  })

  it('a failure reason that arrives after the player moved to a new lease does not land on it', async () => {
    let answer!: (value: { state: 'deleted'; path: string }) => void
    vi.spyOn(api.files, 'mediaStreamStatus').mockImplementation(() => new Promise(resolve => { answer = resolve }))
    const first = lease(), next = { ...lease(), id: 'lease-next', url: 'http://127.0.0.1:1/lease-next/clip' }
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={first} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    // The same player instance is handed a new lease before the old lease's reason comes back.
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={next} name="clip.mp4" onRetry={() => {}} />)
    await act(async () => { answer({ state: 'deleted', path: 'clip.mp4' }) })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('an active lease with code 4 reads as an unsupported format', async () => {
    vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'active' })
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mov" onRetry={() => {}} />)
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Format not supported')
  })

  it('a playlist that fails before any frame with an active record offers Retry, never an unsupported-format verdict', async () => {
    vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'active' })
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease('playlist')} name="live/live.m3u8" onRetry={() => {}} />)
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Playback failed')
    expect(container.textContent).not.toContain('Format not supported')
  })

  it('a live stream that stalls after playing says it stopped, not that the format is unsupported', async () => {
    vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'active' })
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease('playlist')} name="live/live.m3u8" onRetry={() => {}} />)
    define(media(), { videoWidth: 1280, videoHeight: 720, duration: Number.POSITIVE_INFINITY })
    await act(async () => { media().dispatchEvent(new Event('loadeddata')) })
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Playback stopped')
    expect(container.textContent).not.toContain('Format not supported')
  })

  it('fits the stage to the picture so the controls sit on it, not on letterbox black', async () => {
    const observers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback) } observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1000)
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="wide.mp4" onRetry={() => {}} />)
    define(media(), { videoWidth: 1920, videoHeight: 1080, duration: 30 })
    await act(async () => { media().dispatchEvent(new Event('loadedmetadata')) })
    const stage = container.querySelector<HTMLElement>('.media-player__stage')!
    expect(stage.hasAttribute('data-fitted')).toBe(true)
    expect(stage.style.getPropertyValue('--media-fit-width')).toBe('1000px')
    expect(stage.style.getPropertyValue('--media-fit-height')).toBe('562px')
    expect(stage.querySelector('.media-player__controls')).not.toBeNull()
  })

  it('video with no decodable picture says so and moves to the audio card without reloading the element', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="voice.mp4" onRetry={() => {}} />)
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
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="cached.mp4" onRetry={() => {}} />)
      expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
    } finally {
      if (original) Object.defineProperty(HTMLMediaElement.prototype, 'readyState', original); else delete (HTMLMediaElement.prototype as { readyState?: number }).readyState
      delete (HTMLMediaElement.prototype as { videoWidth?: number }).videoWidth; delete (HTMLMediaElement.prototype as { videoHeight?: number }).videoHeight
    }
  })

  it('a double click on the picture enters full screen and leaves play state as it was', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const video = media()
    let paused = true
    define(video, { ended: false })
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() => { paused = false; return Promise.resolve() })
    vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(() => { paused = true })
    const fullscreen = vi.fn(() => Promise.resolve())
    Object.defineProperty(container.querySelector('[role="group"]')!, 'requestFullscreen', { configurable: true, value: fullscreen })
    // A browser delivers a double click as click, click, dblclick.
    for (const type of ['click', 'click', 'dblclick']) await act(async () => { video.dispatchEvent(new MouseEvent(type, { bubbles: true })) })
    expect(paused).toBe(true)
    expect(fullscreen).toHaveBeenCalledTimes(1)
  })

  it('a resumed position applies even when metadata arrived before the listeners', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState')
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get() { return 1 } })
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get() { return 600 } })
    let time = 0
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get() { return time }, set(value: number) { time = value } })
    try {
      const resume = { current: { time: 321, volume: 0.3, muted: true, rate: 2 } }
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="cached.mp4" onRetry={() => {}} resume={resume} />)
      expect(time).toBe(321); expect(media().muted).toBe(true); expect(media().playbackRate).toBe(2)
      expect(resume.current).toBeNull()
    } finally {
      if (original) Object.defineProperty(HTMLMediaElement.prototype, 'readyState', original); else delete (HTMLMediaElement.prototype as { readyState?: number }).readyState
      delete (HTMLMediaElement.prototype as { duration?: number }).duration; delete (HTMLMediaElement.prototype as { currentTime?: number }).currentTime
    }
  })

  it('an audio file uses the always-visible card with a primary play disc', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease('audio')} name="music/track.mp3" onRetry={() => {}} />)
    expect(media().tagName).toBe('AUDIO')
    expect(container.querySelector('.media-player__card')).not.toBeNull()
    expect(container.querySelector('.media-player__primary')?.getAttribute('aria-label')).toBe('Play')
  })

  it('an audio player keeps no empty picture stage on screen', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease('audio')} name="music/track.mp3" onRetry={() => {}} />)
    // The element hidden for audio is the one whose own display rule must yield to [hidden].
    const hidden = [...container.querySelectorAll<HTMLElement>('[hidden]')].filter(element => element.querySelector('.media-player__stage'))
    expect(hidden).toHaveLength(1)
    const owner = [...hidden[0]!.classList].find(name => name.startsWith('media-player__'))!
    const rules = stripCssComments(readStyleSheet('@agentmux/editor-extensions/styles/media-player.css'))
    expect(rules).toMatch(new RegExp(`\\.${owner}\\[hidden\\]\\s*\\{\\s*display:\\s*none;?\\s*\\}`))
  })

  it('a narrow Region never hides part of the time readout, which would run the two clocks together', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { duration: 90 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    const time = container.querySelector('.media-player__time')!
    expect(time.textContent).toBe('0:00 / 1:30')
    const parts = new Set([...time.querySelectorAll('*')].flatMap(element => [...element.classList]))
    const rules = stripCssComments(readStyleSheet('@agentmux/editor-extensions/styles/media-player.css'))
    const hidden = [...rules.matchAll(/([^{}]+)\{[^{}]*display:\s*none/g)].flatMap(match => match[1]!.split(',').map(selector => selector.trim()))
    for (const selector of hidden) for (const part of parts) expect(selector, `${selector} hides ${part}`).not.toMatch(new RegExp(`\\.${part}(?![\\w-])`))
  })

  it('leaving stops reading: pause, drop the source and reload the empty element', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const video = media()
    await act(async () => root.render(<></>))
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(video.hasAttribute('src')).toBe(false)
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
  })

  it('the timeline lives inside the bar, so there is no empty capsule beside the controls', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { duration: 90 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    const bar = container.querySelector('.media-player__bar')!
    const timeline = container.querySelector('.media-player__timeline')!
    // The timeline is a child of the bar; the controls are not two stacked rows with empty space between.
    expect(bar.contains(timeline)).toBe(true)
    expect(timeline.parentElement).toBe(bar)
  })

  it('a paused player past its first frame still shows the play disc, not a blank stage', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const video = media()
    let paused = true
    define(video, { ended: false, duration: 30 })
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 10 })
    // First frame decoded, then started, then paused again — the disc must still be there.
    await act(async () => { video.dispatchEvent(new Event('loadeddata')) })
    paused = false
    await act(async () => { video.dispatchEvent(new Event('play')) })
    paused = true
    await act(async () => { video.dispatchEvent(new Event('pause')) })
    const disc = container.querySelector('.media-player__start')
    expect(disc).not.toBeNull()
    expect(disc!.getAttribute('aria-label')).toBe('Play')
  })

  it('a failure surfaces a solid primary Retry button, not a small inline one', async () => {
    vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'deleted', path: 'clip.mp4' })
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { error: { code: 4 } })
    await act(async () => { media().dispatchEvent(new Event('error')) })
    const retry = container.querySelector('.media-player__retry')
    expect(retry).not.toBeNull()
    expect(retry!.textContent).toBe('Retry')
    // The deprecated small-button retry must be gone for this player.
    expect(container.querySelector('.media-player__failure .small-button')).toBeNull()
  })

  it('pointing along the timeline re-renders the timeline only, never the player around it', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { duration: 600 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    layout()
    // The first move may let React re-run the player once to confirm its idle timer state is unchanged.
    await point(260)
    const renders = vi.mocked(formatFileBytes).mock.calls.length
    for (const x of [320, 380, 440, 500]) await point(x)
    expect(bubble()!.textContent).toBe('5:00')
    expect(vi.mocked(formatFileBytes).mock.calls.length).toBe(renders)
  })

  it('the pointed time is the one a press there lands on: over the thumb’s travel and on the native step', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { duration: 600 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    layout()
    timeline().style.setProperty('--media-thumb', '12px')
    // A 12px thumb's centre travels 206–794px: its ends are the first and the last second, and the bubble sits on the pointed spot.
    await point(206)
    expect(bubble()!.textContent).toBe('0:00')
    await point(794)
    expect(bubble()!.textContent).toBe('10:00'); expect(bubble()!.style.left).toBe('602px')
    expect(Number.parseFloat(timeline().style.getPropertyValue('--media-hover'))).toBeCloseTo(99)
    // 499.1px is step 498.47 of 1000, which the range rounds to 498: 298.8 s, not the 299.08 s in between.
    await point(499.1)
    expect(bubble()!.textContent).toBe('4:58')
  })
})
