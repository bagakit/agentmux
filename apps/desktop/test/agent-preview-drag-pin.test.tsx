// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { api } from '../src/renderer/src/lib/api'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentBookmarks, createAgentBookmarks, type AgentBookmarkBounds } from '../src/renderer/src/lib/agent-bookmarks'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useAppStore } from '../src/renderer/src/store'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))

const dom = composerDOM({ agentInformation: true }), agent = composerSession('drag-pin-agent')
const onOpen = vi.fn()
const timeline = {
  agentSessionId: agent.id, revision: 1, items: [{ id: 'original-reply', agentSessionId: agent.id,
    kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const,
    title: 'Reply', content: 'Original reply stays readable.', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }]
}
const panels = () => [...document.querySelectorAll<HTMLElement>('.agent-information-reader')]
const panel = () => panels()[0]!
const entries = () => [...panel().querySelectorAll<HTMLButtonElement>('.agent-input-recall__entry')]
const initialBounds: AgentBookmarkBounds = { x: 50, y: 80, width: 420, height: 172 }

async function open(session = agent) {
  await dom.render(<WorkspaceAgentRow context={agentContextForSession(session, timeline, 'Original task', composerConfig.workspaces[0]!, null)}
    selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={onOpen} />)
  await act(async () => dom.container.querySelector<HTMLElement>('.focus-context')!.focus())
  await waitForAgentCardReading(() => expect(entries()).toHaveLength(2))
  return panel()
}

/** Happy DOM has no layout; retain the actual consumer while supplying its measured rect. */
function measuredPanel(original: HTMLElement, start = initialBounds) {
  vi.spyOn(original, 'getBoundingClientRect').mockImplementation(() => {
    const x = parseFloat(original.style.left) || 0, y = parseFloat(original.style.top) || 0
    const width = parseFloat(original.style.width) || start.width, height = parseFloat(original.style.height) || start.height
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() {} }
  })
  return original.querySelector<HTMLElement>('.agent-information-reader__header')!
}
function bounds(original: HTMLElement): AgentBookmarkBounds {
  const { x, y, width, height } = original.getBoundingClientRect()
  return { x, y, width, height }
}

function pointerEvent(type: string, id: number, x: number, y: number, init: Partial<PointerEventInit> = {}) {
  return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: id, pointerType: 'mouse', isPrimary: true,
    clientX: x, clientY: y, ...init })
}
async function pointer(target: Element, type: string, id: number, x: number, y: number, init?: Partial<PointerEventInit>) {
  await act(async () => target.dispatchEvent(pointerEvent(type, id, x, y, init)))
}
async function beginDrag(header: HTMLElement) {
  await pointer(header, 'pointerdown', 7, 100, 100)
  await pointer(header, 'pointermove', 7, 106, 100)
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
}
function expectOriginalWorkface() {
  expect(onOpen).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([agent])
}

beforeEach(async () => {
  onOpen.mockClear()
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  useAppStore.setState({ sessions: [agent], timelines: { [agent.id]: timeline }, demands: {}, agentNames: {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: agent.control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'drag-pin-original' }, nextCursor: null,
    items: [0, 1].map(index => ({ id: `input-${index}`, kind: 'user-message' as const, startedAt: index + 1,
      contentParts: [{ kind: 'text' as const, text: `Original input ${index}` }] })) })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'drag-pin-original' }, dispose() {} }))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  await agentCardConversationFixture(() => ({ providerId: 'codex', nativeSessionId: 'drag-pin-original' }))
})
afterEach(async () => {
  await act(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() })
})

it.each([{ name: 'a title click', dx: 0, dy: 0 }, { name: 'sub-threshold jitter', dx: 3, dy: 3 }])('does not pin on $name', async ({ dx, dy }) => {
  const original = await open(), header = measuredPanel(original)
  await pointer(header, 'pointerdown', 7, 100, 100)
  await pointer(header, 'pointermove', 7, 100 + dx, 100 + dy)
  await pointer(header, 'pointerup', 7, 100 + dx, 100 + dy)
  expect(agentBookmarks.get().bookmarks).toHaveLength(0)
  expect(original.dataset.pinned).toBeUndefined()
  expect(panel()).toBe(original)
  expectOriginalWorkface()
})

it.each(['body', 'status', 'pin control', 'secondary pointer'] as const)('does not turn %s movement into a title drag', async target => {
  const original = await open(), header = measuredPanel(original)
  const element = target === 'body' ? original.querySelector<HTMLElement>('.agent-information-reader__reading')!
    : target === 'status' ? original.querySelector<HTMLElement>('.agent-information-reader__status')!
      : target === 'pin control' ? original.querySelector<HTMLElement>('.agent-information-reader__pin')! : header
  const init = target === 'secondary pointer' ? { isPrimary: false } : undefined
  await pointer(element, 'pointerdown', 7, 100, 100, init)
  await pointer(element, 'pointermove', 7, 150, 125, init)
  await pointer(element, 'pointerup', 7, 150, 125, init)
  expect(agentBookmarks.get().bookmarks).toHaveLength(0)
  expect(original.dataset.pinned).toBeUndefined()
  expect(panel()).toBe(original)
  expectOriginalWorkface()
})

it('continues one threshold-crossing gesture without replacing the short reading, inspected input or selection', async () => {
  const original = await open(), header = measuredPanel(original)
  const start = bounds(original)
  await act(async () => entries()[0]!.click())
  const inspection = original.querySelector<HTMLElement>('.agent-input-recall__original')!
  const reading = inspection.querySelector<HTMLElement>('[data-agent-input-reading]')!
  expect(reading).not.toBeNull()
  const text = document.createTreeWalker(reading, NodeFilter.SHOW_TEXT).nextNode()!
  expect(text.textContent).toContain('Original input')
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  reading.scrollTop = 37
  const selected = document.getSelection()!.toString(), reads = vi.mocked(api.sessions.historyPage).mock.calls.length
  // This records the hook's capture protocol, not a native-browser capture claim.
  let captured: number | null = null
  const capture = vi.fn((id: number) => { captured = id }), release = vi.fn(() => { captured = null })
  Object.defineProperties(header, { setPointerCapture: { configurable: true, value: capture },
    hasPointerCapture: { configurable: true, value: (id: number) => captured === id },
    releasePointerCapture: { configurable: true, value: release } })
  const promote = vi.spyOn(agentInformationPreview, 'ensurePinned')
  await pointer(header, 'pointerdown', 7, 100, 100)
  await pointer(header, 'pointermove', 7, 103, 103)
  expect(agentBookmarks.get().bookmarks).toHaveLength(0)
  await pointer(header, 'pointermove', 7, 106, 100)
  const bookmark = agentBookmarks.get().bookmarks[0]!
  expect(bookmark.bounds).toEqual(start)
  expect(captured).toBe(7)
  expect(release).not.toHaveBeenCalled()
  await pointer(header, 'pointermove', 7, 140, 125)
  expect(original.style.left).toBe(`${start.x + 40}px`); expect(original.style.top).toBe(`${start.y + 25}px`)
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toEqual(start)
  await pointer(header, 'pointerup', 7, 140, 125)
  expect(promote).toHaveBeenCalledTimes(1)
  expect(capture).toHaveBeenCalledExactlyOnceWith(7)
  expect(release).toHaveBeenCalledExactlyOnceWith(7)
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
  expect(agentBookmarks.get().bookmarks[0]).toMatchObject({ key: bookmark.key, hostId: agent.control.hostId,
    agentSessionId: agent.control.agentSessionId, bounds: { x: start.x + 40, y: start.y + 25, width: 420, height: 172 } })
  expect(panel()).toBe(original)
  expect(original.querySelector('.agent-information-reader__header')).toBe(header)
  expect(original.querySelector('.agent-input-recall__original')).toBe(inspection)
  expect(reading.contains(text)).toBe(true)
  expect(reading.scrollTop).toBe(37)
  expect(document.getSelection()!.toString()).toBe(selected)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  expectOriginalWorkface()
})

it.each(['Escape', 'pointercancel', 'lostpointercapture'] as const)('rolls back only the newly drag-pinned preview on %s', async cancel => {
  const original = await open(), header = measuredPanel(original)
  const start = bounds(original)
  await beginDrag(header)
  await pointer(header, 'pointermove', 7, 145, 130)
  await pointer(header, 'pointercancel', 8, 145, 130, { isPrimary: false })
  await pointer(header, 'lostpointercapture', 8, 145, 130, { isPrimary: false })
  await pointer(header, 'pointerup', 8, 145, 130, { isPrimary: false })
  expect(original.dataset.pinned).toBe('true')
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
  if (cancel === 'Escape') {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => window.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
  } else await pointer(header, cancel, 7, 145, 130)
  expect(agentBookmarks.get().bookmarks).toHaveLength(0)
  expect(original.dataset.pinned).toBeUndefined()
  expect(original.dataset.bookmarkGesture).toBeUndefined()
  expect(original.getBoundingClientRect()).toMatchObject(start)
  expect(panel()).toBe(original)
  await pointer(header, 'pointerup', 7, 145, 130)
  expect(agentBookmarks.get().bookmarks).toHaveLength(0)
  expectOriginalWorkface()
})

it('keeps the original same-canonical bookmark and tree when an alias drag is cancelled', async () => {
  const original = await open(), header = measuredPanel(original)
  await beginDrag(header); await pointer(header, 'pointerup', 7, 106, 100)
  const saved = agentBookmarks.get().bookmarks[0]!, alias = { ...agent, id: 'drag-pin-alias' }
  await act(async () => useAppStore.setState({ sessions: [agent, alias] }))
  await open(alias)
  expect(panel()).toBe(original)
  await pointer(header, 'pointerdown', 7, 100, 100)
  await pointer(header, 'pointermove', 7, 150, 130)
  await pointer(header, 'pointercancel', 7, 150, 130)
  expect(agentBookmarks.get().bookmarks).toEqual([saved])
  expect(original.dataset.pinned).toBe('true')
  expect(original.getBoundingClientRect()).toMatchObject(saved.bounds)
  expect(panels()).toEqual([original])
  expect(onOpen).not.toHaveBeenCalled()
})

it('does not delete a same-canonical bookmark that arrived before the promotion render', async () => {
  const original = await open(), header = measuredPanel(original)
  const start = bounds(original)
  await pointer(header, 'pointerdown', 7, 100, 100)
  let savedKey: string | null = null
  await act(async () => {
    savedKey = agentBookmarks.pin({ hostId: agent.control.hostId, agentSessionId: agent.control.agentSessionId,
      presentationId: 'earlier-alias', label: 'Earlier bookmark', workspaceName: 'Original project', bounds: start })
    header.dispatchEvent(pointerEvent('pointermove', 7, 145, 130))
  })
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
  await pointer(header, 'pointercancel', 7, 145, 130)
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
  expect(agentBookmarks.get().bookmarks[0]).toMatchObject({ key: savedKey, presentationId: 'earlier-alias', bounds: start })
  expect(panels()).toEqual([original])
  expect(original.dataset.pinned).toBe('true')
  expectOriginalWorkface()
})

it('keeps explicit header Pin and status actions independent of dragging', async () => {
  const original = await open(); measuredPanel(original)
  const status = original.querySelector<HTMLButtonElement>('.agent-information-reader__status')!
  await act(async () => status.click())
  expect(original.querySelector('.agent-information-reader__metadata')).not.toBeNull()
  expect(agentBookmarks.get().bookmarks).toHaveLength(0)
  await act(async () => original.querySelector<HTMLButtonElement>('[aria-label="Back to original content"]')!.click())
  const pin = original.querySelector<HTMLButtonElement>('.agent-information-reader__header .agent-information-reader__pin')!
  await act(async () => pin.click())
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
  const reading = original.querySelector<HTMLElement>('.agent-information-reader__reading')!
  await act(async () => { reading.focus(); reading.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true })) })
  expect(agentBookmarks.get().bookmarks).toHaveLength(0)
  expect(panel()).toBe(original)
  expectOriginalWorkface()
})

it('restores completed drag bounds through fresh bookmark storage and the original Reader bootstrap without a live Session', async () => {
  const original = await open(), header = measuredPanel(original)
  await beginDrag(header)
  await pointer(header, 'pointermove', 7, 140, 125)
  await pointer(header, 'pointerup', 7, 140, 125)
  await agentBookmarks.flush()
  const saved = agentBookmarks.get().bookmarks[0]!
  const fresh = createAgentBookmarks({ storage: window.localStorage, flush: async () => {} })
  expect(fresh.get().bookmarks).toEqual([saved])
  const reads = vi.mocked(api.sessions.historyPage).mock.calls.length
  await dom.render(null)
  await act(async () => {
    agentInformationPreview.detach()
    useAppStore.setState({ sessions: [], timelines: {} })
    agentInformationPreview.restore(fresh.get().bookmarks, document)
  })
  expect(panels()).toHaveLength(1)
  expect(panel()).not.toBe(original)
  expect(panel().dataset.bookmarkKey).toBe(saved.key)
  expect(panel().style.left).toBe(`${saved.bounds.x}px`); expect(panel().style.top).toBe(`${saved.bounds.y}px`)
  expect(panel().style.width).toBe(`${saved.bounds.width}px`); expect(panel().style.height).toBe(`${saved.bounds.height}px`)
  expect(panel().textContent).toContain('Original reply stays readable.')
  expect(agentInformationPreview.get()!.control).toBeUndefined()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  expect(useAppStore.getState().sessions).toEqual([])
})
