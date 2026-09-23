// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'
import type { NativeOverlayRegion } from '../src/shared/native-overlay'

// Typed captured records and DOM geometry, not a live Writer/PTY or Browser compositor.
// Only the right-side terminal paint leaf is isolated; Global, Store, Timeline,
// Floating UI, the shared host and the image's real Radix Dialog are mounted.
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({
  SessionObservationRegions: ({ sessionIds }: { sessionIds: string[] }) => createElement('output', { 'data-observed-context': sessionIds.join(',') })
}))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const A = 'overlay-recipient', B = 'overlay-sender'
const ID = 'captured:prompt:overlay-message'
const IMAGE_PATH = '/overlay-fixture/.agentmux/pasted/preview.png'
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg=='
const BODY = `Keep this original message selected. @${IMAGE_PATH}`
const initial = useAppStore.getState()
let root: Root | undefined, container: HTMLDivElement | undefined
const disposals: Array<() => void> = []
afterEach(async () => {
  disposals.splice(0).forEach(dispose => dispose())
  await act(async () => root?.unmount()); container?.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  window.getSelection()?.removeAllRanges()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
function host() {
  const node = document.getElementById('agentmux-window-overlay-host')
  expect(node, 'The actual shared Portal host').not.toBeNull(); return node!
}
function preview() {
  const node = host().querySelector<HTMLElement>('.recent-focus__message-preview')
  expect(node, 'The real preview, outside #root').not.toBeNull(); return node!
}
function button(node: HTMLElement, label: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  expect(found, label).not.toBeUndefined(); return found!
}
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue({ dataUrl: IMAGE })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/overlay-fixture' })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({
    agentSessionId: control.agentSessionId, source: { providerId: 'generic', nativeSessionId: 'typed-empty-overlay-fixture' }, items: [], nextCursor: null
  }))
  const unsafe = (['write', 'paste', 'stop', 'interrupt', 'resume', 'recover'] as const).map(name => vi.spyOn(api.sessions, name))
  const sessions: SessionSnapshot[] = [A, B].map(id => ({
    id, kind: 'agent', providerId: 'generic', executorId: 'generic', hostId: 'local', workspacePath: '/overlay-fixture', label: id,
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `${id}-original-run` } }
  }))
  const config: AppConfig = {
    version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
    executors: { generic: { label: 'Generic', providerId: 'generic', command: 'generic', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [{ id: 'overlay-project', hostId: 'local', name: 'Overlay project', path: '/overlay-fixture', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }
  const now = Date.now() - 1000
  const timeline: AgentTimelineSnapshot = { agentSessionId: A, revision: 1, items: [{
    id: 'prompt:overlay-message', agentSessionId: A, kind: 'user_message', status: 'complete', source: 'user', createdAt: now, updatedAt: now,
    title: 'Captured input', content: BODY, authorAgentSessionId: B
  }] }
  useAppStore.setState({ config, sessions, timelines: { [A]: timeline }, tabs: {}, layouts: {}, recoveryCandidates: [], agentNames: {}, workspaceFileRevisions: {},
    mainSurface: 'agents', activeWorkspaceId: 'overlay-project', error: null,
    agentFocus: { execution: { sessionId: A, history: [] }, pmo: { sessionId: null } } })
  container = document.createElement('div'); container.id = 'root'; document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(GlobalFocusSurface))); await settle()
  const markers = [...container.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
  expect(markers.map(item => item.dataset.messageId)).toEqual([ID])
  expect(markers[0]!.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId).toBe(A)
  const marker = markers[0]!
  return { marker, history, unsafe, subjects: sessions.map(session => [session.id, session.control.run.runId]),
    async open() { await act(async () => { marker.focus(); marker.click() }); await settle(); return preview() } }
}
function selectBody(node: HTMLElement) {
  const body = node.querySelector<HTMLElement>(`[data-input-preview-id="${ID}"]`)!
  expect(body).not.toBeNull()
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let text: Node | null
  do { text = walker.nextNode() } while (text && !text.textContent?.includes('Keep this original message'))
  expect(text).not.toBeNull()
  const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 4)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  expect(selection.toString()).toBe('Keep'); return { body, range }
}
async function imageDialog(node: HTMLElement) {
  const thumb = node.querySelector<HTMLButtonElement>('.md-conversation-image')!
  expect(thumb).not.toBeNull()
  await act(async () => { thumb.focus(); thumb.click() }); await settle()
  const box = host().querySelector<HTMLElement>('.md-conversation-image__lightbox')!
  expect(box).not.toBeNull(); expect(box.querySelector('img')!.getAttribute('src')).toBe(IMAGE)
  return { thumb, box }
}

it('Global marker uses the shared popover and Escape restores its true connected entry without a tooltip', async () => {
  const h = await fixture(), focus = useAppStore.getState().agentFocus, node = await h.open()
  expect(node.parentElement?.dataset.overlayLayer).toBe('popover')
  expect(container!.contains(node)).toBe(false); expect(document.activeElement).toBe(node)
  expect(node.style.visibility).toBe('visible'); expect(node.querySelector('[data-input-preview-id]')!.getAttribute('data-input-preview-id')).toBe(ID)
  await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(host().querySelector('.recent-focus__message-preview')).toBeNull(); expect(document.activeElement).toBe(h.marker)
  expect(useAppStore.getState().agentFocus).toBe(focus)
})
it('real nested image pointer preserves the pinned parent, original body and selection without swallowing document input', async () => {
  const h = await fixture(), node = await h.open(), { body, range } = selectBody(node)
  const { box } = await imageDialog(node), observed = vi.fn()
  document.addEventListener('pointerdown', observed)
  try {
    await act(async () => box.querySelector('img')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    expect(preview()).toBe(node); expect(node.querySelector('[data-input-preview-id]')).toBe(body)
    expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Keep')
    expect(observed).toHaveBeenCalledOnce()
  } finally { document.removeEventListener('pointerdown', observed) }
})
it('the actual child Dialog owns first Escape and thumbnail focus; second Escape closes only the original parent', async () => {
  const h = await fixture(), node = await h.open(), { body, range } = selectBody(node), { thumb, box } = await imageDialog(node)
  expect(document.activeElement).not.toBe(h.marker)
  await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
  expect(preview()).toBe(node); expect(node.querySelector('[data-input-preview-id]')).toBe(body)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(host().querySelector('.md-conversation-image__lightbox')).toBeNull()
  expect(document.activeElement).toBe(thumb)
  await act(async () => thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(host().querySelector('.recent-focus__message-preview')).toBeNull(); expect(document.activeElement).toBe(h.marker)
})
it('initial asynchronous positioning does not steal a later outside control focus', async () => {
  const h = await fixture(), search = container!.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  act(() => { h.marker.focus(); h.marker.click() })
  act(() => search.focus()); await settle()
  expect(preview().style.visibility).toBe('visible'); expect(document.activeElement).toBe(search)
  await act(async () => button(preview(), 'Close message').click())
  expect(document.activeElement).toBe(search)
})
it('explicit sender navigation preserves its actual Store target and does not restore the old marker', async () => {
  const h = await fixture(), node = await h.open()
  expect(document.activeElement).toBe(node)
  await act(async () => button(node, 'View sender').click()); await settle()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(B)
  expect(useAppStore.getState().agentFocus.execution.history.map(item => item.sessionId)).toEqual([B])
  expect(document.activeElement).not.toBe(h.marker); expect(host().querySelector('.recent-focus__message-preview')).toBeNull()
  expect(container!.querySelector('[data-observed-context]')!.getAttribute('data-observed-context')).toBe(B)
  expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId])).toEqual(h.subjects)
})
it('anchor resize repositions the same selected body and unrelated bytes do not read another sender or acquire a manual lease', async () => {
  const h = await fixture(), node = await h.open(), { body, range } = selectBody(node)
  const reads = h.history.mock.calls.map(call => call[0].agentSessionId)
  expect(reads).toEqual([A]); const origin = useAppStore.getState().agentFocus
  expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)
  await act(async () => { window.dispatchEvent(new Event('resize')); useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === B ? { ...session, latestOutputBytes: 64 } : session) })) }); await settle()
  expect(preview()).toBe(node); expect(node.querySelector('[data-input-preview-id]')).toBe(body)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Keep')
  expect(h.history.mock.calls.map(call => call[0].agentSessionId)).toEqual(reads)
  expect(h.unsafe.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]); expect(useAppStore.getState().agentFocus).toBe(origin)
})
it('the existing native overlay collector observes real open Portal surfaces and releases parent and child independently', async () => {
  const h = await fixture(), node = await h.open()
  // Nonempty typed DOM bounds and opacity are collector fixtures. Actual CSS paint
  // and native Browser frame compositing require their separate visual qualification.
  const rect = new DOMRect(20, 20, 200, 120)
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect)
  Object.assign(node.style, { backgroundColor: 'rgb(32, 32, 32)', borderRadius: '8px', visibility: 'visible' })
  let regions: NativeOverlayRegion[] = []
  const collector = observeNativeOverlayRegions(document.body, () => 1, next => { regions = next }); disposals.push(() => collector.dispose())
  expect(regions.map(item => item.bounds)).toEqual([{ x: 20, y: 20, width: 200, height: 120 }])
  const parentID = regions[0]!.id
  const { box } = await imageDialog(node)
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 50, 100, 80))
  Object.assign(box.style, { backgroundColor: 'rgb(32, 32, 32)', borderRadius: '8px' }); await settle()
  expect(regions.map(item => item.id)).toHaveLength(2); expect(regions[0]!.id).toBe(parentID)
  await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
  expect(regions.map(item => item.id)).toEqual([parentID])
  await act(async () => button(node, 'Close message').click()); await settle()
  expect(regions).toEqual([]); expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)
})
