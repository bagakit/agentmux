// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover } from './fixtures/mote-workface'

// Same bounded native leaves as desktop-focus-navigation.test.tsx. Actual App,
// Store, Workbench, SessionPane and TerminalView navigation owners all run.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    fixtureInput: HTMLTextAreaElement | null = null
    open(host: HTMLElement) {
      this.element = document.createElement('div'); this.element.className = 'xterm'
      this.fixtureInput = document.createElement('textarea'); this.fixtureInput.className = 'xterm-helper-textarea'
      this.element.append(this.fixtureInput); host.append(this.element)
    }
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
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({ TerminalViewportSynchronizer: class {
  beginReplay() {} endReplay() {} acceptOwnerSize() {} setInteractiveResize() {} setVisible() {} observeViewport() {}
  async startLiveSynchronization() {} dispose() {}
} }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))

const initial = useAppStore.getState(), workspace = composerConfig.workspaces[0]!
const originalAgent = composerSession('focus-editor-original'), otherAgent = composerSession('focus-editor-other')
const originalTab = createWorkbenchTab('focus-editor-original-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
  regionId: 'focus-editor-original-region', sessionId: originalAgent.id })
const otherTab = createWorkbenchTab('focus-editor-other-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
  regionId: 'focus-editor-other-region', sessionId: otherAgent.id })
const reference = { displayWorkspaceId: workspace.id, groupId: 'focus-editor-group', tabId: originalTab.id, regionId: originalTab.layout.activeRegionId }
let root: Root, host: HTMLDivElement, restorePopover: () => void, dispose: (() => void) | undefined
// The Map entry suite reuses this exact mounted App and its native leaf fixture.
export const focusEditorAppFixture = { get host() { return host }, originalAgent, settle, until }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) }) }
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(predicate()).toBe(true)
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  restorePopover = installNativePopover(); window.localStorage.clear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}) })
  useAppStore.setState({ ...initial, restoredWorkbench: null, config: null }, true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'attach').mockImplementation(async control => ({ attachmentId: `attachment:${control.run.runId}`,
    session: control.run.runId === originalAgent.control.run.runId ? originalAgent : otherAgent, currentSize: { cols: 80, rows: 24 },
    gap: null, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [] }))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
  dispose = await useAppStore.getState().initialize()
  const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() }
  useAppStore.setState({ initialize: vi.fn(async () => () => {}), loading: false, config: composerConfig,
    sessions: [{ ...originalAgent, status, semanticStatus: { ...status, stateEnteredAt: Date.now() } }, otherAgent],
    tabs: { [originalTab.id]: originalTab, [otherTab.id]: otherTab }, layouts: { [workspace.id]: createWorkspaceLayout('focus-editor-group', [otherTab.id, originalTab.id]) },
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', focusView: 'list', workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
    agentFocus: { execution: { sessionId: otherAgent.id, history: [] }, pmo: { sessionId: null } },
    agentNames: { [originalAgent.id]: 'Original saved Agent name', [otherAgent.id]: 'Other Agent' },
    agentComposerDrafts: { [originalAgent.id]: 'Original unsent conversation draft' }, timelines: {} })
  vi.spyOn(api.spatial, 'renameLabel').mockRejectedValue(new Error('Private name write failed; original Agent stays healthy'))
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  await act(async () => root.render(<App />)); await settle()
  await act(async () => host.querySelector<HTMLButtonElement>('footer [aria-label^="Focus: show execution contexts."]')!.click()); await settle()
})
afterEach(async () => {
  await act(async () => root.unmount()); dispose?.(); dispose = undefined; restorePopover()
  host.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear()
})

it.each([false, true])('actual App opens the original workface and returns with its pending Agent name intact (earlier name write failed: %s)', async failBeforeOpen => {
  const list = host.querySelector<HTMLElement>('[data-desktop-focus-view="list"]')!
  const card = list.querySelector<HTMLElement>(`button.focus-context[data-session-id="${originalAgent.id}"]`)!
  expect(card).toBeTruthy()
  await act(async () => { card.focus(); card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })) })
  await until(() => Boolean(document.querySelector('.focus-context-menu')))
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Rename Agent')!
  expect(rename).toBeTruthy(); await act(async () => rename.click())
  await until(() => Boolean(list.querySelector('.focus-context--renaming input')))
  const input = list.querySelector<HTMLInputElement>('.focus-context--renaming input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Original pending Agent name')
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(2, 13)
  })
  if (failBeforeOpen) {
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
    await until(() => Boolean(useAppStore.getState().nameEditFailure))
    expect(api.spatial.renameLabel).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'agent-session', id: originalAgent.id }, value: 'Original pending Agent name' }))
    expect(useAppStore.getState().nameEditFailure?.target).toEqual({ kind: 'agent-session', id: originalAgent.id })
    expect(list.querySelector('.focus-context--renaming input')).toBe(input)
  }
  const pendingInteraction = { kind: 'permission' as const, id: 'focus-editor-original-permission', agentSessionId: originalAgent.id,
    title: 'Review original Agent request', options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' as const }],
    evidence: { source: 'native-hook' as const, observedAt: Date.now(), run: originalAgent.control.run, hookReceiptId: 'focus-editor-original-hook' } }
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id !== originalAgent.id ? session : { ...session,
    status: { state: 'waiting', source: 'native-hook', observedAt: Date.now() }, pendingInteraction }) })))
  const before = useAppStore.getState(), controls = [vi.spyOn(api.sessions, 'respondInteraction'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'write')]
  const open = list.querySelector<HTMLButtonElement>('.focus-context__rename-open')!
  expect(open).toBeTruthy(); const writesBefore = vi.mocked(api.spatial.renameLabel).mock.calls.length
  await act(async () => { open.focus(); open.click() }); await settle()
  expect(vi.mocked(api.spatial.renameLabel).mock.calls.length).toBe(writesBefore)
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().agentFocus.execution.reference).toEqual(reference)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: reference.displayWorkspaceId,
    groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId })
  expect(host.querySelector(`[data-workbench-region-id="${reference.regionId}"] .xterm`)).toBeTruthy()
  expect(list.querySelector('.focus-context--renaming input')).toBe(input); expect(input.value).toBe('Original pending Agent name')
  const space = host.querySelector<HTMLButtonElement>('footer [aria-label="Space: show terminal and file workbench"]')!
  await act(async () => { space.focus(); space.click() }); await settle()
  expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(list.hidden).toBe(true)
  const focus = host.querySelector<HTMLButtonElement>('footer [aria-label^="Focus: show execution contexts."]')!
  await act(async () => { focus.focus(); focus.click() }); await settle()
  expect(host.querySelector('[data-desktop-focus-view="list"]')).toBe(list); expect(list.hidden).toBe(false)
  expect(list.querySelector('.focus-context--renaming input')).toBe(input); expect(input.value).toBe('Original pending Agent name')
  await act(async () => input.focus()); expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 13])
  const after = useAppStore.getState(), session = after.sessions.find(session => session.id === originalAgent.id)!
  expect(after.agentNames[originalAgent.id]).toBe('Original saved Agent name')
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.tabs[originalTab.id]?.regions[reference.regionId]).toBe(before.tabs[originalTab.id]?.regions[reference.regionId])
  expect(session.control).toBe(before.sessions.find(session => session.id === originalAgent.id)!.control)
  expect(session.pendingInteraction).toBe(pendingInteraction); expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0])
})
