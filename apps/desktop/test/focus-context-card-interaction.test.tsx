import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { acknowledgedNameProjection } from '../src/renderer/src/lib/name-authority'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { act, createElement, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { formatSessionAddress } from '../src/renderer/src/lib/agent-address'
import { resolveAgentSharingMetadata } from '../src/renderer/src/lib/agent-sharing-metadata'
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'

const initial = useAppStore.getState(), first = 'card-first', second = 'card-second'
let root: Root, container: HTMLDivElement, destination: HTMLInputElement, select: ReturnType<typeof vi.fn>
let privateSpatialRoot: string
const response = '完整回复：核对 src/scroll-anchor.ts，保留原草稿与选区。'
function Rows() {
  const project = useMemo(createFocusProjectionSelector, [])
  const contexts = useAppStore(project).contexts
  return createElement('div', {}, contexts.map(context => createElement(FocusContextRow, { key: context.id, context, selected: false, onSelect: select })))
}
const card = (id = second) => container.querySelector<HTMLButtonElement>(`button[data-session-id="${id}"]`)!
const preview = () => document.querySelector<HTMLElement>('.focus-context-hover')
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
async function pointer(node: Element, type: 'pointerover' | 'pointerout', relatedTarget: Element | null = null) {
  await act(async () => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', buttons: 0, relatedTarget })))
}
async function menu(id = second, keyboard: boolean | 'shift-f10' = false) {
  await act(async () => {
    if (keyboard) { card(id).focus(); card(id).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true,
      ...(keyboard === 'shift-f10' ? { key: 'F10', code: 'F10', shiftKey: true, keyCode: 121 } : { key: 'ContextMenu' }) })) }
    else card(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 40 }))
  })
  expect(document.querySelector('.focus-context-menu')?.getAttribute('data-agent-session-id')).toBe(id)
}
async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('.focus-context-menu [role="menuitem"]')].find(node => node.textContent === label)
  expect(item).toBeTruthy(); await act(async () => item!.click())
  await advance(1)
}
async function value(text: string) {
  const input = container.querySelector<HTMLInputElement>('.focus-context__rename')!
  expect(input).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
  return input
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot(), base = snapshot.sessions.find(session => session.kind === 'agent')!
  const workspace = { ...config.workspaces[0]!, hostId: 'local', path: _hygiene_fixturePath("private/card-interaction"), name: 'Readability project' }
  const sessions = [first, second].map(id => ({ ...base, id, workspacePath: workspace.path, hostId: 'local',
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 }, control: { ...base.control, agentSessionId: id } }))
  useAppStore.setState({ ...initial, config: { ...config, workspaces: [workspace] }, sessions,
    agentNames: { [first]: 'Same visible Agent', [second]: 'Same visible Agent' }, tabs: {}, layouts: {}, scratchTopicSnapshots: {},
    timelines: Object.fromEntries([first, second].map(id => [id, { agentSessionId: id, revision: 1, items: [
      { id: id + '-prompt', agentSessionId: id, kind: 'user_message', title: 'Prompt', status: 'complete', source: 'native-hook', content: 'Derived task for ' + id, createdAt: 1, updatedAt: 1 },
      { id: id + '-reply', agentSessionId: id, kind: 'assistant_message', title: 'Reply', status: 'complete', source: 'native-hook', content: response, createdAt: 2, updatedAt: 2 }
    ] }])), agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [second]: 'Original unsent draft' } }, true)
  // The original rename cases must reach the real durable label owner and ACK.
  privateSpatialRoot = await mkdtemp(join(tmpdir(), 'focus-card-labels-'))
  const owner = new AgentMuxSpatialStateStore(join(privateSpatialRoot, 'spatial.json'))
  await owner.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {}, tabs: [], regions: [], tabLayouts: {}, resources: {} } })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'renameLabel').mockImplementation(input => owner.mutateDisplayLabel(input, {
    actor: { kind: 'device', id: 'private-card-test', verified: true }, source: 'desktop-ui',
    entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-card-test' }
  }))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  vi.spyOn(api.spatial, 'confirmNameCommit').mockImplementation(operationId => owner.confirmNameCommit(operationId))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  await initializeSpatialControlFixture()
  useAppStore.setState(acknowledgedNameProjection((await owner.readForLayout())!, 0)!)
  container = document.createElement('div'); destination = document.createElement('input'); document.body.append(container, destination)
  select = vi.fn(() => destination.focus()); root = createRoot(container)
  await act(async () => root.render(createElement(Rows)))
  vi.useFakeTimers()
})
afterEach(async () => {
  await act(async () => root.unmount()); await advance(1); vi.useRealTimers()
  await useAppStore.getState().retryWorkbenchSave()
  container.remove(); destination.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  await rm(privateSpatialRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
})

it('reveals held facts and scoped inputs after intent, allows reading transfer and inner scrolling without moving input', async () => {
  const reads = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline'), vi.spyOn(api.workspaces, 'appearance')]
  destination.focus(); await pointer(card(), 'pointerover'); await advance(179); expect(preview()).toBeNull()
  expect(reads.every(read => read.mock.calls.length === 0)).toBe(true)
  await advance(1); expect(preview()?.textContent).toContain(response); expect(preview()?.querySelector('.focus-context-hover__recap > small')?.getAttribute('title')).toContain('Last assistant message')
  expect(preview()?.querySelector('footer')?.getAttribute('aria-label')).toContain(_hygiene_fixturePath("private/card-interaction")); expect(preview()?.querySelector('footer')?.getAttribute('aria-label')).toContain(second)
  expect(document.activeElement).toBe(destination)
  const panel = preview()!; await pointer(card(), 'pointerout', panel); await pointer(panel, 'pointerover', card()); await advance(170)
  await act(async () => panel.dispatchEvent(new Event('scroll', { bubbles: false }))); expect(preview()).toBe(panel)
  const text = panel.querySelector('p')!.firstChild!, range = document.createRange(); range.selectNodeContents(text)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); expect(window.getSelection()!.toString()).toContain(response)
  await pointer(panel, 'pointerout', destination); await advance(160); expect(preview()).toBeNull()
  expect(reads[0]).toHaveBeenCalledTimes(1); expect(reads[0]!.mock.calls[0]![0]).toBe(useAppStore.getState().sessions.find(session => session.id === second)!.control)
  expect(reads.slice(1).every(read => read.mock.calls.length === 0)).toBe(true); expect(select).not.toHaveBeenCalled()
})
it('Escape, external scroll, source changes and unmount cancel stale intents without claiming focus', async () => {
  destination.focus(); await pointer(card(), 'pointerover')
  await act(async () => destination.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  await advance(200); expect(preview()).toBeNull(); expect(document.activeElement).toBe(destination)
  await pointer(card(), 'pointerover'); await act(async () => { const changed = await useAppStore.getState().renameAgent(second, 'New current task'); expect(changed, JSON.stringify(useAppStore.getState().nameEditFailure)).toBe(true) })
  await advance(200); expect(preview()).toBeNull()
  await pointer(card(), 'pointerover'); await advance(180); expect(preview()).toBeTruthy()
  await act(async () => container.dispatchEvent(new Event('scroll'))); expect(preview()).toBeNull()
  await pointer(card(), 'pointerover'); await act(async () => root.render(null)); await advance(200); expect(preview()).toBeNull()
})
it('uses one keyboard-readable preview and the same exact-SID menu without selecting a same-name neighbor', async () => {
  await act(async () => card(first).focus()); expect(preview()?.textContent).toContain(first)
  await act(async () => card(second).focus()); expect(document.querySelectorAll('.focus-context-hover')).toHaveLength(1)
  const before = useAppStore.getState(), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await menu(second, 'shift-f10'); expect(preview()).toBeNull()
  expect([...document.querySelectorAll('.focus-context-menu [role="menuitem"]')].map(node => node.textContent)).toEqual(['Rename Agent', 'Copy Session Address', 'Stop Agent'])
  const identity = document.querySelector('.focus-context-menu__identity')!
  expect(identity.textContent).toBe(useAppStore.getState().agentNames[second])
  expect(identity.querySelector('strong')?.getAttribute('title')).toBe(identity.textContent)
  expect(identity.querySelector('span, code')).toBeNull()
  expect(card(second).getAttribute('aria-pressed')).toBe('false'); expect(select).not.toHaveBeenCalled()
  await choose('Copy Session Address'); expect(copy).toHaveBeenCalledExactlyOnceWith(formatSessionAddress(second, resolveAgentSharingMetadata(second, before)))
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it('keeps exact card navigation after dismissing its action menu', async () => {
  await menu(second, true)
  await act(async () => document.querySelector('.focus-context-menu')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
  await advance(1)
  expect(document.querySelector('.focus-context-menu')).toBeNull()
  await act(async () => card(second).click())
  expect(select).toHaveBeenCalledExactlyOnceWith(second); expect(document.activeElement).toBe(destination)
})
it('keeps a newly opened keyboard menu when an older menu finishes restoring focus', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await menu(second, true)
  const copy = [...document.querySelectorAll<HTMLElement>('.focus-context-menu [role="menuitem"]')].find(node => node.textContent === 'Copy Session Address')!
  await act(async () => copy.click())
  await menu(second, 'shift-f10')
  await advance(1)
  const current = document.querySelector<HTMLElement>('.focus-context-menu')!
  expect(current?.dataset.agentSessionId).toBe(second)
  expect(current.contains(document.activeElement)).toBe(true)
  expect(select).not.toHaveBeenCalled()
})
it('Escape returns to the exact menu trigger without opening another preview', async () => {
  await menu(second, true)
  await act(async () => document.querySelector('.focus-context-menu')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
  await advance(1)
  expect(document.querySelector('.focus-context-menu')).toBeNull(); expect(document.activeElement).toBe(card())
  expect(preview()).toBeNull()
  await act(async () => destination.focus()); await pointer(card(), 'pointerover'); await advance(180)
  expect(preview()).toBeTruthy()
})
it('renames only the exact Agent, cancels safely, and clearing restores the existing derived name', async () => {
  const before = useAppStore.getState()
  await menu(); await choose('Rename Agent'); const input = await value('Discard this')
  expect(document.activeElement).toBe(input); expect(input.closest('button')).toBeNull()
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(useAppStore.getState().agentNames).toBe(before.agentNames); expect(document.activeElement).toBe(card())
  await menu(); await choose('Rename Agent'); const next = await value('Current renamed Agent')
  await act(async () => next.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().agentNames[second]).toBe('Current renamed Agent')) })
  expect(useAppStore.getState().agentNames[second]).toBe('Current renamed Agent'); expect(useAppStore.getState().agentNames[first]).toBe(before.agentNames[first])
  expect(document.activeElement).toBe(card()); expect(select).not.toHaveBeenCalled()
  await menu(); await choose('Rename Agent'); const clear = await value('   ')
  await act(async () => clear.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().agentNames[second]).toBeUndefined()) })
  expect(useAppStore.getState().agentNames[second]).toBeUndefined(); expect(card().querySelector('strong')!.textContent).toBe('Derived task for ' + second)
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus); expect(useAppStore.getState().sessions).toBe(before.sessions)
})
it('preserves IME editing and commits blur without taking later input focus', async () => {
  await menu(); await choose('Rename Agent'); const input = await value('中文名称')
  for (const key of ['Enter', 'Escape']) await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, isComposing: true })))
  expect(container.querySelector('.focus-context__rename')).toBe(input); expect(useAppStore.getState().agentNames[second]).toBe('Same visible Agent')
  await act(async () => destination.focus()); await advance(1)
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().agentNames[second]).toBe('中文名称')) })
  expect(useAppStore.getState().agentNames[second]).toBe('中文名称'); expect(document.activeElement).toBe(destination)
})
