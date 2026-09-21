// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { observeWorkbenchStorageAuthority, requireWorkbenchStorageAuthority } from '../src/main/workbench-storage-authority.js'
import { prepareWindowWorkbenchForQuit, reportWorkbenchQuitFailure } from '../src/main/window-state-persistence.js'
import { inspectDesktopClient } from '../src/main/client-observation.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { desktopWorkbenchObservationSchema, parseDesktopClientObservation } from '../src/shared/client-observation.js'
import { requireOutgoingWorkbenchStorage } from '../scripts/package-macos.mjs'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp('/tmp/amx-storage-owner-test-'); roots.push(root)
  return { root, configured: { userData: root, sessionData: root }, session: { getStoragePath: () => root } }
}

it('qualifies the actual persistent Session category, without assuming a particular LevelDB generation or disk ACK', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'Local Storage'))
  const observed = await observeWorkbenchStorageAuthority(f.session, f.configured)
  expect(observed).toEqual({ ...f.configured, directory: f.root, localStorage: 'present', detail: null })
  expect(() => requireWorkbenchStorageAuthority(observed)).not.toThrow()
})
it('accepts an independent configured sessionData root when it is the actual window owner', async () => {
  const f = await fixture(); const sessionData = join(f.root, 'session-data'); await mkdir(join(sessionData, 'Local Storage'), { recursive: true })
  const observed = await observeWorkbenchStorageAuthority({ getStoragePath: () => sessionData }, { userData: f.root, sessionData })
  expect(observed).toEqual({ userData: f.root, sessionData, directory: sessionData, localStorage: 'present', detail: null })
  expect(() => requireWorkbenchStorageAuthority(observed)).not.toThrow()
})
it('reports a missing category honestly and refuses a save transition while leaving files untouched', async () => {
  const f = await fixture(); const sentinel = join(f.root, 'retained-original'); await writeFile(sentinel, 'original')
  const observed = await observeWorkbenchStorageAuthority(f.session, f.configured)
  expect(observed.localStorage).toBe('missing')
  expect(() => requireWorkbenchStorageAuthority(observed)).toThrow('Saving the workbench is unconfirmed')
  const { readFile } = await import('node:fs/promises'); expect(await readFile(sentinel, 'utf8')).toBe('original')
})
it('does not substitute configured files for an unconfirmed, nonpersistent, or mismatched actual Session', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'Local Storage'))
  for (const session of [{ getStoragePath: () => null }, { getStoragePath: () => { throw new Error('getter unavailable') } }, { getStoragePath: () => join(f.root, 'other') }]) {
    const observed = await observeWorkbenchStorageAuthority(session, f.configured)
    expect(observed.localStorage).toBe('unconfirmed'); expect(() => requireWorkbenchStorageAuthority(observed)).toThrow()
  }
})
it('keeps the original nonempty workbench observable when local storage qualification rejects', async () => {
  const tab = createWorkbenchTab('tab', { kind: 'agent', regionId: 'region', workspaceId: 'workspace', sessionId: 'session', phase: 'attached' })
  const workbench = desktopWorkbenchObservationSchema.parse({ loading: false, startupProgress: { step: 'layout' }, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    focus: { executionSessionId: 'session', pmoSessionId: null }, layouts: {}, tabs: [{ id: 'tab', workspaceId: 'workspace', titleRegionId: 'region', layout: tab.layout,
      regions: [{ kind: 'agent', regionId: 'region', workspaceId: 'workspace', sessionId: 'session', phase: 'attached', processState: 'running', control: null }] }] })
  const renderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-native' } } as const
  const result = await inspectDesktopClient({ schemaVersion: 5, requestId: 'private', operation: 'inspect.client' }, {
    pid: 123, package: null, renderer: () => renderer, generation: () => 1, runtimes: () => [], storage: async () => { throw new Error('unconfirmed observation') },
    execute: async () => ({ operation: 'inspect.client', observation: workbench }) })
  if (result.operation !== 'inspect.client') throw new Error('wrong operation')
  const observed = parseDesktopClientObservation(result.observation)
  expect(observed.workbench.tabs).toHaveLength(1); expect(observed.workbench).toEqual(workbench); expect(observed.main.storage).toBeUndefined()
})
it('refuses an outgoing UI update for unknown or missing storage before any exit authority, without path fallback', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'Local Storage'))
  expect(() => requireOutgoingWorkbenchStorage({ main: {} })).toThrow('existing interface and Runs were kept')
  for (const localStorage of ['missing', 'unconfirmed']) expect(() => requireOutgoingWorkbenchStorage({ main: { storage: { localStorage } } })).toThrow()
  const storage = await observeWorkbenchStorageAuthority(f.session, f.configured)
  expect(() => requireOutgoingWorkbenchStorage({ main: { storage } })).not.toThrow()
})
it('awaits the actual renderer preparation, bounds a missing response, and allows a later retry', async () => {
  vi.useFakeTimers(); let resolve!: () => void
  const executeJavaScript = vi.fn(() => new Promise<void>(done => { resolve = done }))
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScript } } as unknown as BrowserWindow
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
  const dispose = await useAppStore.getState().initialize()
  try {
    expect(useAppStore.getState().loading).toBe(false)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const host = vi.spyOn(api.ui, 'requestStorageFlush').mockReturnValue(pending)
    useAppStore.setState({ agentComposerDrafts: { 'private-session': 'Last exact unsent draft' } })
    let completed = false
    const prepared = prepareRendererUpdate('quit').then(() => { completed = true })
    const stored = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state
    expect(stored.agentComposerDrafts).toEqual({ 'private-session': 'Last exact unsent draft' })
    expect(host).toHaveBeenCalled(); await Promise.resolve(); expect(completed).toBe(false)
    release(); await prepared; expect(completed).toBe(true)
    host.mockRejectedValue(new Error('storage missing'))
    await expect(prepareRendererUpdate('quit')).rejects.toThrow('storage missing')
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ 'private-session': 'Last exact unsent draft' })
  } finally { dispose() }
})
