// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { homedir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxBrowserTarget, AgentMuxBrowserTargetsResult } from '@agentmux/core'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'

const wire = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  invoke: vi.fn(), listeners: new Map<string, Set<(...args: unknown[]) => void>>() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_key: string, value: AgentMuxPreloadApi) { wire.api = value } },
  ipcRenderer: { invoke: wire.invoke, on(channel: string, listener: (...args: unknown[]) => void) {
    const listeners = wire.listeners.get(channel) ?? new Set(); listeners.add(listener); wire.listeners.set(channel, listeners)
  }, off(channel: string, listener: (...args: unknown[]) => void) { wire.listeners.get(channel)?.delete(listener) },
  removeListener(channel: string, listener: (...args: unknown[]) => void) { wire.listeners.get(channel)?.delete(listener) }, send: vi.fn() }, webFrame: {} }))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { composerConfig } from './helpers/composer-dom-fixture'
import { MobileRegionContent } from '../../mobile/src/navigation/MobileRegionContent'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets'

// Controlled wire material exercises real Settings/Store/API/preload consumers; no machine measurement or native page.
const target = (id: string, workspaceId = 'workspace'): AgentMuxBrowserTarget => ({ id, workspaceId,
  source: 'external', status: 'ready', url: `https://${id}.example/`, title: `Original ${id}`,
  navigationId: `navigation-${id}`, capabilities: ['snapshot'] })
const result = (ids: string[], coverage: AgentMuxBrowserTargetsResult['coverage'] = 'complete'): AgentMuxBrowserTargetsResult => ({ targets: ids.map(id => target(id)), coverage })
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve, reject } }
let root: Root, container: HTMLDivElement, initial: ReturnType<typeof useAppStore.getState>
let read: ReturnType<typeof vi.fn>, current: AgentMuxBrowserTargetsResult
const listenerSet = () => wire.listeners.get('browser:targetsChanged') ?? new Set()
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
const section = () => container.querySelector<HTMLElement>('.external-browser-connections')!
const text = () => section().textContent ?? ''
const render = async (visible: boolean) => { await act(async () => root.render(<SettingsPanel visible={visible} initialSection="browser" onClose={() => {}} />)); await settle() }
const change = async () => { await act(async () => { for (const listener of [...listenerSet()]) listener() }); await settle() }
const click = async (name: string) => { const button = [...section().querySelectorAll('button')].find(button => button.textContent?.trim() === name)
  expect(button).toBeDefined(); await act(async () => button!.click()); await settle() }
beforeEach(async () => {
  expect(homedir()).toBe(process.env.AGENTMUX_DIRECTORY_PRIVATE_HOME)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  initial = useAppStore.getState(); useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace' })
  current = result(['a', 'b']); read = vi.fn(async () => current); wire.listeners.clear()
  wire.invoke.mockImplementation(async (channel: string, workspaceId?: string) => {
    if (channel === 'browser:listTargets') return await read(workspaceId)
    if (channel === 'browser:listRetainedUploads') return { selections: [] }
    if (channel === 'browser:createExternalPairing') return { link: 'ws://private-pairing.invalid/#original', expiresAt: Date.now() + 600000 }
    throw new Error(`Unexpected fixture IPC ${channel}`)
  })
  vi.spyOn(api.browser, 'listTargets').mockImplementation(id => wire.api!.browser.listTargets(id))
  vi.spyOn(api.browser, 'onTargetsChanged').mockImplementation(listener => wire.api!.browser.onTargetsChanged(listener))
  vi.spyOn(api.browser, 'listRetainedUploads').mockImplementation(() => wire.api!.browser.listRetainedUploads())
  vi.spyOn(api.browser, 'createExternalPairing').mockImplementation(id => wire.api!.browser.createExternalPairing(id))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); wire.invoke.mockReset(); expect(listenerSet().size).toBe(0) })

it('keeps prior external rows on partial/failure and removes only after a complete current query', async () => {
  await render(true); expect(read).toHaveBeenCalledExactlyOnceWith('workspace')
  expect(text()).toContain('Original b'); expect(text()).toContain('2 ready in latest query')
  current = result(['a'], 'partial'); await change()
  expect(text()).toContain('Original b'); expect(text()).toContain('Previously observed')
  expect(text()).toContain('1 ready in latest query'); expect(text()).toContain('This query is partial')
  read.mockRejectedValueOnce(new Error('Original membership unavailable')); await change()
  expect(text()).toContain('Original b'); expect(text()).toContain('Original membership unavailable')
  current = result(['a']); await change(); expect(text()).not.toContain('Original b')
})

it('accepts only the latest issued same-scope success or error without discarding a newer partial row', async () => {
  current = result(['a']); await render(true)
  const older = deferred<AgentMuxBrowserTargetsResult>(), newer = deferred<AgentMuxBrowserTargetsResult>()
  read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  await change(); await change(); await act(async () => newer.resolve(result(['a', 'b'], 'partial'))); await settle()
  expect(text()).toContain('Original b'); expect(text()).toContain('This query is partial')
  await act(async () => older.resolve(result(['a']))); await settle()
  expect(text()).toContain('Original b'); expect(text()).toContain('This query is partial')
  const olderError = deferred<AgentMuxBrowserTargetsResult>(), newest = deferred<AgentMuxBrowserTargetsResult>()
  read.mockReturnValueOnce(olderError.promise).mockReturnValueOnce(newest.promise)
  await change(); await change(); await act(async () => newest.resolve(result(['a', 'b'], 'partial'))); await settle()
  await act(async () => olderError.reject(new Error('Superseded read error'))); await settle()
  expect(text()).not.toContain('Superseded read error'); expect(text()).toContain('Original b')
})

it('scopes the real retained Settings observer to active visibility and preserves catalog pairing and automation draft', async () => {
  await render(false); expect(read).not.toHaveBeenCalled()
  // Selected-file snapshots have their own existing observer. This test isolates the exact additional catalog listener.
  const unrelatedUploadListeners = [...listenerSet()]; expect(unrelatedUploadListeners).toHaveLength(1)
  await change(); expect(read).not.toHaveBeenCalled()
  await render(true); expect(read).toHaveBeenCalledTimes(1)
  const catalogListeners = [...listenerSet()].filter(listener => !unrelatedUploadListeners.includes(listener)); expect(catalogListeners).toHaveLength(1)
  await click('Connect extension');
  const automation = container.querySelector<HTMLInputElement>('[data-settings-field="agent-automation"] input')!
  await act(async () => automation.click()); expect(automation.checked).toBe(true)
  const pairing = () => container.querySelector<HTMLInputElement>('[aria-label="Private extension connection link"]')?.value
  expect(pairing()).toBe('ws://private-pairing.invalid/#original')
  const pending = deferred<AgentMuxBrowserTargetsResult>(); read.mockReturnValueOnce(pending.promise); await change()
  const count = read.mock.calls.length
  await render(false); expect(catalogListeners.every(listener => !listenerSet().has(listener))).toBe(true)
  expect(listenerSet().size).toBe(unrelatedUploadListeners.length); await change(); expect(read).toHaveBeenCalledTimes(count)
  await act(async () => pending.resolve(result([]))); await settle()
  expect(text()).toContain('Original b'); expect(pairing()).toBe('ws://private-pairing.invalid/#original'); expect(automation.checked).toBe(true)
  current = result(['c']); await render(true); expect(read).toHaveBeenCalledTimes(count + 1)
  expect(text()).toContain('Original c'); expect(text()).not.toContain('Original b')
  expect(pairing()).toBe('ws://private-pairing.invalid/#original'); expect(automation.checked).toBe(true)
})

it('keeps the exact Mobile Browser reader when a strict partial result omits that original id', async () => {
  let material = result(['b', 'a'])
  const forwardRpc = vi.fn(async (method: string) => { expect(method).toBe('browser.targets'); return parseBrowserTargetsResult(material) })
  const client = { forwardRpc } as never
  await act(async () => root.render(<MobileRegionContent client={client} kind="browser" browserId="a" tabId="original-tab" regionId="original-region" zoneId={null} />)); await settle()
  expect(container.querySelector('a')?.href).toBe('https://a.example/')
  material = result(['b'], 'partial')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click()); await settle()
  expect(container.querySelector('a')?.href).toBe('https://a.example/')
  expect(container.textContent).toContain('原 browserId 的当前网址尚未唯一确认')
  expect(container.textContent).not.toContain('https://b.example/')
  expect(forwardRpc).toHaveBeenCalledTimes(2)
})
