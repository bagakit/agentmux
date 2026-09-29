// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ConfigOwner } from '../src/main/config-owner'
import { saveRuntimeConfig } from '../src/main/runtime-config-transaction'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'
import { CONFIG_CHANGED_CHANNEL, type AppConfig } from '../src/shared/contracts'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

// Reuse the existing Host Main fixture's external boundaries. ConfigOwner, validation,
// RuntimeController.prepare/assertConfigurable and the transaction stay actual source.
const ipc = vi.hoisted(() => ({ directory: '', handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>() }))
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => ipc.directory || tmpdir() },
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

const mode = process.env.AGENTMUX_HOST_LIVENESS_MUTANT ?? 'baseline'
const target = resolve(process.env.AGENTMUX_HOST_LIVENESS_EVIDENCE ?? resolve(process.cwd(), '.bagakit/design/settings-followups-20261004/host-liveness-evidence/direct'))
type Event = { sequence: number; window: string; kind: string; id: string; facts?: Record<string, unknown> }
function observations() {
  const events: Event[] = [], visits = new Map<string, number>()
  let window = 'mount', functionSequence = 0
  const functionIds = new WeakMap<Function, number>()
  vi.stubGlobal('__settingsProbeRecord', (kind: string, id: string, facts?: Record<string, unknown>) => {
    const value = { ...facts }
    if (typeof value.onClose === 'function') {
      if (!functionIds.has(value.onClose)) functionIds.set(value.onClose, ++functionSequence)
      value.onCloseIdentity = functionIds.get(value.onClose); delete value.onClose
    }
    events.push({ sequence: events.length + 1, window, kind, id, facts: value })
  })
  vi.stubGlobal('__settingsProbeVisit', () => visits.set(window, (visits.get(window) ?? 0) + 1))
  return {
    events,
    setWindow: (next: string) => { window = next },
    notify: () => events.push({ sequence: events.length + 1, window, kind: 'notify', id: 'global-store' }),
    summary: (name: string) => {
      const collected = events.filter(event => event.window === name)
      const commits = collected.filter(event => event.kind === 'commit' && event.id === 'HostSettingsPane')
      return { window: name, notifications: collected.filter(event => event.kind === 'notify').length,
        hostRenders: collected.filter(event => event.kind === 'render' && event.id === 'HostSettingsPane').length,
        hostFieldRenders: collected.filter(event => event.kind === 'render' && event.id === 'HostConnectionFields').length,
        hostCommits: commits.length, hostSessionPredicateVisits: visits.get(name) ?? 0,
        hostActualDurationsMs: commits.map(event => event.facts!.actualDuration),
        settingsRenders: collected.filter(event => event.kind === 'render' && event.id === 'SettingsPanel').length,
        settingsSubtreeCommits: collected.filter(event => event.kind === 'commit' && event.id === 'SettingsPanel').length,
        appRenders: collected.filter(event => event.kind === 'render' && event.id === 'DesktopApp').length,
        onCloseIdentities: collected.filter(event => event.kind === 'render' && event.id === 'SettingsPanel')
          .map(event => event.facts!.onCloseIdentity) }
    },
    proveCollected: () => {
      expect(events.length).toBeGreaterThan(0)
      expect(events.some(event => event.kind === 'commit' && event.id === 'HostSettingsPane')).toBe(true)
      expect(events.some(event => event.kind === 'render' && event.id === 'HostSettingsPane')).toBe(true)
    }
  }
}
function writeReport(name: string, reports: unknown[]) {
  writeFileSync(resolve(target, `${name}-${mode}.json`), JSON.stringify({
    schema: 'agentmux.host-liveness-source-profiler.v1', mode, producer: 'actual Main product source / development React / happy-dom',
    noStrictMode: true, liveUserPerformanceClaimed: false, reports
  }, null, 2) + '\n')
}

// The UI fixture keeps the same real ConfigOwner/validation/durable transaction as
// product-dom, without its app-only Electron mock shadowing the registered IPC guard.
const dom = composerDOM(), reports: unknown[] = []
let owner: ConfigOwner, directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentmux-host-liveness-ui-'))
  const disk = new ConfigStore(join(directory, 'config.json'))
  let current = await disk.save(structuredClone(DEFAULT_CONFIG))
  const runtime = { prepare: vi.fn(async () => ({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })),
    commit: vi.fn(), discard: vi.fn(async () => {}) } as unknown as RuntimeController
  owner = new ConfigOwner({ read: () => current,
    save: next => saveRuntimeConfig({ runtime, configWriter: disk, next: disk.validate(next) }),
    publish: saved => { current = saved; useAppStore.setState({ config: saved }) } })
  useAppStore.setState({ config: owner.current, providerCatalog: await api.providers.list() })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await owner.edit(expected!, next))
})
afterEach(async () => {
  writeReport('owning', reports)
  await rm(directory, { recursive: true, force: true })
})
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const close = () => {}
const session = (id: string, hostId: string) => {
  const value = composerSession(id)
  return { ...value, hostId, control: { ...value.control, hostId } }
}
async function configure(hostCount: number, sessionCount: number) {
  await act(async () => owner.edit(owner.current, { ...owner.current, hosts: [
    { id: 'local', kind: 'local', label: 'This Mac' },
    ...Array.from({ length: hostCount - 1 }, (_, i) => ({ id: `configured-${i}`, kind: 'ssh' as const,
      label: `Configured ${i}`, hostname: `saved-${i}.invalid` }))
  ] }))
  useAppStore.setState({ sessions: Array.from({ length: sessionCount }, (_, i) => session(`unrelated-${i}`, 'off-scope-host')), hostChecks: {} })
}
function field(card: Element, name: string) {
  const labels = [...card.querySelectorAll<HTMLLabelElement>('label')]
  expect(labels.length).toBeGreaterThan(0)
  const found = labels.find(label => label.querySelector('span')?.textContent === name)
  expect(found).toBeDefined()
  return found!.querySelector<HTMLInputElement>('input')!
}
it.each([[4, 8], [4, 128], [4, 512], [2, 128], [8, 128], [24, 128]])(
  'inactive liveness H=%i N=%i has zero hidden work and latest related facts on return', async (hostCount, sessionCount) => {
    const observation = observations(); await configure(hostCount, sessionCount)
    const unsubscribe = useAppStore.subscribe(observation.notify)
    try {
      await dom.render(<SettingsPanel initialSection="hosts" onClose={close} />)
      const hostPane = dom.container.querySelector<HTMLElement>('[data-settings-pane="hosts"]')!
      expect(hostPane).not.toBeNull()
      const cards = hostPane.querySelectorAll<HTMLElement>('.host-settings-card')
      expect(cards).toHaveLength(hostCount)
      const input = field(cards[1]!, 'Label')
      await fill(input, 'Authored host draft')
      await dom.click('[data-settings-target="general"]')
      expect(hostPane.hidden).toBe(true)
      observation.proveCollected()
      const config = useAppStore.getState().config
      for (const window of ['reference-noop', 'off-scope-session', 'off-scope-checks']) {
        observation.setWindow(window)
        for (let i = 0; i < 6; i++) await act(async () => {
          if (window === 'off-scope-session') useAppStore.setState({ sessions: useAppStore.getState().sessions.map((value, index) =>
            index === 0 ? { ...value, label: `Fact ${i}`, updatedAt: i + 2 } : value) })
          else if (window === 'off-scope-checks') useAppStore.setState({ hostChecks: {
            ...useAppStore.getState().hostChecks, [`unconfigured-${i}`]: { state: 'checking',
              input: { id: `unconfigured-${i}`, kind: 'ssh', label: 'Unrelated', hostname: 'unrelated.invalid' } }
          } })
          else useAppStore.setState({ sessions: useAppStore.getState().sessions })
        })
      }
      const windows = ['reference-noop', 'off-scope-session', 'off-scope-checks'].map(observation.summary)
      const report = { case: 'inactive-liveness', hostCount, sessionCount, windows, config,
        rawEvents: observation.events, passed: false }
      reports.push(report)
      for (const window of windows) {
        expect(window.notifications).toBe(6)
        expect(window.hostRenders).toBe(0); expect(window.hostCommits).toBe(0)
        expect(window.hostFieldRenders).toBe(0); expect(window.hostSessionPredicateVisits).toBe(0)
      }
      expect(useAppStore.getState().config).toBe(config)
      expect(input.isConnected).toBe(true); expect(field(cards[1]!, 'Label')).toBe(input)
      expect(input.value).toBe('Authored host draft')
      expect(dom.container.querySelector<HTMLElement>('.settings-page')!.dataset.settingsPage).toBe('general')
      expect(hostPane.querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(false)
      observation.setWindow('related-facts-while-hidden')
      const related = { ...config!.hosts[1]!, label: 'Authored host draft' }
      await act(async () => useAppStore.setState({
        sessions: useAppStore.getState().sessions.map((value, index) => index === 0
          ? { ...value, hostId: related.id, control: { ...value.control, hostId: related.id } } : value),
        hostChecks: { ...useAppStore.getState().hostChecks, [related.id]: { state: 'checking', input: related } }
      }))
      expect(observation.summary('related-facts-while-hidden').hostRenders).toBe(0)
      observation.setWindow('reactivation')
      await dom.click('[data-settings-target="hosts"]')
      expect(hostPane.hidden).toBe(false)
      const relatedCard = hostPane.querySelectorAll<HTMLElement>('.host-settings-card')[1]!
      expect(relatedCard.querySelector(':scope > .field-hint')!.textContent).toContain('1 running session')
      expect(relatedCard.querySelector<HTMLButtonElement>('.icon-button--danger')!.disabled).toBe(true)
      expect(relatedCard.querySelector('.check-pill')!.textContent).toContain('Testing')
      observation.setWindow('active-related-positive')
      await act(async () => useAppStore.setState({
        sessions: useAppStore.getState().sessions.map((value, index) => index === 1
          ? { ...value, hostId: related.id, control: { ...value.control, hostId: related.id } } : value),
        hostChecks: { ...useAppStore.getState().hostChecks, [related.id]: { state: 'ready', input: related, detail: 'Current checked input' } }
      }))
      const positive = observation.summary('active-related-positive')
      expect(positive.notifications).toBe(1)
      expect(positive.hostRenders).toBeGreaterThan(0); expect(positive.hostCommits).toBeGreaterThan(0)
      expect(positive.hostSessionPredicateVisits).toBe(hostCount * sessionCount * positive.hostRenders)
      expect(positive.hostSessionPredicateVisits).toBeGreaterThan(0)
      expect(relatedCard.querySelector(':scope > .field-hint')!.textContent).toContain('2 running sessions')
      expect(relatedCard.querySelector('.check-pill')!.textContent).toContain('Ready')
      expect(field(relatedCard, 'Label')).toBe(input); expect(input.value).toBe('Authored host draft')
      expect(api.config.save).not.toHaveBeenCalled()
      Object.assign(report, { positive, latestOnReturn: true, draftNodeRetained: true }); report.passed = true
    } finally { unsubscribe() }
  })

it('hidden config baseline consumes clean publication while dirty node and expected remain', async () => {
  const observation = observations(); await configure(4, 8)
  await dom.render(<SettingsPanel initialSection="hosts" onClose={close} />)
  const pane = dom.container.querySelector<HTMLElement>('[data-settings-pane="hosts"]')!
  const cards = pane.querySelectorAll<HTMLElement>('.host-settings-card')
  const dirty = field(cards[1]!, 'Label'), clean = field(cards[1]!, 'Hostname'), neighbor = field(cards[2]!, 'Label')
  await fill(dirty, 'Authored dirty label'); await dom.click('[data-settings-target="general"]')
  observation.setWindow('legal-config-publication')
  const previous = owner.current
  await act(async () => owner.edit(previous, { ...previous, hosts: previous.hosts.map(host => host.id === 'configured-0'
    ? { ...host, hostname: 'published.invalid' } : host.id === 'configured-1' ? { ...host, label: 'Published neighbor' } : host) }))
  expect(pane.hidden).toBe(true); expect(dirty.isConnected).toBe(true); expect(neighbor.isConnected).toBe(true)
  expect(dirty.value).toBe('Authored dirty label')
  expect(clean.value).toBe('published.invalid'); expect(neighbor.value).toBe('Published neighbor')
  expect(dom.container.querySelector<HTMLElement>('.settings-page')!.dataset.settingsPage).toBe('general')
  await dom.click('[data-settings-target="hosts"]')
  expect(field(pane.querySelectorAll('.host-settings-card')[1]!, 'Label')).toBe(dirty)
  const save = pane.querySelector<HTMLButtonElement>('.settings-pane-actions button')!
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(api.config.save).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.mocked(api.config.save).mock.results[0]!.value })
  const [submitted, expected] = vi.mocked(api.config.save).mock.calls[0]!
  expect(expected!.hosts[1]).toMatchObject({ label: 'Configured 0', hostname: 'published.invalid' })
  expect(expected!.hosts[2]).toMatchObject({ label: 'Published neighbor' })
  expect(submitted.hosts[1]).toMatchObject({ label: 'Authored dirty label', hostname: 'published.invalid' })
  expect(owner.current.hosts[1]).toMatchObject({ label: 'Authored dirty label', hostname: 'published.invalid' })
  reports.push({ case: 'hidden-config-baseline', passed: true, expected, submitted, rawEvents: observation.events })
})

it.each(['change', 'delete'] as const)('registered Main owner rejects referenced Host %s using actual prepare guard', async operation => {
  ipc.directory = await mkdtemp(join(tmpdir(), 'agentmux-host-liveness-main-'))
  const disk = new ConfigStore(join(ipc.directory, 'config.json'))
  const protectedHost = { id: 'ssh-protected', kind: 'ssh' as const, label: 'Protected', hostname: 'private.invalid' }
  const config = await disk.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [DEFAULT_CONFIG.hosts[0]!, protectedHost], workspaces: [] })
  vi.spyOn(disk, 'get').mockResolvedValue(config)
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  const facts = [{ runId: 'healthy-run', state: 'running', pid: 123, workspacePath: '/private-fixture' }]
  const client = { connect: vi.fn(async () => {}), listRuns: vi.fn(async () => facts),
    stopAgent: vi.fn(), stopRun: vi.fn(), dispose: vi.fn() }
  // Protocol facts only; the real guard must execute and reject before preparation/save.
  const internals = runtime as unknown as { hosts: Map<string, unknown>; hostSignatures: Map<string, string> }
  internals.hosts.set(protectedHost.id, { client, executionHost: { kind: 'local', repoPath: '/private-fixture' } })
  internals.hostSignatures = new Map(config.hosts.map(host => [host.id, JSON.stringify(host)]))
  const prepare = vi.spyOn(runtime, 'prepare')
  const guard = vi.spyOn(runtime as unknown as { assertConfigurable(next: ReadonlyMap<string, string>): Promise<void> }, 'assertConfigurable')
  const commit = vi.spyOn(runtime, 'commit')
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  const progress = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(ipc.directory, 'loops.json')),
    async () => { throw new Error('Host guard fixture cannot deliver input') }, undefined,
    async () => { throw new Error('Host guard fixture cannot observe a Run') })
  const publications: AppConfig[] = []
  const sender = Object.assign(new EventEmitter(), { id: 992, isDestroyed: () => false, mainFrame: { framesInSubtree: [] },
    send: (channel: string, value: unknown) => { if (channel === CONFIG_CHANGED_CHANNEL) publications.push(value as AppConfig) } })
  ipc.handlers.clear()
  const dispose = await registerIpc({ window: { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    configStore: disk, runtime, progressLoops: progress, scratchTopics: {} as ScratchTopics,
    workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  try {
    // Registration prepares the unchanged fixture once. Measure only the later edit.
    expect(prepare).toHaveBeenCalledTimes(1); expect(guard).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1); expect(client.connect).not.toHaveBeenCalled()
    prepare.mockClear(); guard.mockClear(); commit.mockClear()
    const handler = ipc.handlers.get('config:save')
    expect(handler).toBeTypeOf('function')
    const before = await readFile(disk.filePath, 'utf8'), expected = structuredClone(config)
    const next = { ...config, hosts: operation === 'delete' ? [config.hosts[0]!] : config.hosts.map(host =>
      host.id === protectedHost.id ? { ...host, label: 'Changed while referenced' } : host) }
    expect(facts).toHaveLength(1)
    await expect(handler!({ sender } as unknown as IpcMainInvokeEvent, next, expected)).rejects.toThrow('Stop sessions on ssh-protected')
    expect(prepare).toHaveBeenCalledTimes(1); expect(guard).toHaveBeenCalledTimes(1)
    expect(client.connect).toHaveBeenCalledTimes(1); expect(client.listRuns).toHaveBeenCalledTimes(1)
    expect(await readFile(disk.filePath, 'utf8')).toBe(before); expect(expected).toEqual(config)
    expect(commit).not.toHaveBeenCalled(); expect(client.stopAgent).not.toHaveBeenCalled()
    expect(client.stopRun).not.toHaveBeenCalled(); expect(client.dispose).not.toHaveBeenCalled()
    expect(publications).toEqual([]); expect(facts).toHaveLength(1)
    reports.push({ case: `main-guard-${operation}`, passed: true, configuredHost: protectedHost,
      facts, prepareCalls: prepare.mock.calls.length, guardCalls: guard.mock.calls.length,
      configBytesPreserved: true, expected, commitCalls: commit.mock.calls.length, publicationCount: publications.length })
  } finally {
    await dispose(); await progress.stop(); internals.hosts.clear(); await runtime.dispose()
    await rm(ipc.directory, { recursive: true, force: true }); ipc.directory = ''
  }
})
