// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { Window } from 'happy-dom'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import { recordedToolEdit } from '../../core/test/fixtures/recorded-tool-edits'
import * as diffs from '../src/lib/conversation-tool-diff'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as markdown from '../src/lib/agent-markdown'
import { projectConversationReading } from '../src/lib/conversation-records'
import { ConversationMessage } from '../src/components/ConversationMessage'
import { ConversationView } from '../src/components/ConversationView'
import { conversationMessageSourceKey } from '../src/lib/conversation-message-location'
import { ClientUiProvider } from '../src/platform'
import { consumeProgrammaticReadingScroll } from '../src/lib/reading-scroll'
import type { AgentSessionHistoryPage } from '@agentmux/core'

class Visibility {
  static all: Visibility[] = []
  targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { Visibility.all.push(this) }
  observe(node: Element) { this.targets.add(node) }
  unobserve(node: Element) { this.targets.delete(node) }
  disconnect() { this.targets.clear() }
  emit(indices: number[], intersecting = true) {
    const entries = [...this.targets].filter(node => indices.includes(recordIndex(node))).map(target => ({ target, isIntersecting: intersecting, boundingClientRect: target.getBoundingClientRect() }))
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}
class Sizes {
  static all: Sizes[] = []
  targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { Sizes.all.push(this) }
  observe(node: Element) { this.targets.add(node) }
  unobserve(node: Element) { this.targets.delete(node) }
  disconnect() { this.targets.clear() }
  emit() { this.callback([...this.targets].map(target => ({ target })) as ResizeObserverEntry[], this as unknown as ResizeObserver) }
}
function recordIndex(node: Element): number {
  const element = node.closest('[data-native-record-id], [data-captured-process-id]')
  return Number((element?.getAttribute('data-native-record-id') ?? element?.getAttribute('data-captured-process-id'))?.match(/record-(\d+)/)?.[1] ?? -1)
}
const box = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 640, width: 640, height, toJSON() {} }) as DOMRect
let frames: Map<number, FrameRequestCallback>, frameId = 0
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, heights: Map<number, number>, expanded: Map<number, number>
let page: AgentSessionHistoryPage
let parse: ReturnType<typeof vi.spyOn>, resources: ReturnType<typeof vi.fn>, copy: ReturnType<typeof vi.fn>
let active = true, located: string | undefined
const reading = () => projectConversationReading({ agentSessionId: page.agentSessionId, executionHostId: 'local', historyPage: page })
const observer = () => Visibility.all.find(value => value.options?.rootMargin === '600px 0px')!
const platform = () => ({ copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null })
async function render() {
  const projection = reading()
  await act(async () => root.render(<ClientUiProvider platform={platform()}><ConversationView sessionId={page.agentSessionId} executionHostId="local" page={page}
    records={projection.records} originalRecords={projection.originalRecords} coverage={projection.timeline.coverage} readHistoryResource={resources} active={active} locatedMessageKey={located} /></ClientUiProvider>))
}
async function frame() {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(1) })
}
async function near(indices: number[], value = true) { await act(async () => observer().emit(indices, value)) }
const shell = (index: number) => host.querySelector<HTMLElement>(`[data-native-record-id="record-${index}"]`)!
const body = (index: number) => shell(index).querySelector<HTMLElement>('[data-conversation-body-presented]')!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Visibility.all = []; Sizes.all = []; frames = new Map(); heights = new Map(); expanded = new Map(); active = true; located = undefined
  vi.stubGlobal('IntersectionObserver', Visibility); vi.stubGlobal('ResizeObserver', Sizes)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  host = document.createElement('div'); host.setAttribute('data-workbench-reading-scroll', ''); document.body.append(host)
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 400 }, scrollHeight: { configurable: true, get: () => page.items.length * 100 + [...heights.values()].reduce((sum, height) => sum + height - 100, 0) } })
  host.scrollTop = 6000
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === host) return box(0, 400)
    if (this.classList.contains('conversation-progressive-body')) return box(0, 0)
    const index = recordIndex(this)
    if (index < 0) return box(0, 0)
    let top = index * 100 - host.scrollTop
    for (const [key, value] of heights) if (key < index) top += value - 100
    for (const [key, value] of expanded) if (key < index && body(key)?.dataset.conversationBodyPresented === 'true') top += value
    const height = heights.get(index) ?? 100
    return this.hasAttribute('data-conversation-body-presented') ? box(top + 20, height - 20) : box(top, height)
  })
  page = { agentSessionId: 'progressive-fixture', sourceHostId: 'local', source: { providerId: 'recorded-provider', nativeSessionId: 'original-native' }, nextCursor: null,
    items: Array.from({ length: 180 }, (_, index) => ({ id: 'record-' + index, kind: 'assistant-message', contentParts: [
      { kind: 'text', text: `## Original record ${index}\n\nOriginal body **${index}**.\n\n\`\`\`typescript\nconst record = ${index}\n\`\`\`` },
      ...(index % 6 ? [] : [{ kind: 'resource' as const, resourceType: 'image' as const, reference: 'original-image-' + index }])
    ] })) }
  parse = vi.spyOn(markdown, 'parseAgentMarkdown')
  resources = vi.fn(async input => ({ agentSessionId: page.agentSessionId, source: input.source, recordId: input.recordId, partIndex: input.partIndex,
    reference: input.expectedReference, result: { status: 'read', mimeType: 'image/png', dataBase64: 'eA==', byteLength: 1 } }))
  copy = vi.fn(async () => true); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps 180 original shells while admitting only one nearby heavy body each frame', async () => {
  await render()
  expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(180)
  expect(parse).toHaveBeenCalledTimes(0); expect(resources).toHaveBeenCalledTimes(0)
  expect(Visibility.all.filter(value => value.options?.rootMargin === '600px 0px')).toHaveLength(1)
  await near([59, 60, 61]); await frame()
  expect(parse).toHaveBeenCalledTimes(1)
  await frame(); expect(parse).toHaveBeenCalledTimes(2)
  await frame(); expect(parse).toHaveBeenCalledTimes(3)
  expect(body(0).dataset.conversationBodyPresented).toBe('false')
  expect(resources).toHaveBeenCalledTimes(1)
  console.log(JSON.stringify({ records: 180, initialParses: 0, initialImageReads: 0, nearbyParsesAfter3Frames: parse.mock.calls.length, nearbyImageReads: resources.mock.calls.length }))
})

it('retains the exact read Text node and Range after leaving, hiding and appending', async () => {
  await render(); await near([60]); await frame()
  const original = shell(60).querySelector('strong')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(original)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  await near([60], false); active = false; await render()
  expect(shell(60).querySelector('strong')!.firstChild).toBe(original)
  expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(original)
  active = true; page = { ...page, items: [...page.items, { id: 'record-180', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Later short reply.' }] }] }; await render()
  expect(shell(60).querySelector('strong')!.firstChild).toBe(original)
  expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(original)
})

it('copies the full far original before mounting and locates only the exact body', async () => {
  await render()
  const button = shell(2).querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!
  expect(button).toBeTruthy()
  await act(async () => button.click())
  expect(copy).toHaveBeenCalledWith(page.items[2]!.contentParts[0]!.kind === 'text' ? page.items[2]!.contentParts[0]!.text : '', expect.any(Function))
  expect(parse).toHaveBeenCalledTimes(0)
  const record = reading().records.find(record => record.rawId === 'record-2')!
  located = conversationMessageSourceKey(page.agentSessionId, record.source); await render()
  expect(body(2).dataset.conversationBodyPresented).toBe('true')
  expect(body(3).dataset.conversationBodyPresented).toBe('false')
  expect(parse).toHaveBeenCalledTimes(1)
})

it('compensates an above-reader first mount and a later image resize without moving the original record', async () => {
  await render(); await near([60]); await frame()
  const original = shell(60), offset = original.getBoundingClientRect().top
  expanded.set(59, 240)
  await near([59]); await frame()
  expect(original.getBoundingClientRect().top).toBe(offset)
  expect(host.scrollTop).toBe(6240)
  expect(consumeProgrammaticReadingScroll(host)).toBe('restore')
  heights.set(59, 300)
  await act(async () => Sizes.all[0]!.emit())
  expect(original.getBoundingClientRect().top).toBe(offset)
  expect(host.scrollTop).toBe(6440)
})

it('does no pending work while hidden and ignores disconnected observer callbacks', async () => {
  await render(); await near([60, 61])
  const old = observer()
  active = false; await render(); await frame()
  expect(parse).toHaveBeenCalledTimes(0)
  await act(async () => old.callback([{ target: body(60), isIntersecting: true }] as IntersectionObserverEntry[], old as unknown as IntersectionObserver))
  await frame(); expect(parse).toHaveBeenCalledTimes(0)
  active = true; await render()
  const current = Visibility.all.findLast(value => value.options?.rootMargin === '600px 0px')!
  await act(async () => current.emit([60])); await frame()
  expect(parse).toHaveBeenCalledTimes(1)
})

it('defers already expanded captured diff and JSON payloads through the same original row', async () => {
  const items = Array.from({ length: 24 }, (_, index) => ({ ...recordedToolEdit(page.agentSessionId, 'record-' + index), id: 'record-' + index,
    toolInput: JSON.stringify({ file_path: 'src/original.ts', old_string: 'original', new_string: 'retained line\n'.repeat(180) }) }))
  const projection = projectConversationReading({ agentSessionId: page.agentSessionId, executionHostId: 'local', timeline: { agentSessionId: page.agentSessionId, revision: 1, items } })
  const format = vi.spyOn(diffs, 'toolEditDiff')
  host.scrollTop = 600
  await act(async () => root.render(<ClientUiProvider platform={platform()}><ConversationView sessionId={page.agentSessionId}
    records={projection.records} originalRecords={projection.originalRecords} renderProcess={props => <NativeProcessObservation {...props} />} /></ClientUiProvider>))
  expect(host.querySelectorAll('[data-captured-process-id]')).toHaveLength(24)
  await act(async () => { for (const button of host.querySelectorAll<HTMLButtonElement>('[data-captured-process-id] > button[aria-expanded="false"]')) button.click() })
  expect(host.querySelectorAll('[data-conversation-body-presented]')).toHaveLength(24)
  expect(format).toHaveBeenCalledTimes(0)
  expect(host.querySelectorAll('.conversation-detail-actions')).toHaveLength(0)
  await near([6, 7]); await frame()
  expect(format).toHaveBeenCalledTimes(1)
  expect(host.querySelectorAll('.log-diff')).toHaveLength(1)
  const original = host.querySelector('[data-captured-process-id="record-6"] pre')!
  await near([6], false)
  expect(original.isConnected).toBe(true)
  await act(async () => host.querySelector<HTMLButtonElement>('[data-captured-process-id="record-6"] [aria-label="Copy tool input"]')!.click())
  expect(copy.mock.calls.at(-1)?.[0]).toBe(items[6]!.toolInput)
})

it('retains a native step opened by exact location after its controlled disclosure closes', async () => {
  page = { ...page, items: [{ id: 'record-0', kind: 'activity', contentParts: [{ kind: 'text', text: '**Original retained step**\n\n' + 'Long original body. '.repeat(180) }] }] }
  const projection = reading(), record = projection.records[0]!
  let open = true
  const draw = async () => act(async () => root.render(<ClientUiProvider platform={platform()}><ConversationView sessionId={page.agentSessionId} page={page}
    records={projection.records} originalRecords={projection.originalRecords} locatedMessageKey={open ? conversationMessageSourceKey(page.agentSessionId, record.source) : undefined}
    renderProcess={props => <NativeProcessObservation {...props} disclosure={{ ...props.disclosure!, expanded: true, steps: new Map([[record.presentationKey ?? record.id, open]]) }} />} /></ClientUiProvider>))
  await draw()
  const original = shell(0).querySelector('strong')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(original)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  open = false; await draw()
  expect(original.isConnected).toBe(true)
  expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(original)
  open = true; await draw()
  expect(shell(0).querySelector('strong')!.firstChild).toBe(original)
})

it('measures only nearby shells during ordinary scrolling and keeps far work pending', async () => {
  await render(); await near([60, 61]); await frame()
  const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  geometry.mockClear(); parse.mockClear()
  await act(async () => host.dispatchEvent(new Event('scroll')))
  expect(geometry.mock.calls.length).toBeLessThanOrEqual(4)
  expect(parse).toHaveBeenCalledTimes(0)
  expect(body(0).dataset.conversationBodyPresented).toBe('false')
})

it('rebinds an adopted reading position and rejects its old realm callbacks', async () => {
  await render(); await near([60])
  const old = observer(), oldFrames = [...frames.values()]
  const other = new Window()
  Object.assign(other, { IntersectionObserver: Visibility, ResizeObserver: Sizes, requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame })
  other.document.body.appendChild(host as never)
  const projection = reading()
  await act(async () => root.render(<ClientUiProvider platform={{ ...platform(), ownerDocument: other.document as unknown as Document }}><ConversationView sessionId={page.agentSessionId} page={page}
    records={projection.records} originalRecords={projection.originalRecords} readHistoryResource={resources} /></ClientUiProvider>))
  await act(async () => { for (const callback of oldFrames) callback(1); old.callback([{ target: body(60), isIntersecting: true }] as IntersectionObserverEntry[], old as unknown as IntersectionObserver) })
  expect(parse).toHaveBeenCalledTimes(0)
  const current = Visibility.all.findLast(value => value.options?.rootMargin === '600px 0px')!
  expect(current).not.toBe(old)
  await act(async () => current.emit([60])); await frame()
  expect(parse).toHaveBeenCalledTimes(1)
  document.body.appendChild(host)
  await other.happyDOM.close()
})

it('copies an unread complete text resource without presenting neighboring heavy bodies', async () => {
  const original = 'Complete original resource 中文🙂. '.repeat(180)
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: original })), sha256 = createHash('sha256').update(bytes).digest('hex')
  const part = { kind: 'resource' as const, resourceType: 'text' as const, reference: 'exact-original-resource',
    content: { encoding: 'json-utf8' as const, kind: 'text' as const, byteLength: bytes.length, sha256 } }
  page = { ...page, items: page.items.map((item, index) => index === 2 ? { ...item, contentParts: [part] } : item) }
  resources.mockImplementation(async input => ({ agentSessionId: page.agentSessionId, sourceHostId: 'local', source: page.source,
    recordId: input.recordId, partIndex: input.partIndex, reference: input.expectedReference,
    result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'), byteLength: bytes.length,
      offsetBytes: 0, totalBytes: bytes.length, sha256, nextOffsetBytes: null } }))
  await render()
  expect(resources).toHaveBeenCalledTimes(0)
  await act(async () => shell(2).querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy.mock.calls.at(-1)?.[0]).toBe(original)
  expect(resources).toHaveBeenCalledTimes(1)
  expect(resources.mock.calls[0]![0]).toMatchObject({ recordId: 'record-2', expectedReference: part.reference, source: page.source })
  expect(body(2).dataset.conversationBodyPresented).toBe('false')
  expect(parse).toHaveBeenCalledTimes(0)
})

it('keeps explicit body display available without IO and does not scan far geometry on scroll', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  await render()
  const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect); geometry.mockClear()
  await act(async () => host.dispatchEvent(new Event('scroll')))
  expect(geometry.mock.calls.length).toBeLessThanOrEqual(1)
  await act(async () => body(2).querySelector<HTMLButtonElement>('button')!.click())
  expect(body(2).dataset.conversationBodyPresented).toBe('true')
  expect(parse).toHaveBeenCalledTimes(1)
  expect(body(3).dataset.conversationBodyPresented).toBe('false')
})

it('pauses pending work in the actual hidden document and resumes its original target', async () => {
  await render(); await near([60])
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await frame()
  expect(parse).toHaveBeenCalledTimes(0)
  visibility.mockReturnValue('visible')
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await frame()
  expect(parse).toHaveBeenCalledTimes(1)
})

it('keeps a long human body after its original disclosure closes and reopens', async () => {
  await act(async () => root.render(<ClientUiProvider platform={platform()}><ConversationMessage messageId="original-human"
    speaker={{ role: 'human', id: 'human' }} content={'**Original human body**\n\n' + 'Complete original input. '.repeat(180)} /></ClientUiProvider>))
  const disclosure = host.querySelector<HTMLDetailsElement>('.message-disclosure')!
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  const original = host.querySelector('strong')!.firstChild!
  await act(async () => { disclosure.open = false; disclosure.dispatchEvent(new Event('toggle')) })
  expect(original.isConnected).toBe(true)
  expect(disclosure.querySelector<HTMLElement>('.message-disclosure__body')!.hidden).toBe(true)
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  expect(host.querySelector('strong')!.firstChild).toBe(original)
})

it('retains a system body through its card disclosure without adding a grid column', async () => {
  page = { ...page, items: [{ id: 'record-0', kind: 'system-message', contentParts: [{ kind: 'text', text: '**Original system body**\n\n' + 'Complete original context. '.repeat(180) }] }] }
  host.scrollTop = 0
  await render()
  await act(async () => shell(0).querySelector<HTMLButtonElement>('[aria-label="展开系统记录"]')!.click())
  await near([0]); await frame()
  const original = shell(0).querySelector('strong')!.firstChild!
  await act(async () => shell(0).querySelector<HTMLButtonElement>('[aria-label="收起系统记录"]')!.click())
  expect(original.isConnected).toBe(true)
  await act(async () => shell(0).querySelector<HTMLButtonElement>('[aria-label="展开系统记录"]')!.click())
  expect(shell(0).querySelector('strong')!.firstChild).toBe(original)
})

it('keeps a focused placeholder until explicit display transfers focus into its original body', async () => {
  await render()
  const button = body(60).querySelector<HTMLButtonElement>('button')!
  button.focus()
  await near([60]); await frame()
  expect(body(60).dataset.conversationBodyPresented).toBe('false')
  expect(document.activeElement).toBe(button)
  await act(async () => button.click())
  expect(body(60).dataset.conversationBodyPresented).toBe('true')
  expect(document.activeElement).not.toBe(document.body)
  expect(shell(60).contains(document.activeElement)).toBe(true)
  expect(document.activeElement?.isConnected).toBe(true)
  // Moving focus away admits the next original placeholder without another IO event.
  const other = body(61).querySelector<HTMLButtonElement>('button')!
  other.focus(); await near([61]); await frame()
  expect(body(61).dataset.conversationBodyPresented).toBe('false')
  await act(async () => other.blur()); await frame()
  expect(body(61).dataset.conversationBodyPresented).toBe('true')
})
