// @vitest-environment happy-dom
import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest, readAgentSessionHistory } from '@agentmux/core'
import type { AgentMuxDesktopFocusResult, AgentMuxDesktopFocusTarget } from '@agentmux/core/control'
import { createAgentMuxSearchReader } from '../../../packages/core/src/search-reader'
import { readAgentMuxSearch } from '@agentmux/core/search'
import type { AgentSessionHistoryContentPart, AgentTimelineItem } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { App } from '../src/renderer/src/App'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import * as observation from '../src/renderer/src/lib/agent-observation'
import * as presentation from '../src/renderer/src/lib/session-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { installNativePopover } from './fixtures/mote-workface'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/contracts'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
// Actual App/Store/Workbench/SessionPane/TerminalView focus owners run. The Run API,
// terminal DOM paint/addons and geometry are isolated leaves; native proof covers real I/O.
vi.mock('react-resizable-panels', async () => {
  // The browser build registers real Panels in happy-dom; the Node build registers none.
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})

vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    fixtureInput: HTMLTextAreaElement | null = null
    open(host: HTMLElement) { this.element = document.createElement('div'); this.element.className = 'xterm'
      this.fixtureInput = document.createElement('textarea'); this.fixtureInput.className = 'xterm-helper-textarea'; this.element.append(this.fixtureInput); host.append(this.element) }
    refresh() {}
    focus() { this.fixtureInput?.focus() }
    onRender = () => ({ dispose() {} })
    onSelectionChange = () => ({ dispose() {} })
    getSelection() { return '' }
    hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({ TerminalViewportSynchronizer: class {
  beginReplay() {} endReplay() {} acceptOwnerSize() {} setInteractiveResize() {} setVisible() {} observeViewport() {}
  async startLiveSynchronization() {} dispose() {}
} }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))

const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
  executors: { fixture: { label: 'Fixture', providerId: 'codex', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'source', name: 'Source', hostId: 'local', path: fixturePath("source"), kind: 'folder' },
    { id: 'target', name: 'Target', hostId: 'local', path: fixturePath("target"), kind: 'folder' },
    { id: 'empty', name: 'Empty directory', hostId: 'local', path: fixturePath("empty"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const space = directoryIdentity('local', fixturePath("target")), zone = workspaceZoneId(space, 'target')
function agent(id: string, workspace: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', hostId: 'local', executorId: 'fixture', providerId: 'codex', workspacePath: fixturePath(workspace), label: id,
    createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1), agentSessionUpdatedAt: fixtureEpoch(0, 0, 1), processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: fixtureEpoch(0, 0, 1) },
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run:${id}` } } }
}
const source = agent('source-agent', 'source'), target = agent('target-agent', 'target')
const sourceTab = createWorkbenchTab('source-tab', { kind: 'agent', phase: 'attached', workspaceId: 'source', regionId: 'source-region', sessionId: source.id })
const targetTab = createWorkbenchTab('target-tab', { kind: 'agent', phase: 'attached', workspaceId: 'target', regionId: 'target-region', sessionId: target.id })
const goal = (id: string, sessionIds: string[] = []) => ({ id, title: id, description: '', status: 'in_progress' as const,
  priority: 'normal' as const, projectId: null, projectName: null, sessionIds, source: 'default-topic' as const, createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) })
let root: Root, container: HTMLDivElement, outside: HTMLTextAreaElement, dispose: (() => void) | undefined, restorePopover: (() => void) | undefined
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) }) }
async function control(target: AgentMuxDesktopFocusTarget, inputPolicy: 'preserve' | 'target' = 'preserve') {
  let pending!: Promise<unknown>
  await act(async () => {
    pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: crypto.randomUUID(),
      operation: 'focus', target, inputPolicy }))
    await Promise.resolve()
  })
  const result = await pending as AgentMuxDesktopFocusResult
  const { operation, ...body } = result
  expect(parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'private', operation, ok: true, result: body })).toMatchObject({ result: body })
  await settle()
  return result
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  restorePopover = installNativePopover()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) })
  window.localStorage.clear()
  useAppStore.setState({ ...initial, restoredWorkbench: null, config: null }, true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'attach').mockImplementation(async control => ({ attachmentId: `attachment:${control.run.runId}`,
    session: control.run.runId === source.control.run.runId ? source : target, currentSize: { cols: 80, rows: 24 }, gap: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [] }))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  dispose = await useAppStore.getState().initialize()
  useAppStore.setState({ initialize: vi.fn(async () => () => {}), loading: false, config, sessions: [source, target],
    tabs: { [sourceTab.id]: sourceTab, [targetTab.id]: targetTab },
    layouts: { source: createWorkspaceLayout('source-group', [sourceTab.id]), target: createWorkspaceLayout('target-group', [targetTab.id]), empty: createWorkspaceLayout('empty-group') },
    activeWorkspaceId: 'source', mainSurface: 'workbench', workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
    demands: { first: goal('first', [source.id]), exact: goal('exact') }, selectedDemandId: 'first',
    agentFocus: { execution: { sessionId: source.id, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [source.id]: 'Unsent original draft' } })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async workspaceId => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: config.workspaces.find(workspace => workspace.id === workspaceId)!.path }))
  container = document.createElement('div'); outside = document.createElement('textarea'); outside.value = 'Keep user input'
  document.body.append(container, outside); root = createRoot(container)
  await act(async () => root.render(createElement(App))); await settle(); outside.focus(); outside.setSelectionRange(2, 5)
})
afterEach(async () => {
  await act(async () => root.unmount()); dispose?.(); dispose = undefined
  restorePopover?.(); restorePopover = undefined
  container.remove(); outside.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear()
})

const reply: AgentTimelineItem = { id: 'retained-source-reply', agentSessionId: source.id, kind: 'assistant_message', source: 'native-hook',
  status: 'complete', title: 'Original reply', content: 'Original source body retained for reading.', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }
async function query(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function focus() {
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [source.id]: { agentSessionId: source.id, revision: 1, items: [reply] } } })))
  await control({ kind: 'space', regionId: 'source-region' })
  await control({ kind: 'surface', surface: 'focus' })
  await settle()
  expect(container.querySelector('.global-focus-surface')).not.toBeNull()
}
function historyReader() {
  return createAgentMuxSearchReader({ metadata: async () => { throw new Error('This text reader cannot discover metadata') },
    sources: async () => ({ sources: [{ hostId: 'local', sourceHostId: 'local', agentSessionId: source.id, source: 'captured' }], issues: [] }),
    history: (input, context) => readAgentSessionHistory({ sessionHistorySources: async () => [{ hostId: 'local', agentSessionId: source.id, state: 'active' }],
      sessionHistoryPage: async () => { throw new Error('This captured record reader cannot request native history') },
      sessionTimeline: async () => ({ agentSessionId: source.id, revision: 1, items: [reply] }) }, input, context) })
}
function nativeReader(contentParts: AgentSessionHistoryContentPart[]) {
  const nativeSource = { providerId: 'codex' as const, nativeSessionId: 'original-native' }
  const descriptor = { hostId: 'local', agentSessionId: source.id, state: 'active' as const, history: {
    providerId: 'codex' as const, executorId: 'fixture', workspacePath: source.workspacePath, createdAt: source.createdAt,
    nativeHandle: { kind: 'provider' as const, providerId: 'codex' as const, sessionId: nativeSource.nativeSessionId } } }
  vi.mocked(api.sessions.historySources).mockResolvedValue([descriptor])
  const reader = createAgentMuxSearchReader({ metadata: async () => { throw new Error('Text reads cannot discover metadata') },
    sources: async () => ({ sources: [{ hostId: 'local', sourceHostId: 'local', agentSessionId: source.id, source: 'native', nativeSource }], issues: [] }),
    history: (input, context) => readAgentSessionHistory({ sessionHistorySources: async () => [descriptor],
      sessionTimeline: async () => ({ agentSessionId: source.id, revision: 0, items: [] }),
      sessionHistoryPage: async () => ({ agentSessionId: source.id, source: nativeSource, nextCursor: null,
        items: [{ id: 'original-resource-record', kind: 'assistant-message', contentParts }] }) }, input, context) })
  vi.spyOn(api.search, 'query').mockImplementation((input, context) => readAgentMuxSearch(input, (value, signal) => reader.read(value, signal ? { signal } : {}), context))
  return nativeSource
}
async function expandNativeHit() {
  await query('body')
  await act(async () => container.querySelector('[aria-label="Search contexts"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await settle()
  const hit = container.querySelector<HTMLDetailsElement>('.focus-history-hit')!
  expect(hit).not.toBeNull()
  await act(async () => { hit.open = true; hit.dispatchEvent(new Event('toggle')) })
  return hit
}
async function openStop(entry: 'card' | 'toolbar') {
  const origin = container.querySelector<HTMLElement>(entry === 'card' ? `button[data-session-id="${source.id}"]` : '[aria-label="Focus context actions"]')!
  expect(origin).not.toBeNull()
  await act(async () => { origin.focus(); origin.dispatchEvent(entry === 'toolbar'
    ? new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    : new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 })) })
  await settle()
  const stop = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Stop Agent')!
  expect(stop).toBeDefined(); await act(async () => stop.click()); await settle()
  expect(document.querySelector('.confirmation-dialog')?.textContent).toContain('Stop Agent?')
}

describe('actual App Focus residency', () => {
  it('dismisses the open filter menu before Goal viewing without restoring an inactive focus target', async () => {
    await focus()
    const trigger = container.querySelector<HTMLElement>('[aria-label="Focus filters"]')!
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.querySelector('[data-focus-state="idle"]')).not.toBeNull()
    await control({ kind: 'goal', goalId: 'exact' })
    expect(document.querySelector('[data-focus-state="idle"]')).toBeNull()
    outside.focus(); await control({ kind: 'surface', surface: 'focus' })
    expect(document.querySelector('[data-focus-state="idle"]')).toBeNull(); expect(document.activeElement).toBe(outside)
  })
  it('dismisses a temporary historical observation before Goal viewing so return cannot steal later input', async () => {
    await focus()
    await act(async () => useAppStore.setState({ agentFocus: { execution: { sessionId: source.id, history: [{ sessionId: 'archived-agent',
      focusedAt: Date.now() - 10_000, identity: { name: 'Original archived work', kind: 'agent', providerId: 'codex', hostId: 'local',
        workspacePath: source.workspacePath, project: { id: 'source', name: 'Source' } } }] }, pmo: { sessionId: null } } }))
    const marker = container.querySelector<HTMLButtonElement>('[data-focus-timeline-id="archived-agent"] .recent-focus__segment')!
    expect(marker).not.toBeNull(); await act(async () => marker.click())
    expect(document.querySelector('.recent-focus__observation')).not.toBeNull()
    await control({ kind: 'goal', goalId: 'exact' })
    expect(document.querySelector('.recent-focus__observation')).toBeNull(); outside.focus()
    await control({ kind: 'surface', surface: 'focus' })
    expect(document.querySelector('.recent-focus__observation')).toBeNull(); expect(document.activeElement).toBe(outside)
  })
  it.each(['card', 'toolbar'] as const)('drops the unconfirmed %s Stop dialog without issuing a command or replaying focus', async entry => {
    await focus(); const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    await openStop(entry)
    await control({ kind: 'goal', goalId: 'exact' })
    expect(document.querySelector('.confirmation-dialog')).toBeNull()
    outside.focus(); await control({ kind: 'surface', surface: 'focus' })
    expect(document.querySelector('.confirmation-dialog')).toBeNull(); expect(document.activeElement).toBe(outside)
    expect(stop).not.toHaveBeenCalled()
  })
  it('keeps an already-issued exact Stop running across Goal viewing without reopening its old confirmation', async () => {
    await focus(); let finish!: () => void
    const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await openStop('card')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-confirm-label="Stop Agent"]')!.click())
    expect(stop).toHaveBeenCalledExactlyOnceWith(source.control)
    const before = useAppStore.getState()
    await control({ kind: 'goal', goalId: 'exact' }); outside.focus()
    await control({ kind: 'surface', surface: 'focus' })
    expect(document.querySelector('.confirmation-dialog')).toBeNull(); expect(document.activeElement).toBe(outside)
    await act(async () => finish()); await settle()
    expect(stop).toHaveBeenCalledOnce(); expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(document.querySelector('.confirmation-dialog')).toBeNull(); expect(document.activeElement).toBe(outside)
  })
  it('cancels the original native resource intent on Goal viewing and preserves completed body DOM and selection on return', async () => {
    await focus()
    const text = 'Original body **selected** resource ' + 'retained '.repeat(200)
    const bytes = Buffer.from(JSON.stringify({ kind: 'text', text })), sha256 = createHash('sha256').update(bytes).digest('hex'), middle = Math.floor(bytes.length / 2)
    const nativeSource = nativeReader([{ kind: 'text', text: 'Original body resource' }, { kind: 'resource', resourceType: 'text', reference: 'original-text',
      content: { kind: 'text', encoding: 'json-utf8', byteLength: bytes.length, sha256 } }])
    let finish!: () => void
    const resource = vi.spyOn(api.sessions, 'historyResource').mockImplementation((reference, input) => {
      const offset = input.offsetBytes ?? 0, end = offset === 0 ? middle : bytes.length, fragment = bytes.subarray(offset, end)
      const result = { agentSessionId: reference.agentSessionId, source: nativeSource, recordId: input.recordId, partIndex: input.partIndex,
        reference: input.expectedReference, result: { status: 'fragment' as const, encoding: 'json-utf8' as const, dataBase64: fragment.toString('base64'),
          byteLength: fragment.length, offsetBytes: offset, totalBytes: bytes.length, sha256, nextOffsetBytes: end === bytes.length ? null : end } }
      return offset === 0 ? new Promise(resolve => { finish = () => resolve(result) }) : Promise.resolve(result)
    })
    const hit = await expandNativeHit(), read = () => [...hit.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Read complete content'))!
    expect(read()).toBeDefined(); await act(async () => read().click()); expect(resource).toHaveBeenCalledTimes(1)
    await control({ kind: 'goal', goalId: 'exact' })
    await act(async () => { finish(); await Promise.resolve() })
    expect(resource).toHaveBeenCalledTimes(1); expect(hit.querySelector('.conversation-resource-text strong')).toBeNull()
    await control({ kind: 'surface', surface: 'focus' })
    expect(read().disabled).toBe(false); expect(resource).toHaveBeenCalledTimes(1)
    await act(async () => read().click()); await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(resource).toHaveBeenCalledTimes(3)
    const prose = hit.querySelector('.conversation-resource-text strong')!
    expect(prose.textContent).toBe('selected')
    const range = document.createRange(); range.selectNodeContents(prose); window.getSelection()!.addRange(range)
    await control({ kind: 'goal', goalId: 'exact' }); outside.focus()
    await control({ kind: 'surface', surface: 'focus' })
    expect(hit.querySelector('.conversation-resource-text strong')).toBe(prose)
    expect(window.getSelection()!.toString()).toBe('selected'); expect(document.activeElement).toBe(outside)
    expect(resource).toHaveBeenCalledTimes(3)
  })

  it.each(['Timeline meaning and coverage', 'Focus timeline settings'])('closes the original %s portal without replaying it or focus on return', async label => {
    await focus()
    const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
    expect(trigger).not.toBeNull(); await act(async () => { trigger.focus(); trigger.click() })
    expect(document.querySelector('.recent-focus__legend-dialog, .focus-ruler-settings')).not.toBeNull()
    await control({ kind: 'goal', goalId: 'exact' })
    expect(document.querySelector('.recent-focus__legend-dialog, .focus-ruler-settings')).toBeNull()
    outside.focus(); await control({ kind: 'surface', surface: 'focus' })
    expect(document.querySelector('.recent-focus__legend-dialog, .focus-ruler-settings')).toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it.each(['Resize Focus workspace', 'Resize Focus timeline'])('ends the original %s drag on Goal viewing before later pointer events', async label => {
    await focus()
    const handle = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!, previous = useAppStore.getState().focusTimelineHeight
    expect(handle).not.toBeNull()
    await act(async () => handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 })))
    expect(document.body.style.cursor).not.toBe('')
    await control({ kind: 'goal', goalId: 'exact' })
    expect(document.body.style.cursor).toBe(''); expect(document.body.style.userSelect).toBe('')
    await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { clientY: -400 })); window.dispatchEvent(new PointerEvent('pointerup')) })
    expect(useAppStore.getState().focusTimelineHeight).toBe(previous)
    await control({ kind: 'surface', surface: 'focus' })
    await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { clientY: -300 })); window.dispatchEvent(new PointerEvent('pointerup')) })
    expect(useAppStore.getState().focusTimelineHeight).toBe(previous)
  })
  it('adds no hidden Global directory projection for unrelated bytes or statuses and catches up on return', async () => {
    const subjects = Array.from({ length: 80 }, (_, index) => agent(`cost-agent-${index}`, 'source'))
    await act(async () => { useAppStore.setState({ mainSurface: 'agents', sessions: subjects }); root.render(<GlobalFocusSurface workspaceOpen={false} />) })
    expect(container.querySelectorAll('.focus-context[data-session-id]')).toHaveLength(subjects.length)
    const reader = historyReader()
    vi.spyOn(api.search, 'query').mockImplementation((input, context) => readAgentMuxSearch(input, (value, signal) => reader.read(value, signal ? { signal } : {}), context))
    await query('body')
    await act(async () => container.querySelector('[aria-label="Search contexts"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle(); expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(1)
    await act(async () => root.render(<GlobalFocusSurface visible={false} workspaceOpen={false} />))
    const observe = vi.spyOn(observation, 'observeAgentSession')
    const index = vi.spyOn(presentation, 'agentSessionPresentationIndex')
    for (let revision = 1; revision <= 12; revision++) await act(async () => useAppStore.setState({ sessions: subjects.map((session, index) => ({ ...session,
      latestOutputBytes: revision * 4096, status: { ...session.status, state: index === 0 && revision % 2 === 0 ? 'error' : 'running' } })) }))
    expect(observe).not.toHaveBeenCalled()
    expect(index).not.toHaveBeenCalled()
    const before = useAppStore.getState().agentFocus
    await act(async () => root.render(<GlobalFocusSurface workspaceOpen={false} />))
    expect(observe.mock.calls.length).toBeGreaterThanOrEqual(subjects.length)
    await query('')
    expect(container.querySelector('.focus-context[data-session-id="cost-agent-0"]')?.getAttribute('data-state')).toBe('error')
    expect(useAppStore.getState().agentFocus).toBe(before)
  })
  it('retains the original Focus query, filters, scroll, expanded record and workface across Goal-only viewing', async () => {
    const reader = historyReader(), read = vi.spyOn(api.search, 'query').mockImplementation((input, context) => readAgentMuxSearch(input, (value, signal) => reader.read(value, signal ? { signal } : {}), context))
    await focus()
    await query('body')
    const surface = container.querySelector<HTMLElement>('.global-focus-surface')!
    const toolbar = surface.querySelector('.focus-toolbar__context')!
    const workface = surface.querySelector('.global-session-workspace')!
    const originalInput = container.querySelector('.xterm-helper-textarea')
    const project = surface.querySelector<HTMLButtonElement>('.focus-project-lanes__axis')!
    expect(project).not.toBeNull()
    await act(async () => project.click())
    const filters = surface.querySelector<HTMLElement>('[aria-label="Focus filters"]')!
    await act(async () => filters.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const idle = document.querySelector<HTMLElement>('[data-focus-state="idle"]')!
    expect(idle).not.toBeNull()
    await act(async () => idle.click())
    const filterDescription = filters.getAttribute('aria-description')
    expect(filterDescription).not.toBe('All projects · All states')
    await act(async () => surface.querySelector('[aria-label="Search contexts"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle()
    const hit = surface.querySelector<HTMLDetailsElement>('.focus-history-hit')!
    expect(hit).not.toBeNull()
    await act(async () => { hit.open = true; hit.dispatchEvent(new Event('toggle')) })
    expect(hit.textContent).toContain(reply.content)
    const results = surface.querySelector<HTMLElement>('.focus-history-search')!
    results.scrollTop = 73
    const board = surface.querySelector<HTMLElement>('.focus-project-lanes')!
    board.scrollTop = 137; board.scrollLeft = 19
    const windowSize = surface.querySelector<HTMLSelectElement>('[aria-label="Focus window size"]')!
    const windowChoice = windowSize.options[windowSize.options.length - 1]!.value
    await act(async () => { windowSize.value = windowChoice; windowSize.dispatchEvent(new Event('change', { bubbles: true })) })
    const original = useAppStore.getState()
    outside.focus()
    await control({ kind: 'goal', goalId: 'exact' })
    expect(container.querySelector('[data-goal-detail-id="exact"]')).not.toBeNull()
    expect(container.querySelector('.global-focus-surface')).toBe(surface)
    expect(surface.hidden).toBe(true); expect(surface.hasAttribute('inert')).toBe(true); expect(surface.style.display).toBe('none')
    expect(surface.querySelector('.focus-toolbar__context')).toBe(toolbar)
    expect(surface.querySelector('.global-session-workspace')).toBe(workface)
    expect(originalInput?.isConnected).toBe(true)
    expect(document.activeElement).toBe(outside)
    const reads = read.mock.calls.length
    await control({ kind: 'surface', surface: 'focus' })
    expect(container.querySelector('.global-focus-surface')).toBe(surface)
    expect(surface.hidden).toBe(false); expect(surface.hasAttribute('inert')).toBe(false)
    expect(surface.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!.value).toBe('body')
    expect(surface.querySelector('[aria-label="Focus filters"]')!.getAttribute('aria-description')).toBe(filterDescription)
    expect(surface.querySelector('.focus-history-hit')).toBe(hit); expect(hit.open).toBe(true)
    expect(results.scrollTop).toBe(73); expect(board.scrollTop).toBe(137); expect(board.scrollLeft).toBe(19)
    expect(surface.querySelector<HTMLSelectElement>('[aria-label="Focus window size"]')!.value).toBe(windowChoice)
    expect(read).toHaveBeenCalledTimes(reads)
    expect(useAppStore.getState().agentFocus).toBe(original.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  })

  it('releases the pending history reader and dormant hierarchy while later navigation owns the screen', async () => {
    await focus()
    await query('body')
    const reader = historyReader()
    let finish!: () => void, signal: AbortSignal | undefined
    const read = vi.spyOn(api.search, 'query').mockImplementation((input, context) => {
      signal = context?.signal
      return new Promise(resolve => { finish = () => { void readAgentMuxSearch(input, value => reader.read(value, {})).then(resolve) } })
    })
    await act(async () => container.querySelector('[aria-label="Search contexts"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(read).toHaveBeenCalledOnce(); expect(signal?.aborted).toBe(false)
    const branches = vi.mocked(api.workspaces.listBranches)
    await control({ kind: 'goal', goalId: 'exact' })
    expect(signal?.aborted).toBe(true)
    const before = branches.mock.calls.length
    await act(async () => useAppStore.setState({ workspaceFileRevisions: { source: 9, target: 4 } }))
    await settle()
    expect(branches).toHaveBeenCalledTimes(before)
    await control({ kind: 'surface', surface: 'survey' })
    await act(async () => { finish(); await Promise.resolve() }); await settle()
    expect(useAppStore.getState().mainSurface).toBe('survey')
    expect(container.querySelector('.focus-history-hit')).toBeNull()
    expect(document.querySelector('.focus-context-hover, .workbench-topology__inspector--portal, [role="dialog"][aria-label="Message"]')).toBeNull()
    await control({ kind: 'surface', surface: 'focus' })
    expect(container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!.value).toBe('body')
    expect(container.querySelector('.focus-history-hit')).toBeNull()
    expect(read).toHaveBeenCalledOnce()
  })
})

describe('actual App Focus Goal access', () => {
  it.each(['native navigation', 'public surface target'] as const)('returns to an original scan-only Focus through %s without creating a spatial choice or opening an Agent workface', async entry => {
    await act(async () => useAppStore.setState({ mainSurface: 'agents', workbenchSpaceSelection: null,
      agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
      demands: { observed: { ...goal('observed'), supervisorSessionId: source.control.agentSessionId } } }))
    await settle()
    const surface = container.querySelector<HTMLElement>('.global-focus-surface')!
    expect(surface).not.toBeNull(); expect(surface.querySelector('.global-session-workspace')).toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toBeNull(); expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
    expect(useAppStore.getState().layouts.source!.groups.some(group => group.tabOrder.includes(sourceTab.id))).toBe(true)
    await query(source.id)
    const trigger = surface.querySelector<HTMLButtonElement>('.focus-goal__trigger')!
    expect(trigger).not.toBeNull(); expect(trigger.getAttribute('data-goal-host-unconfirmed')).toBe('true')
    const before = useAppStore.getState()
    await act(async () => trigger.click()); await settle()
    expect(container.querySelector('[data-goal-detail-id="observed"]')).not.toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toBeNull(); expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    if (entry === 'native navigation') {
      const back = container.querySelector<HTMLButtonElement>('.surface-navigation__focus')!
      expect(back).not.toBeNull(); await act(async () => back.click()); await settle()
    } else await control({ kind: 'surface', surface: 'focus' })
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(container.querySelector('.global-focus-surface')).toBe(surface)
    expect(surface.querySelector('.global-session-workspace')).toBeNull()
    expect(surface.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!.value).toBe(source.id)
    const explicitSpace = await control({ kind: 'surface', surface: 'space' })
    expect(explicitSpace.navigation.selection.space?.tabId).toBe(sourceTab.id)
    expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe('source-region')
  })
  it.each(['native Goals navigation', 'public Goals target'] as const)('keeps an original scan-only Focus empty across %s and return', async entry => {
    await act(async () => useAppStore.setState({ mainSurface: 'agents', workbenchSpaceSelection: null, selectedDemandId: null,
      agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
      demands: { observed: { ...goal('observed'), supervisorSessionId: source.control.agentSessionId } } }))
    await settle()
    const surface = container.querySelector<HTMLElement>('.global-focus-surface')!
    expect(surface.querySelector('.global-session-workspace')).toBeNull()
    const before = useAppStore.getState()
    if (entry === 'native Goals navigation') {
      const goals = container.querySelector<HTMLButtonElement>('.surface-navigation__slot[aria-label^="Goals:"]')!
      expect(goals).not.toBeNull(); await act(async () => goals.click()); await settle()
    } else await control({ kind: 'surface', surface: 'goals' })
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.surface-navigation__focus')!.click()); await settle()
    expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus); expect(useAppStore.getState().selectedDemandId).toBeNull()
    expect(container.querySelector('.global-focus-surface')).toBe(surface); expect(surface.querySelector('.global-session-workspace')).toBeNull()
  })
  async function linkedGoal() {
    await focus()
    await act(async () => useAppStore.setState({ demands: { linked: { ...goal('linked'), title: 'Exact linked Goal',
      participations: [{ id: 'original-discussion', operationId: 'original-discussion', kind: 'discussion', hostId: source.control.hostId,
        agentSessionId: source.control.agentSessionId, entryPoint: 'original-entry', recordedAt: fixtureEpoch(0, 0, 1) }] } } }))
    const card = container.querySelector<HTMLButtonElement>(`button[data-session-id="${source.id}"]`)!
    const trigger = card.parentElement!.querySelector<HTMLButtonElement>('.focus-goal__trigger')!
    expect(card).not.toBeNull(); expect(trigger).not.toBeNull(); expect(card.contains(trigger)).toBe(false)
    return { card, trigger }
  }
  it('opens the exact related Goal from the original card and returns to the same App Focus reader and workface', async () => {
    const { card, trigger } = await linkedGoal()
    await query(source.id)
    const surface = container.querySelector<HTMLElement>('.global-focus-surface')!, workspace = surface.querySelector('.global-session-workspace')!
    const board = surface.querySelector<HTMLElement>('.focus-project-lanes')!; board.scrollTop = 127
    const before = useAppStore.getState(), originalInput = container.querySelector('.xterm-helper-textarea')
    const effects = ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const
    for (const name of effects) vi.spyOn(api.sessions, name)
    outside.focus(); outside.setSelectionRange(2, 5)
    await act(async () => trigger.click()); await settle()
    expect(container.querySelector('[data-goal-detail-id="linked"]')).not.toBeNull()
    expect(useAppStore.getState().selectedDemandId).toBe('linked')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(originalInput?.isConnected).toBe(true); expect(document.activeElement).toBe(outside)
    await control({ kind: 'surface', surface: 'focus' })
    expect(container.querySelector('.global-focus-surface')).toBe(surface); expect(surface.querySelector('.global-session-workspace')).toBe(workspace)
    expect(container.querySelector(`button[data-session-id="${source.id}"]`)).toBe(card)
    expect(surface.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!.value).toBe(source.id)
    expect(board.scrollTop).toBe(127); expect(document.activeElement).toBe(outside)
    expect([outside.selectionStart, outside.selectionEnd]).toEqual([2, 5])
    for (const name of effects) expect(api.sessions[name]).not.toHaveBeenCalled()
  })

  it('retains an applied Goal and its existing presentation notice when an overlay makes the exact receipt partial', async () => {
    const { trigger } = await linkedGoal()
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
      { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: fixturePath('scratch-goals'), name: 'Topics', kind: 'folder' }] } })))
    let finish!: (topics: []) => void
    vi.spyOn(api.scratch, 'listTopics').mockImplementationOnce(() => new Promise<[]>(resolve => { finish = resolve })).mockResolvedValue([])
    await act(async () => trigger.click()); expect(finish).toBeDefined()
    const beforeError = useAppStore.getState().error
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click()); await settle()
    await act(async () => finish([])); await settle()
    expect(useAppStore.getState().selectedDemandId).toBe('linked')
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().error).toBe(beforeError)
    expect(useAppStore.getState().desktopNavigationNotice?.code).toBe('DESKTOP_PRESENTATION_PARTIAL')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click()); await settle()
    expect(container.querySelector('[data-goal-detail-id="linked"]')).not.toBeNull()
  })
})
