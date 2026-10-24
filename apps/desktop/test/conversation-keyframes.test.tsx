import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useConversationKeyframes } from '../src/renderer/src/lib/use-conversation-keyframes'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import type { RulerRecord } from '../src/renderer/src/lib/conversation-ruler'

let root: Root, host: HTMLDivElement, feed: HTMLDivElement, visible: (target: Element, value: boolean) => void
let records: RulerRecord[], frames: ReadonlyMap<string, string>, draw: ReturnType<typeof vi.fn>, encoded: number
function record(session = 'session', content = 'image') {
  return { id: 'record', kind: 'ruler-record', sourceKey: conversationMessageSourceKey(session, { kind: 'captured', recordId: 'original' }),
    speaker: { role: 'agent', id: session }, target: { kind: 'observed', index: 0 }, record: { id: 'original', kind: 'assistant_message', agentSessionId: session, content } } as RulerRecord
}
function Probe({ session = 'session', active = true }: { session?: string; active?: boolean }) {
  frames = useConversationKeyframes(feed, session, active, records)
  return null
}
function image(className = 'md-diagram-image__thumb', sourceKey = records[0]!.sourceKey!) {
  const message = document.createElement('div'); message.dataset.messageSourceKey = sourceKey
  const img = document.createElement('img'); img.className = className; img.src = 'blob:original'
  message.append(img); feed.append(message)
  return img
}
beforeEach(() => {
  encoded = 0; records = [record()]; draw = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) {
    visible = (target, value) => callback([{ target, isIntersecting: value } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  } observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 200, 100)] as unknown as DOMRectList)
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1600)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(900)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: draw }) as any)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => `data:image/webp;base64,frame${++encoded}`)
  host = document.createElement('div'); feed = document.createElement('div'); document.body.append(host, feed); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); feed.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('caches only an already visible decoded visual under the exact original source and does no work on scroll', async () => {
  const img = image(), avatar = image('conversation-avatar'), other = image('md-diagram-image__thumb', conversationMessageSourceKey('other', { kind: 'captured', recordId: 'original' })!)
  await act(async () => root.render(<Probe />))
  expect(frames.size).toBe(0); expect(draw).not.toHaveBeenCalled()
  await act(async () => visible(img, true))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame1')
  expect(draw).toHaveBeenCalledExactlyOnceWith(img, 0, 0, 128, 72)
  await act(async () => { visible(other, true); avatar.dispatchEvent(new Event('load')); feed.dispatchEvent(new Event('scroll')) })
  expect(draw).toHaveBeenCalledTimes(1)
})
it('invalidates on URL or content changes and requires a new decoded observation', async () => {
  const img = image()
  await act(async () => root.render(<Probe />))
  await act(async () => visible(img, true))
  await act(async () => { img.src = 'blob:next'; await new Promise(done => setTimeout(done, 0)) })
  expect(frames.size).toBe(0)
  expect(draw).toHaveBeenCalledTimes(1)
  await act(async () => img.dispatchEvent(new Event('load')))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame2')
  records = [record('session', 'changed body')]
  await act(async () => root.render(<Probe />))
  expect(frames.size).toBe(0)
})
it('isolates sessions and evicts records outside the current loaded reading window', async () => {
  const img = image()
  await act(async () => root.render(<Probe />))
  await act(async () => visible(img, true))
  records = [record('new-session')]
  await act(async () => root.render(<Probe session="new-session" />))
  expect(frames.size).toBe(0)
  await act(async () => visible(img, true))
  expect(draw).toHaveBeenCalledTimes(1)
  records = []
  await act(async () => root.render(<Probe session="new-session" />))
  expect(frames.size).toBe(0)
})
it('does not draw hidden, inert, unreadable or tainted content and keeps its original surface', async () => {
  const img = image()
  await act(async () => root.render(<Probe />))
  feed.inert = true
  await act(async () => visible(img, true))
  expect(draw).not.toHaveBeenCalled()
  feed.inert = false
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false)
  await act(async () => visible(img, true))
  expect(draw).not.toHaveBeenCalled()
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  draw.mockImplementation(() => { throw new Error('Tainted canvas') })
  await act(async () => img.dispatchEvent(new Event('load')))
  expect(frames.size).toBe(0)
  expect(feed.contains(img)).toBe(true)
})
it('retains a native cached frame through an unchanged Core revision and invalidates the changed source revision', async () => {
  records = [{ ...record(), revision: 'original-revision', record: { contentParts: [{ kind: 'text', text: 'original' }] } } as RulerRecord]
  const img = image()
  await act(async () => root.render(<Probe />))
  await act(async () => visible(img, true))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame1')
  records = [{ ...records[0]!, record: { contentParts: [{ kind: 'text', text: 'original' }] } } as RulerRecord]
  await act(async () => root.render(<Probe />))
  // IntersectionObserver delivers an initial intersection again after the effect re-observes.
  await act(async () => visible(img, true))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame1')
  expect(draw).toHaveBeenCalledTimes(1)
  expect(encoded).toBe(1)
  records = [{ ...records[0]!, revision: 'updated-revision' }]
  await act(async () => root.render(<Probe />))
  expect(frames.size).toBe(0)
})
it('recaptures an evicted frame and a new decoded image instead of retaining a sticky captured flag', async () => {
  const img = image(), original = records[0]!
  await act(async () => root.render(<Probe />))
  await act(async () => visible(img, true))
  records = []
  await act(async () => root.render(<Probe />))
  expect(frames.size).toBe(0)
  records = [original]
  await act(async () => root.render(<Probe />))
  await act(async () => visible(img, true))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame2')
  await act(async () => img.dispatchEvent(new Event('load')))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame3')
  expect(encoded).toBe(3)
})
it.each(['video', 'canvas'] as const)('captures a fresh %s frame on actual visibility leave while skipping observer refreshes', async tag => {
  const message = document.createElement('div'); message.dataset.messageSourceKey = records[0]!.sourceKey!
  const page = document.createElement('section'); page.dataset.conversationKeyframe = 'navigation'
  const media = document.createElement(tag); page.append(media); message.append(page); feed.append(message)
  if (tag === 'video') Object.defineProperties(media, { videoWidth: { value: 800 }, videoHeight: { value: 600 }, readyState: { value: 2 } })
  else { (media as HTMLCanvasElement).width = 800; (media as HTMLCanvasElement).height = 600 }
  await act(async () => root.render(<Probe />))
  await act(async () => visible(media, true))
  records = [...records]
  await act(async () => root.render(<Probe />))
  await act(async () => visible(media, true))
  expect(encoded).toBe(1)
  await act(async () => visible(media, false))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame2')
  await act(async () => visible(media, true))
  expect(encoded).toBe(2)
  if (tag === 'video') {
    await act(async () => media.dispatchEvent(new Event('loadeddata')))
    expect(frames.get('record')).toBe('data:image/webp;base64,frame3')
  }
})
it('does not capture unseen video or run a video frame loop', async () => {
  const message = document.createElement('div'); message.dataset.messageSourceKey = records[0]!.sourceKey!
  const page = document.createElement('section'); page.dataset.conversationKeyframe = 'navigation'
  const video = document.createElement('video'); page.append(video); message.append(page); feed.append(message)
  Object.defineProperties(video, { videoWidth: { value: 800 }, videoHeight: { value: 600 }, readyState: { value: 2 } })
  await act(async () => root.render(<Probe />))
  await act(async () => visible(video, false))
  expect(draw).not.toHaveBeenCalled()
  await act(async () => visible(video, true))
  expect(draw).toHaveBeenCalledExactlyOnceWith(video, 0, 0, 107, 80)
  await act(async () => { page.dataset.conversationKeyframe = 'next-navigation'; await new Promise(done => setTimeout(done, 0)) })
  expect(frames.size).toBe(0)
  expect(draw).toHaveBeenCalledTimes(1)
  await act(async () => { visible(video, false); visible(video, true) })
  expect(frames.size).toBe(0)
  expect(draw).toHaveBeenCalledTimes(1)
  records = [...records]
  await act(async () => root.render(<Probe />))
  await act(async () => visible(video, true))
  expect(frames.size).toBe(0)
  await act(async () => root.render(<Probe active={false} />))
  await act(async () => root.render(<Probe />))
  await act(async () => visible(video, true))
  expect(frames.size).toBe(0)
  expect(draw).toHaveBeenCalledTimes(1)
  await act(async () => video.dispatchEvent(new Event('loadeddata')))
  expect(frames.get('record')).toBe('data:image/webp;base64,frame2')
})
