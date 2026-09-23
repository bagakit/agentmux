// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
// Terminal rendering is outside close ownership; actual Workbench, modal and Store are mounted.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => <output data-session-id={sessionId}>{sessionId}</output> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <output>Changed editor</output> }))
vi.mock('../src/renderer/src/components/BrowserPane', () => ({ BrowserPane: () => <output>Browser</output> }))
// Use the installed browser implementation: the Node entry omits Panel registration effects.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { dispatchWorkbenchCommand } from '../src/renderer/src/lib/workbench-shortcuts'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState()
let root: Root, element: HTMLDivElement, overlay: HTMLDivElement
const stopped = { ...composerSession('stopped'), processState: 'exited' as const,
  status: { state: 'stopped' as const, source: 'run-process' as const, observedAt: 2 } }
const healthy = composerSession('healthy')
const view = createWorkbenchTab('stopped-view', { kind: 'agent', regionId: 'stopped-region', phase: 'attached', workspaceId: 'workspace', sessionId: stopped.id })
const sibling = createWorkbenchTab('healthy-view', { kind: 'agent', regionId: 'healthy-region', phase: 'attached', workspaceId: 'workspace', sessionId: healthy.id })
const draft = { [stopped.id]: 'Retain stopped draft', [healthy.id]: 'Retain healthy draft' }
const unknownInput = { operationId: 'original-unconfirmed', runId: stopped.control.run.runId, text: 'Unknown delivery', status: 'sending' as const,
  promptCondition: { expectedRun: stopped.control.run, afterSubmissionId: null } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  element = document.createElement('div'); overlay = document.createElement('div'); overlay.dataset.overlayHost = ''
  document.body.append(element, overlay); root = createRoot(element)
  useAppStore.setState({ config: composerConfig, sessions: [stopped, healthy], loading: false, mainSurface: 'workbench', activeWorkspaceId: 'workspace',
    tabs: { [view.id]: view, [sibling.id]: sibling }, layouts: { workspace: createWorkspaceLayout('group', [view.id, sibling.id]) },
    closingWorkbenchViews: {}, closeTabRequest: null, agentComposerDrafts: draft, agentSteerQueues: { [stopped.id]: [unknownInput] },
    workbenchSaveWarning: null, error: null, dirtyDocuments: {}, prewarmTerminal: vi.fn() })
  useAppStore.getState().activateTab('workspace', 'group', view.id)
  vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('Stopping must not gate an already exited View'))
})
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); overlay.remove()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})
async function mount() { await act(async () => root.render(<><WorkspaceWorkbench workspaceId="workspace" /><GlobalSystemNotices /></>)) }
async function closeX() {
  const close = element.querySelector<HTMLElement>('[data-workbench-tab-id="stopped-view"] .workbench-tab__close')
  expect(close).not.toBeNull(); await act(async () => close!.click())
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(button, `Actual close action ${label}`).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}
function retained() {
  expect(useAppStore.getState().sessions).toEqual([stopped, healthy])
  expect(useAppStore.getState().agentComposerDrafts).toEqual(draft)
  expect(useAppStore.getState().agentSteerQueues).toEqual({ [stopped.id]: [unknownInput] })
  expect(useAppStore.getState().tabs[sibling.id]).toEqual(sibling)
}

it('actual Tab X closes a typed exited Agent projection without Stop, and preserves unknown Input and a save notice', async () => {
  useAppStore.getState().reportWorkbenchSaveFailure(new Error('Saving the workbench is unconfirmed: database missing'))
  await mount(); await closeX()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([sibling.id])
  expect(useAppStore.getState().layouts.workspace?.groups[0]?.tabOrder).toEqual([sibling.id])
  expect(api.sessions.stop).not.toHaveBeenCalled(); retained()
  expect(useAppStore.getState().workbenchSaveWarning).toContain('database missing')
  expect(element.textContent).toContain('Saving the workbench is unconfirmed')
})

it('the real keyboard close-region command routes a single exited Region through the same Tab confirmation consumer', async () => {
  await mount()
  await act(async () => { expect(dispatchWorkbenchCommand({ kind: 'close-region' }, useAppStore.getState())).toBe(true) })
  expect(useAppStore.getState().closeTabRequest).toBeNull()
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([sibling.id])
  expect(api.sessions.stop).not.toHaveBeenCalled(); retained()
})

it('actual split X removes only the exited Region, keeping the healthy Region and original Session', async () => {
  const split = addWorkbenchRegion(view, 'stopped-region', 'right', { kind: 'agent', regionId: 'other-region', phase: 'attached', workspaceId: 'workspace', sessionId: healthy.id })
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [view.id]: split } })
  await mount()
  const close = element.querySelector<HTMLButtonElement>('[data-workbench-region-id="stopped-region"] .workbench-region__close')
  expect(close).not.toBeNull(); await act(async () => close!.click())
  expect(Object.keys(useAppStore.getState().tabs[view.id]!.regions)).toEqual(['other-region'])
  expect(useAppStore.getState().tabs[view.id]!.regions['other-region']).toMatchObject({ sessionId: healthy.id, phase: 'attached' })
  expect(api.sessions.stop).not.toHaveBeenCalled(); retained()
})

it('running and unknown Agent facts still require the original explicit stop confirmation', async () => {
  for (const processState of ['running', 'unknown'] as const) {
    useAppStore.setState({ sessions: [{ ...stopped, processState }, healthy] })
    await mount(); await closeX()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Stop Agent Session?')
    expect(useAppStore.getState().tabs[view.id]).toBe(view)
    expect(api.sessions.stop).not.toHaveBeenCalled()
    await click('Cancel')
  }
})

it('a pending Stop has a five-second UI deadline; Keep Session & Close stays reachable and late completion cannot close a replacement', async () => {
  vi.useFakeTimers()
  const running = { ...stopped, processState: 'running' as const }
  useAppStore.setState({ sessions: [running, healthy] })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.sessions.stop).mockReturnValue(pending)
  try {
    await mount(); await closeX(); await click('Stop & Close')
    expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(running.control)
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999) })
    expect(Object.keys(useAppStore.getState().closingWorkbenchViews)).toEqual([view.id])
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(useAppStore.getState().tabs[view.id]).toBe(view)
    expect(useAppStore.getState().closingWorkbenchViews).toEqual({})
    expect(useAppStore.getState().error).toContain('close result is unknown')
    await click('Keep Session & Close')
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([sibling.id])
    expect(api.sessions.stop).toHaveBeenCalledTimes(1)
    const replacement = { ...running, control: { ...running.control, run: { runId: 'new-run' } } }
    await act(async () => { useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [view.id]: view }, sessions: [replacement, healthy] }); release(); await pending })
    expect(useAppStore.getState().tabs[view.id]).toBe(view)
    expect(useAppStore.getState().sessions).toEqual([replacement, healthy])
    expect(useAppStore.getState().agentComposerDrafts).toEqual(draft)
    expect(useAppStore.getState().agentSteerQueues).toEqual({ [stopped.id]: [unknownInput] })
  } finally { release(); await pending; await act(async () => { await vi.runOnlyPendingTimersAsync() }) }
})

it('an exited no-Stop owner in a mixed async View cannot delete the same Session after it changes Run', async () => {
  const browser = { kind: 'browser' as const, regionId: 'browser-region', workspaceId: 'workspace', browserId: 'browser', id: 'browser', navigationId: 'navigation',
    url: 'about:blank', title: 'Browser', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, error: null }
  const mixed = addWorkbenchRegion(view, 'stopped-region', 'right', browser)
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [view.id]: mixed } })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(api.browser, 'close').mockReturnValue(pending)
  const closing = useAppStore.getState().closeTab('workspace', 'group', view.id)
  try {
    const replacement: SessionSnapshot = { ...stopped, processState: 'running', control: { ...stopped.control, run: { runId: 'replacement-run' } } }
    useAppStore.setState({ sessions: [replacement, healthy] }); release()
    expect(await closing).toBe(false)
    expect(Object.keys(useAppStore.getState().tabs[view.id]!.regions)).toEqual(['stopped-region'])
    expect(useAppStore.getState().tabs[view.id]!.regions['stopped-region']).toMatchObject({ sessionId: stopped.id, phase: 'attached' })
    expect(useAppStore.getState().sessions).toEqual([replacement, healthy])
    expect(useAppStore.getState().closingWorkbenchViews).toEqual({})
    expect(api.sessions.stop).not.toHaveBeenCalled()
    expect(api.browser.close).toHaveBeenCalledExactlyOnceWith('browser')
  } finally { release(); await closing }
})

it('dirty editor changes still require the existing discard confirmation even alongside an exited Agent', async () => {
  const file = { kind: 'file' as const, regionId: 'file-region', workspaceId: 'workspace', path: 'changed.txt' }
  const mixed = addWorkbenchRegion(view, 'stopped-region', 'right', file)
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [view.id]: mixed }, dirtyDocuments: { [documentKey('workspace', 'changed.txt')]: true } })
  await mount(); await closeX()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard unsaved changes?')
  expect(useAppStore.getState().tabs[view.id]).toBe(mixed)
  expect(api.sessions.stop).not.toHaveBeenCalled()
  await click('Cancel'); expect(useAppStore.getState().tabs[view.id]).toBe(mixed)
})
