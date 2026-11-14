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
import { classifyStream, createSeekQueue, describeMediaFailure, liveEdgeState, resolveMediaKey, seekableWindow, timelinePreviewAvailable, type MediaKeyEvent } from '@agentmux/editor-extensions/engines/media-player'
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

describe('timeline frame preview', () => {
  it('previews only a single on-demand video file with a decoded picture', () => {
    expect(timelinePreviewAvailable('video', 'on-demand', true)).toBe(true)
    for (const source of ['audio', 'playlist'] as const) expect(timelinePreviewAvailable(source, 'on-demand', true), source).toBe(false)
    for (const stream of ['live', 'live-window', 'unknown'] as const) expect(timelinePreviewAvailable('video', stream, true), stream).toBe(false)
    // A video without a picture and one whose main playback failed have no decoded picture to preview.
    expect(timelinePreviewAvailable('video', 'on-demand', false)).toBe(false)
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
  // An element whose seeks finish only when the test says so, like an engine still decoding, and whose
  // play and pause report back through their own events.
  async function engine(element: HTMLMediaElement, facts: { paused: boolean; duration: number; picture?: boolean }) {
    const state = { paused: facts.paused, time: 0, seeking: false, seeks: [] as number[] }
    const picture = facts.picture ?? true
    define(element, { duration: facts.duration, ended: false, videoWidth: picture ? 1280 : 0, videoHeight: picture ? 720 : 0 })
    Object.defineProperty(element, 'paused', { configurable: true, get: () => state.paused })
    Object.defineProperty(element, 'seeking', { configurable: true, get: () => state.seeking })
    Object.defineProperty(element, 'currentTime', { configurable: true, get: () => state.time,
      set: (value: number) => { state.time = value; state.seeking = true; state.seeks.push(value) } })
    vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (this: HTMLMediaElement) {
      if (this !== element || state.paused) return
      state.paused = true; queueMicrotask(() => element.dispatchEvent(new Event('pause')))
    })
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
      if (this === element && state.paused) { state.paused = false; queueMicrotask(() => element.dispatchEvent(new Event('play'))) }
      return Promise.resolve()
    })
    await act(async () => { for (const type of ['loadedmetadata', 'durationchange', 'loadeddata']) element.dispatchEvent(new Event(type)) })
    return { state, async seeked() { state.seeking = false; await act(async () => { element.dispatchEvent(new Event('seeked')) }) } }
  }
  async function slide(value: number) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(timeline(), String(value))
      timeline().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function press(type: 'pointerdown' | 'pointerup' | 'pointercancel', clientX?: number) {
    await act(async () => { timeline().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...(clientX === undefined ? {} : { clientX }) })) })
  }
  const announced = () => container.querySelector('.media-player__announcer')!.textContent
  function timeline() { return container.querySelector<HTMLInputElement>('.media-player__slider')! }
  // The track runs 200–800px inside a 1000px stage whose top is `room` px above it: with a 600 s file, x - 200 is the second.
  function layout(room = 400) {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this } }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('media-player__slider')) return rect(200, 500, 600, 20)
      if (this.classList.contains('media-player__timeline')) return rect(192, 500, 616, 20)
      return rect(0, 500 - room, 1000, room + 50)
    })
  }
  async function point(clientX: number) {
    await act(async () => { timeline().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, pointerId: 1 })) })
  }
  const bubble = () => container.querySelector<HTMLElement>('.media-player__bubble')
  const spot = () => container.querySelector<HTMLElement>('.media-player__preview')
  // React derives leaving from pointerout and the element the pointer went to.
  async function leave() {
    await act(async () => { timeline().dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body, pointerId: 1 })) })
  }
  const frameShown = () => spot()?.hasAttribute('data-frame') ?? false
  const decoderElement = () => container.querySelector<HTMLVideoElement>('.media-player__preview video')
  // The preview decoder, whose seeks finish only when the test says so.
  function decoder() {
    const element = decoderElement()!
    const state = { time: 0, seeking: false, seeks: [] as number[] }
    Object.defineProperty(element, 'seeking', { configurable: true, get: () => state.seeking })
    Object.defineProperty(element, 'currentTime', { configurable: true, get: () => state.time,
      set: (value: number) => { state.time = value; state.seeking = true; state.seeks.push(value) } })
    return { element, state,
      async ready() { await act(async () => { element.dispatchEvent(new Event('loadedmetadata')) }) },
      async seeked() { state.seeking = false; await act(async () => { element.dispatchEvent(new Event('seeked')) }) } }
  }
  const loaded = () => vi.mocked(HTMLMediaElement.prototype.load).mock.contexts
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

  it('pointing along the timeline re-renders the timeline only, never the player around it, and reads the thumb once', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    define(media(), { duration: 600 })
    await act(async () => { media().dispatchEvent(new Event('durationchange')) })
    layout()
    const renders = () => vi.mocked(formatFileBytes).mock.calls.length
    // The count does see a player render: a changed media fact renders the player.
    const before = renders()
    define(media(), { volume: 0.5 })
    await act(async () => { media().dispatchEvent(new Event('volumechange')) })
    expect(renders()).toBeGreaterThan(before)
    const settled = renders(), reads = vi.spyOn(CSSStyleDeclaration.prototype, 'getPropertyValue')
    for (let x = 210; x <= 500; x += 10) await point(x)
    expect(bubble()!.textContent).toBe('5:00')
    expect(renders()).toBe(settled)
    expect(reads.mock.calls.filter(([name]) => name === '--media-thumb')).toHaveLength(1)
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
    expect(bubble()!.textContent).toBe('10:00'); expect(spot()!.style.getPropertyValue('--media-preview-x')).toBe('602px')
    expect(Number.parseFloat(timeline().style.getPropertyValue('--media-hover'))).toBeCloseTo(99)
    // 499.1px is step 498.47 of 1000, which the range rounds to 498: 298.8 s, not the 299.08 s in between.
    await point(499.1)
    expect(bubble()!.textContent).toBe('4:58')
  })

  it('a held drag on a playing video moves the picture one seek at a time, lands where released and plays on unannounced', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const { state, seeked } = await engine(media(), { paused: false, duration: 600 })
    await press('pointerdown')
    expect(state.paused).toBe(true)
    // The hold is not a pause the person asked for: the control keeps the playback the release brings back, and no play disc covers the picture.
    expect(container.querySelector('button[aria-label="Pause"]')).not.toBeNull()
    expect(container.querySelector('.media-player__start')).toBeNull()
    for (const value of [100, 200, 300]) await slide(value)
    expect(state.seeks).toEqual([60])
    await seeked()
    expect(state.seeks).toEqual([60, 180])
    await slide(400)
    await press('pointerup')
    expect(state.seeks).toEqual([60, 180, 240])
    // The time that waited behind the superseded seek is not sent once the landing settles.
    await seeked()
    expect(state.seeks).toEqual([60, 180, 240])
    expect(state.paused).toBe(false)
    expect(announced()).toBe('')
  })

  it('a press lands on the pointed time even on the thumb itself, which a native range only grabs', async () => {
    for (const kind of ['video', 'audio'] as const) {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease(kind)} name={`${kind}.mp4`} onRetry={() => {}} />)
      const { state } = await engine(media(), { paused: true, duration: 600 })
      layout()
      timeline().style.setProperty('--media-thumb', '12px')
      // happy-dom's range never moves on a press, like Chromium's when the press is on the thumb.
      await act(async () => { timeline().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 499.1 })) })
      expect(timeline().value, kind).toBe('498')
      await press('pointerup')
      expect(state.seeks, kind).toHaveLength(1)
      expect(state.seeks[0], kind).toBeCloseTo(298.8, 6)
      await act(async () => root.render(<></>))
    }
  })

  it('a paused video stays paused after a drag; a key let go mid-drag does not end it, and a cancelled pointer lands like a release', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const { state } = await engine(media(), { paused: true, duration: 600 })
    await press('pointerdown')
    await slide(500); await slide(600)
    expect(state.seeks).toEqual([300])
    await act(async () => { timeline().dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true })) })
    expect(state.seeks).toEqual([300])
    await press('pointercancel')
    expect(state.seeks).toEqual([300, 360])
    expect(state.paused).toBe(true)
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  })

  it('audio and a video without a picture keep playing while held and jump on release only', async () => {
    for (const [kind, picture] of [['audio', true], ['video', false]] as const) {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease(kind)} name={`${kind}.mp4`} onRetry={() => {}} />)
      const { state } = await engine(media(), { paused: false, duration: 600, picture })
      await press('pointerdown')
      await slide(100); await slide(200)
      expect(state.seeks, kind).toEqual([])
      expect(state.paused, kind).toBe(false)
      await press('pointerup')
      expect(state.seeks, kind).toEqual([120])
      await act(async () => root.render(<></>))
    }
  })

  it('a keyboard scrub on the timeline lands on key release', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const { state } = await engine(media(), { paused: true, duration: 600 })
    await slide(700)
    expect(state.seeks).toEqual([])
    await act(async () => { timeline().dispatchEvent(new KeyboardEvent('keyup', { key: 'PageUp', bubbles: true })) })
    expect(state.seeks).toEqual([420])
  })

  it('releasing a playing video at its very end leaves it ended instead of starting over', async () => {
    await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
    const { state, seeked } = await engine(media(), { paused: false, duration: 600 })
    await press('pointerdown')
    await slide(1000)
    await seeked()
    await press('pointerup')
    expect(state.seeks).toEqual([600])
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  })

  describe('frame preview', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })
    // The pointer stays on the timeline; by default just long enough for a frame preview.
    async function stay(ms = 150) { await act(async () => { vi.advanceTimersByTime(ms) }) }

    it('makes a decoder only once the pointer stays on the timeline: muted, metadata only, unfocusable and over the lease', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout()
      expect(decoderElement()).toBeNull()
      // A pointer crossing the timeline on its way elsewhere makes none.
      await point(500); await stay(100); await leave(); await stay(1_000)
      expect(decoderElement()).toBeNull()
      await point(500); await stay(149)
      expect(decoderElement()).toBeNull()
      await stay(1)
      const unit = spot()!, video = decoderElement()!
      expect(video.getAttribute('src')).toBe(lease().url); expect(video.muted).toBe(true); expect(video.getAttribute('preload')).toBe('metadata')
      expect(video.tabIndex).toBe(-1); expect(video.hasAttribute('crossorigin')).toBe(false)
      expect(video.hasAttribute('disablepictureinpicture')).toBe(true); expect(video.hasAttribute('disableremoteplayback')).toBe(true)
      expect(container.querySelectorAll('video')).toHaveLength(2)
      expect(unit.getAttribute('aria-hidden')).toBe('true'); expect(unit.textContent).toBe('5:00'); expect(frameShown()).toBe(false)
      expect(unit.style.getPropertyValue('--media-preview-x')).toBe('308px')
      expect([unit.style.getPropertyValue('--media-preview-lo'), unit.style.getPropertyValue('--media-preview-hi')]).toEqual(['-192px', '808px'])
      expect(unit.style.getPropertyValue('--media-preview-room')).toBe('400px')
      expect(Number(unit.style.getPropertyValue('--media-preview-ratio'))).toBeCloseTo(16 / 9)
    })

    it('the decoder seeks only the newest pointed time once it has metadata, one seek at a time, and shows the frame once that seek lands', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout()
      await point(260); await stay(); await point(320)
      const preview = decoder()
      expect(preview.state.seeks).toEqual([])
      await preview.ready()
      expect(preview.state.seeks).toEqual([120])
      await point(380); await point(440)
      expect(preview.state.seeks).toEqual([120]); expect(frameShown()).toBe(false)
      await preview.seeked()
      // The landed frame shows while the newest time is still on its way.
      expect(preview.state.seeks).toEqual([120, 240]); expect(frameShown()).toBe(true)
    })

    it('leaving keeps the decoder a moment for a return, which shows time only until its own seek lands; then the file is let go', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout()
      await point(500); await stay()
      const preview = decoder()
      await preview.ready(); await preview.seeked()
      expect(frameShown()).toBe(true)
      await leave()
      expect(frameShown()).toBe(false); expect(spot()!.hasAttribute('data-idle')).toBe(true)
      await stay(2_900)
      expect(decoderElement()).toBe(preview.element)
      // A return seeks at once, without another dwell.
      await point(560)
      expect(preview.state.seeks).toEqual([300, 360]); expect(frameShown()).toBe(false)
      await preview.seeked()
      expect(frameShown()).toBe(true)
      // The return called off the release that leaving had started.
      await stay(1_000)
      expect(decoderElement()).toBe(preview.element)
      await leave(); await stay(3_000)
      expect(spot()).toBeNull()
      expect(preview.element.hasAttribute('src')).toBe(false); expect(loaded()).toContain(preview.element)
    })

    it('a frame from an earlier pointing never shows; a pointed time the decoder rests on or is already seeking to counts as asked for now', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout()
      await point(500); await stay()
      const preview = decoder()
      await preview.ready()
      await leave(); await point(320)
      await preview.seeked()
      expect(frameShown()).toBe(false); expect(preview.state.seeks).toEqual([300, 120])
      await preview.seeked()
      expect(frameShown()).toBe(true)
      await leave(); await point(320)
      expect(frameShown()).toBe(true)
      await point(380); await leave(); await point(380)
      expect(frameShown()).toBe(false)
      await preview.seeked()
      expect(frameShown()).toBe(true); expect(preview.state.seeks).toEqual([300, 120, 180])
    })

    it('a held drag hides the frame and keeps the time; after it, pointing previews again with the same decoder', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout()
      await point(500); await stay()
      const preview = decoder()
      await preview.ready(); await preview.seeked()
      await press('pointerdown', 500)
      expect(frameShown()).toBe(false); expect(bubble()!.textContent).toBe('5:00')
      await point(560)
      expect(bubble()!.textContent).toBe('6:00'); expect(preview.state.seeks).toEqual([300])
      await press('pointerup', 560)
      await point(620)
      expect(decoderElement()).toBe(preview.element); expect(preview.state.seeks).toEqual([300, 420])
      await preview.seeked()
      expect(frameShown()).toBe(true)
    })

    it('the controls idling away and the document hiding each end a pointing as leaving does', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: false, duration: 600 }); layout()
      await point(500); await stay()
      const first = decoder()
      await first.ready(); await first.seeked()
      expect(frameShown()).toBe(true)
      await stay(2_000)
      expect(container.querySelector('.media-player')!.getAttribute('data-controls')).toBe('hidden')
      expect(spot()!.hasAttribute('data-idle')).toBe(true); expect(frameShown()).toBe(false)
      await stay(3_000)
      expect(decoderElement()).toBeNull(); expect(first.element.hasAttribute('src')).toBe(false)
      await point(500); await stay()
      const second = decoder()
      await second.ready(); await second.seeked()
      expect(frameShown()).toBe(true)
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      try {
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        expect(spot()!.hasAttribute('data-idle')).toBe(true); expect(frameShown()).toBe(false)
        await stay(3_000)
        expect(decoderElement()).toBeNull(); expect(second.element.hasAttribute('src')).toBe(false)
      } finally { delete (document as { visibilityState?: unknown }).visibilityState }
    })

    it('main playback failing drops the decoder as the failure shows', async () => {
      vi.spyOn(api.files, 'mediaStreamStatus').mockResolvedValue({ state: 'active' })
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout()
      await point(500); await stay()
      const preview = decoder()
      define(media(), { error: { code: 4 } })
      await act(async () => { media().dispatchEvent(new Event('error')) })
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(decoderElement()).toBeNull()
      expect(preview.element.hasAttribute('src')).toBe(false); expect(loaded()).toContain(preview.element)
    })

    it('a failed preview folds only its frame away for the rest of that pointing; the next pointing tries again and main playback is untouched', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      const main = await engine(media(), { paused: false, duration: 600 }); layout()
      await point(500); await stay()
      const failed = decoder()
      await act(async () => { failed.element.dispatchEvent(new Event('error')) })
      expect(decoderElement()).toBeNull(); expect(failed.element.hasAttribute('src')).toBe(false)
      expect(bubble()!.textContent).toBe('5:00')
      await point(560); await stay(1_000)
      expect(decoderElement()).toBeNull()
      await leave(); await point(500); await stay()
      expect(decoderElement()).not.toBeNull(); expect(decoderElement()).not.toBe(failed.element)
      expect(main.state.seeks).toEqual([]); expect(main.state.paused).toBe(false)
      expect(container.querySelector('[role="alert"]')).toBeNull(); expect(announced()).toBe('')
      expect(container.querySelector('.media-player')!.getAttribute('data-decode-state')).toBe('ready')
    })

    it('audio, HLS playlists, live streams and a video without a picture point at time only', async () => {
      for (const [kind, duration, picture] of [['audio', 600, true], ['playlist', 600, true], ['playlist', Number.POSITIVE_INFINITY, true], ['video', 600, false]] as const) {
        const label = `${kind} ${duration} ${picture ? 'picture' : 'no picture'}`
        await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease(kind)} name={label} onRetry={() => {}} />)
        define(media(), { seekable: ranges([0, 600]) })
        await engine(media(), { paused: true, duration, picture }); layout()
        await point(500); await stay(1_000)
        expect(decoderElement(), label).toBeNull()
        expect(bubble()?.textContent, label).toMatch(/\d:\d\d/)
        expect(spot()!.style.getPropertyValue('--media-bubble-ch'), label).toBe(String(bubble()!.textContent!.length))
        // Without a frame the time still stops at the player's sides, not the timeline's.
        expect([spot()!.style.getPropertyValue('--media-preview-lo'), spot()!.style.getPropertyValue('--media-preview-hi')], label).toEqual(['-192px', '808px'])
        await act(async () => root.render(<></>))
      }
    })

    it('a player with too little room above the timeline for a readable frame points at time only', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout(119)
      await point(500); await stay(1_000)
      expect(decoderElement()).toBeNull(); expect(bubble()!.textContent).toBe('5:00')
      // The time alone stays inside the player's sides too, as wide as its digits.
      expect(spot()!.style.getPropertyValue('--media-bubble-ch')).toBe('4')
      expect([spot()!.style.getPropertyValue('--media-preview-lo'), spot()!.style.getPropertyValue('--media-preview-hi')]).toEqual(['-192px', '808px'])
      await leave(); layout(120)
      await point(500); await stay()
      expect(decoderElement()).not.toBeNull()
    })

    it('a new lease or leaving the File drops the preview source before the element goes', async () => {
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={lease()} name="clip.mp4" onRetry={() => {}} />)
      await engine(media(), { paused: true, duration: 600 }); layout()
      await point(500); await stay()
      const first = decoderElement()!
      const next = { ...lease(), id: 'lease-next', url: 'http://127.0.0.1:1/lease-next/clip' }
      await render(<MediaPlayer readStatus={api.files.mediaStreamStatus} lease={next} name="clip.mp4" onRetry={() => {}} />)
      expect(first.hasAttribute('src')).toBe(false); expect(loaded()).toContain(first)
      expect(decoderElement()).toBeNull()
      await point(500); await stay()
      const second = decoderElement()!
      expect(second.getAttribute('src')).toBe(next.url)
      await act(async () => root.render(<></>))
      expect(second.hasAttribute('src')).toBe(false); expect(loaded()).toContain(second)
    })

    it('the frame takes the picture’s shape, stops inside the player’s sides, shrinks when narrow and holds still for reduced motion', () => {
      const rules = stripCssComments(readStyleSheet('@agentmux/editor-extensions/styles/media-player.css'))
      const block = (start: string) => { const from = rules.indexOf(start); let depth = 0, at = rules.indexOf('{', from)
        for (let index = at; index < rules.length; index++) { depth += rules[index] === '{' ? 1 : rules[index] === '}' ? -1 : 0; if (depth === 0) { at = index; break } }
        return rules.slice(from, at + 1) }
      expect(rules).toMatch(/\.media-player__preview-frame\s*\{[^}]*aspect-ratio:\s*var\(--media-preview-ratio\)/)
      // A player shrinking under a shown frame folds it to nothing instead of letting it fall back to the picture's own size.
      expect(rules).toMatch(/--media-preview-height:\s*min\(var\(--media-preview-tall\),\s*max\(0px,\s*calc\(var\(--media-preview-room/)
      // The pointed unit stops inside the player's sides by its half width: the time's alone, or with a frame the wider of the two.
      expect(block('.media-player__preview {')).toMatch(/left:\s*clamp\(calc\(var\(--media-preview-lo[^;]*var\(--media-preview-half\)[^;]*var\(--media-preview-x[^;]*calc\(var\(--media-preview-hi[^;]*var\(--media-preview-half\)/)
      expect(block('.media-player__preview {')).toMatch(/--media-preview-half:\s*calc\(var\(--media-bubble-ch/)
      expect(rules).toMatch(/\.media-player__preview\[data-frame\]\s*\{\s*--media-preview-half:\s*max\(calc\(var\(--media-preview-width\)\s*\/\s*2\)/)
      // A shown frame never covers the start disc: the disc gives way.
      expect(rules).toMatch(/\.media-player:has\(\.media-player__preview\[data-frame\]\)\s*\.media-player__start\s*\{[^}]*opacity:\s*0/)
      expect(rules).toMatch(/\.media-player__preview:not\(\[data-frame\]\)\s*>\s*\.media-player__preview-frame\s*\{[^}]*visibility:\s*hidden/)
      expect(block('@container (max-width: 511px)')).toMatch(/\.media-player__preview\s*\{[^}]*--media-preview-tall/)
      expect(block('@media (prefers-reduced-motion: reduce)')).toMatch(/\.media-player__preview-frame\s*\{\s*transition:\s*none/)
      expect(block('@media (prefers-reduced-transparency: reduce)')).toContain('.media-player__bubble')
    })
  })
})
