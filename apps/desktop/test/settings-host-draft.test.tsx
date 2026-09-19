// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController, type RuntimePreparation } from '../src/main/runtime-controller'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery'
import { CONFIG_CHANGED_CHANNEL, type AppConfig } from '../src/shared/contracts'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const ipc = vi.hoisted(() => ({ directory: '', handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>() }))
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => ipc.directory },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { constructor(_options: { execute: (request: AgentMuxControlRequest) => Promise<AgentMuxControlResult> }) {} async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { registerIpc } from '../src/main/ipc'

const dom = composerDOM()
const remote = { id: 'ssh-draft', kind: 'ssh' as const, label: 'Saved remote', hostname: 'private.invalid' }
let disk: ConfigStore, runtime: RuntimeController, dispose: () => Promise<void>, config: AppConfig
let progressLoops: ContinuousProgressLoopManager
let publications: AppConfig[], sender: EventEmitter & { id: number; isDestroyed: () => boolean; send: (channel: string, value: unknown) => void; mainFrame: { framesInSubtree: [] } }
async function invoke<T>(channel: string, ...values: unknown[]): Promise<T> {
  const handler = ipc.handlers.get(channel)
  expect(handler).toBeTypeOf('function')
  return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values) as T
}
beforeEach(async () => {
  ipc.directory = await mkdtemp(join(tmpdir(), 'amux-host-draft-owner-'))
  disk = new ConfigStore(join(ipc.directory, 'config.json'))
  config = await disk.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [DEFAULT_CONFIG.hosts[0]!, remote], workspaces: [] })
  // The fixture is initialized explicitly; no unrelated default Topics bootstrap is exercised.
  vi.spyOn(disk, 'get').mockResolvedValue(config)
  runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  progressLoops = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(ipc.directory, 'loops.json')),
    (loop, operationId, isCurrent, signal) => deliverContinuousProgress(runtime, loop, operationId, isCurrent, signal),
    undefined, (loop, tickId, now, signal) => runtime.observeContinuousProgress(loop, tickId, now, signal))
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
  vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  publications = []
  sender = Object.assign(new EventEmitter(), { id: 861, isDestroyed: () => false, mainFrame: { framesInSubtree: [] as [] },
    send: (channel: string, value: unknown) => {
      if (channel === CONFIG_CHANGED_CHANNEL) { config = value as AppConfig; publications.push(config); useAppStore.setState({ config }) }
    } })
  ipc.handlers.clear()
  dispose = await registerIpc({ window: { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    configStore: disk, runtime, progressLoops, scratchTopics: {} as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  useAppStore.setState({ config, hostChecks: {}, checkHost: vi.fn(async () => {}), providerCatalog: await api.providers.list() })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await invoke<AppConfig>('config:save', next, expected))
})
afterEach(async () => { await dispose?.(); await progressLoops?.stop(); await runtime?.dispose(); await rm(ipc.directory, { recursive: true, force: true }) })
const mount = () => dom.render(<SettingsPanel onClose={() => {}} initialSection="hosts" />)
function input(field = 'Label', index = 0): HTMLInputElement {
  const labels = [...dom.container.querySelectorAll<HTMLLabelElement>('.host-edit-grid label')]
  expect(labels.length).toBeGreaterThan(0)
  const found = labels.filter(label => label.querySelector('span')?.textContent === field)
  expect(found.length).toBeGreaterThan(index)
  return found[index]!.querySelector('input')!
}
async function fill(value: string, field = 'Label', index = 0) {
  await act(async () => {
    const node = input(field, index)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function settled() {
  for (let tries = 0; tries < 100; tries++) {
    await act(async () => { await new Promise(done => setTimeout(done, 5)) })
    if (!dom.container.querySelector('.settings-pane-actions [role="status"]')?.textContent?.includes('Saving')) return
  }
  throw new Error('Host save did not settle')
}
async function save() { await dom.click('.settings-pane-actions button'); await settled() }
async function external(change: (current: AppConfig) => AppConfig) {
  await act(async () => { const current = await invoke<AppConfig>('config:get'); await invoke('config:save', change(current), current) })
}
const bytes = () => readFile(disk.filePath, 'utf8')

it('retains an authored Host draft through disjoint external publication, then durably saves through the registered Main owner', async () => {
  await mount(); await fill('Authored remote')
  await external(current => ({ ...current, hosts: current.hosts.map(host => host.id === 'local' ? { ...host, label: 'External local' } : host) }))
  expect(input().value).toBe('Authored remote')
  await save()
  const [, expected] = vi.mocked(api.config.save).mock.calls[0]!
  expect(expected!.hosts).toEqual([{ ...DEFAULT_CONFIG.hosts[0], label: 'External local' }, remote])
  expect(config.hosts).toEqual([{ ...DEFAULT_CONFIG.hosts[0], label: 'External local' }, { ...remote, label: 'Authored remote' }])
  expect(JSON.parse(await bytes()).hosts).toEqual(config.hosts)
  expect(publications).toHaveLength(2)
  expect(vi.mocked(runtime.prepare).mock.calls.at(-1)![0].hosts).toEqual(config.hosts)
})
it('refreshes clean fields of the same Host without widening dirty intent or its authored expectation', async () => {
  await mount(); await fill('Local draft')
  await external(current => ({ ...current, hosts: current.hosts.map(host => host.id === remote.id ? { ...host, hostname: 'external.invalid' } : host) }))
  expect(input().value).toBe('Local draft'); expect(input('Hostname').value).toBe('external.invalid')
  await save()
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.hosts[1]).toEqual({ ...remote, hostname: 'external.invalid' })
  expect(config.hosts[1]).toEqual({ ...remote, hostname: 'external.invalid', label: 'Local draft' })
})
it('keeps same-field conflicts named, with original expected values and unchanged durable bytes on every retry', async () => {
  await mount(); await fill('Local draft')
  await external(current => ({ ...current, hosts: current.hosts.map(host => host.id === remote.id ? { ...host, label: 'External remote' } : host) }))
  const before = await bytes(); await save(); await save()
  expect(input().value).toBe('Local draft'); expect(await bytes()).toBe(before)
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('hosts.ssh-draft.label')
  expect(vi.mocked(api.config.save).mock.calls.map(([, expected]) => expected!.hosts[1]!.label)).toEqual(['Saved remote', 'Saved remote'])
})
it('preserves an edit back to the old Host baseline after pending publication and saves against the committed expectation', async () => {
  await mount(); await fill('Submitted remote')
  const reply = deferred<void>(), published = deferred<void>(), realSave = vi.mocked(api.config.save).getMockImplementation()!
  vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { const saved = await realSave(next, expected); published.resolve(); await reply.promise; return saved })
  await dom.click('.settings-pane-actions button'); await act(async () => published.promise)
  expect(config.hosts[1]!.label).toBe('Submitted remote'); expect(publications).toHaveLength(1)
  await fill('Saved remote'); await act(async () => reply.resolve()); await settled()
  expect(input().value).toBe('Saved remote'); expect(dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(false)
  await save()
  expect(config.hosts[1]!.label).toBe('Saved remote'); expect(vi.mocked(api.config.save).mock.calls[1]![1]!.hosts[1]!.label).toBe('Submitted remote')
})
it('keeps a later Host edit through the pending response without auto-publishing it', async () => {
  await mount(); await fill('Submitted remote')
  const reply = deferred<void>(), published = deferred<void>(), realSave = vi.mocked(api.config.save).getMockImplementation()!
  vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { const saved = await realSave(next, expected); published.resolve(); await reply.promise; return saved })
  await dom.click('.settings-pane-actions button'); await act(async () => published.promise); await fill('Later draft')
  await act(async () => reply.resolve()); await settled()
  expect(input().value).toBe('Later draft'); expect(config.hosts[1]!.label).toBe('Submitted remote')
  await save(); expect(config.hosts[1]!.label).toBe('Later draft')
})
it('retains the raw Host draft and original configuration after controlled preparation refusal', async () => {
  await mount(); await fill('Local draft'); const before = await bytes()
  vi.mocked(runtime.prepare).mockRejectedValueOnce(Object.assign(new Error('Private preparation refusal'), { code: 'REMOTE_UNSUPPORTED' }))
  await save()
  expect(input().value).toBe('Local draft'); expect(await bytes()).toBe(before); expect(publications).toEqual([])
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toBe('Private preparation refusal')
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.hosts[1]).toEqual(remote)
})
it('retains invalid edits without invoking Main or Runtime preparation', async () => {
  await mount(); await fill('', 'Hostname'); const before = await bytes(); const calls = vi.mocked(runtime.prepare).mock.calls.length
  await save()
  expect(input('Hostname').value).toBe(''); expect(await bytes()).toBe(before); expect(api.config.save).not.toHaveBeenCalled()
  expect(runtime.prepare).toHaveBeenCalledTimes(calls)
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('name and hostname')
})
it('does not silently recreate an externally deleted dirty Host', async () => {
  await mount(); await fill('Local draft')
  await external(current => ({ ...current, hosts: current.hosts.filter(host => host.id !== remote.id) }))
  const before = await bytes(); expect(input().value).toBe('Local draft'); await save()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('hosts.ssh-draft')
  expect(await bytes()).toBe(before); expect(config.hosts.map(host => host.id)).toEqual(['local'])
})
it('keeps config-array Host order even for integer-like stable IDs', async () => {
  await external(current => ({ ...current, hosts: [current.hosts[0]!, { ...remote, id: '10', label: 'Ten' }, { ...remote, id: '2', label: 'Two' }] }))
  await mount()
  expect([...dom.container.querySelectorAll('.host-settings-card header strong')].map(node => node.textContent)).toEqual(['This Mac', 'Ten', 'Two'])
  await fill('Edited ten'); await save()
  expect(config.hosts.map(host => host.id)).toEqual(['local', '10', '2'])
})
