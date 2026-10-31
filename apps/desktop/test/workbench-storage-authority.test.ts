const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { prepareWindowWorkbenchForQuit, reportWorkbenchQuitFailure } from '../src/main/window-state-persistence.js'
import { inspectDesktopClient } from '../src/main/client-observation.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { desktopWorkbenchObservationSchema, parseDesktopClientObservation } from '../src/shared/client-observation.js'
import { readDesktopPresentation } from '../src/renderer/src/lib/desktop-presentation.js'
import { requireOutgoingWorkbenchStorage } from '../scripts/package-runtime-upgrade.mjs'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices.js'
import { toggleNotificationCenter, toggleNotificationDetails } from './helpers/notification-center'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

async function initializeWorkbench() {
  const config = await api.config.get()
  // Spatial identities require absolute identity paths. The web preview's demo path is a
  // display placeholder and cannot qualify this real Store checkpoint fixture.
  vi.spyOn(api.config, 'get').mockResolvedValue({ ...config, workspaces: config.workspaces.map(workspace => ({
    ...workspace, path: workspace.path.startsWith('/') ? workspace.path : (_hygiene_fixturePath("private-storage-test/") + (workspace.id) + "")
  })) })
  return await useAppStore.getState().initialize()
}

it('keeps the original nonempty workbench observable when local storage qualification rejects', async () => {
  const tab = createWorkbenchTab('tab', { kind: 'agent', regionId: 'region', workspaceId: 'workspace', sessionId: 'session', phase: 'attached' })
  const selection = { surface: 'space', mainSurface: 'workbench', focusView: null, space: null, goalId: null } as const
  const workbench = desktopWorkbenchObservationSchema.parse({ loading: false, startupProgress: { step: 'layout' }, startupAgentAvailability: null, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    desktop: { selection, ...readDesktopPresentation(selection, { [tab.id]: tab }), focus: { executionSessionId: 'session', pmoSessionId: null, agent: null } },
    focus: { executionSessionId: 'session', pmoSessionId: null }, layouts: {}, tabs: [{ id: 'tab', workspaceId: 'workspace', titleRegionId: 'region', layout: tab.layout,
      regions: [{ kind: 'agent', regionId: 'region', workspaceId: 'workspace', sessionId: 'session', phase: 'attached', processState: 'running', control: null }] }] })
  const renderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-native' } } as const
  const response = inspectDesktopClient({ schemaVersion: 5, requestId: 'private', operation: 'inspect.client' }, {
    pid: 123, package: null, renderer: () => renderer, generation: () => 1, runtimes: () => [], storage: async () => { throw new Error('unconfirmed observation') },
    execute: async () => ({ operation: 'inspect.client', observation: workbench }) })
  const outcome = await response.then(result => ({ result, error: undefined }), error => ({ result: undefined, error }))
  expect(outcome.error).toBeUndefined()
  const result = outcome.result!
  if (result.operation !== 'inspect.client') throw new Error('wrong operation')
  const observed = parseDesktopClientObservation(result.observation)
  expect(observed.workbench.tabs).toHaveLength(1); expect(observed.workbench).toEqual(workbench); expect(observed.main.storage).toBeUndefined()
})
it('refuses an outgoing UI update for unknown or missing storage before any exit authority, without path fallback', async () => {
  expect(() => requireOutgoingWorkbenchStorage({ main: {} })).toThrow('existing interface and Runs were kept')
  for (const localStorage of ['missing', 'unconfirmed']) expect(() => requireOutgoingWorkbenchStorage({ main: { storage: { localStorage } } })).toThrow()
  const root = _hygiene_fixturePath('private/legacy-storage')
  const storage = { userData: root, sessionData: root, directory: root, localStorage: 'present', detail: null }
  expect(() => requireOutgoingWorkbenchStorage({ main: { storage } })).toThrow('existing interface and Runs were kept')
})
it('awaits the actual renderer preparation, bounds a missing response, and allows a later retry', async () => {
  vi.useFakeTimers(); let resolve!: () => void
  const executeJavaScript = vi.fn(() => new Promise<void>(done => { resolve = done }))
  const window = { isDestroyed: () => false, webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, isCrashed: () => false, executeJavaScript }) } as unknown as BrowserWindow
  const first = prepareWindowWorkbenchForQuit(window)
  expect(executeJavaScript).toHaveBeenCalledWith('window.agentmuxPrepareRendererUpdate("quit")')
  const rejected = expect(first).rejects.toThrow('five seconds')
  await vi.advanceTimersByTimeAsync(5_000); await rejected
  resolve(); await Promise.resolve()
  executeJavaScript.mockResolvedValueOnce(undefined); await expect(prepareWindowWorkbenchForQuit(window)).resolves.toBeUndefined()
  expect(executeJavaScript).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0)
})
it('reports a quit preparation failure through the existing service window without destroying the window', () => {
  const executeJavaScript = vi.fn(async (_script: string) => undefined); const destroy = vi.fn()
  const window = { destroy, isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScript } } as unknown as BrowserWindow
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  reportWorkbenchQuitFailure(window, new Error('storage missing'))
  expect(executeJavaScript).toHaveBeenCalledTimes(1); expect(executeJavaScript.mock.calls[0]?.[0]).toContain('agentmux-workbench-save-error')
  expect(executeJavaScript.mock.calls[0]?.[0]).toContain('try Quit again'); expect(destroy).not.toHaveBeenCalled()
})

it('flushes the last actual Store draft before awaiting its host and retains it when the host refuses', async () => {
  const dispose = await initializeWorkbench()
  try {
    expect(useAppStore.getState().loading).toBe(false)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const host = vi.spyOn(api.ui, 'requestStorageFlush').mockReturnValue(pending)
    useAppStore.setState({ agentComposerDrafts: { 'private-session': 'Last exact unsent draft' } })
    let completed = false
    const prepared = prepareRendererUpdate('quit').then(() => { completed = true })
    await vi.waitFor(() => expect(host).toHaveBeenCalled())
    const encoded = localStorage.getItem('agentmux-workbench-v1')
    expect(encoded).not.toBeNull()
    const stored = JSON.parse(encoded!).state
    expect(stored.agentComposerDrafts).toEqual({ 'private-session': 'Last exact unsent draft' })
    expect(completed).toBe(false)
    release(); await prepared; expect(completed).toBe(true)
    host.mockRejectedValue(new Error('storage missing'))
    await expect(prepareRendererUpdate('quit')).rejects.toThrow('storage missing')
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ 'private-session': 'Last exact unsent draft' })
  } finally { dispose() }
})

it('keeps the real save service notice through workspace changes, another error and folding, until an actual retry succeeds', async () => {
  const dispose = await initializeWorkbench()
  const host = vi.spyOn(api.ui, 'requestStorageFlush').mockRejectedValue(new Error('database missing'))
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  try {
    useAppStore.getState().reportWorkbenchSaveFailure(new Error('database missing'))
    await act(async () => root.render(createElement(GlobalSystemNotices)))
    await toggleNotificationCenter(element, 'open')
    const notice = element.querySelector<HTMLElement>('[data-notice-id="workbench-save"]')
    expect(notice).not.toBeNull()
    await toggleNotificationDetails(notice!)
    expect(notice!.textContent).toContain('database missing')
    expect(notice!.getAttribute('role')).toBe('status')
    expect(element.textContent).toContain('Saving the workbench is unconfirmed')
    const first = useAppStore.getState().workbenchSaveWarning
    await toggleNotificationCenter(element, 'closed')
    await act(async () => {
      useAppStore.setState({ activeWorkspaceId: 'different-workspace' })
      useAppStore.getState().reportError(new Error('unrelated workflow error'))
      useAppStore.getState().dismissError()
    })
    expect(useAppStore.getState().workbenchSaveWarning).toBe(first)
    expect(element.querySelector('.global-system-notices__details')?.getAttribute('data-state')).toBe('closed')
    await toggleNotificationCenter(element, 'open')
    expect(element.textContent).toContain('Saving the workbench is unconfirmed')
    const retry = [...element.querySelectorAll('button')].find(button => button.textContent === 'Retry saving')
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(useAppStore.getState().workbenchSaveWarning).toBe('database missing')
    host.mockResolvedValue(undefined)
    await act(async () => retry!.click())
    expect(host).toHaveBeenCalled(); expect(useAppStore.getState().workbenchSaveWarning).toBeNull()
    expect(element.textContent).not.toContain('Saving the workbench is unconfirmed')
    const encoded = localStorage.getItem('agentmux-workbench-v1')
    expect(encoded).not.toBeNull()
    const stored = JSON.parse(encoded!).state
    expect(stored).not.toHaveProperty('workbenchSaveWarning')
  } finally { await act(async () => root.unmount()); element.remove(); dispose() }
})

it('does not let a late accepted pre-timeout request erase an unconfirmed quit warning', async () => {
  const dispose = await initializeWorkbench()
  try {
    let release!: () => void
    const host = vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(() => new Promise<void>(done => { release = done }))
    const prepared = prepareRendererUpdate('quit')
    await vi.waitFor(() => expect(host).toHaveBeenCalled())
    useAppStore.getState().reportWorkbenchSaveFailure(new Error('quit timed out'))
    release(); await prepared
    expect(useAppStore.getState().workbenchSaveWarning).toBe('quit timed out')
  } finally { dispose() }
})
