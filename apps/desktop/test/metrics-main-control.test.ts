// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const fixture = vi.hoisted(() => ({ directory: process.env.AGENTMUX_METRICS_EVIDENCE ?? process.cwd(), handlers: new Map<string, (...args: any[]) => unknown>(),
  ipc: new (class { listeners = new Map<string, Set<Function>>() })(),
  rendererRequest: undefined as undefined | ((request: any) => void), rendererCancel: undefined as undefined | ((request: any) => void) }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
    on: (channel: string, handler: Function) => { const values = fixture.ipc.listeners.get(channel) ?? new Set(); values.add(handler); fixture.ipc.listeners.set(channel, values) },
    removeListener: (channel: string, handler: Function) => fixture.ipc.listeners.get(channel)?.delete(handler) },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/demand', async original => ({ ...await original(), openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class {
  resourceProcessIds() { return [] } resourceOwnerCounts() { return { browserViews: 0, releasedBrowserViews: 0 } } dispose() {}
} }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AgentMuxMemoryAgentSessionStore, AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { requestAgentMuxControl } from '@agentmux/core'
import { parseMetricsObservation } from '@agentmux/core/control'
import { registerIpc } from '../src/main/ipc'
import { RuntimeController } from '../src/main/runtime-controller'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler'
import { createResourceMetricsPort, observeRendererResources } from '../src/main/resource-usage-control'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, readRendererResourceOwnerCounts } from '../src/renderer/src/store'
import { CONTROL_REQUEST_CHANNEL, CONTROL_RESPONSE_CHANNEL, CONTROL_CANCEL_CHANNEL, RESOURCE_USAGE_CHANNEL } from '../src/shared/contracts'

const children: ChildProcess[] = [], cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)) }
  for (const close of cleanup.splice(0).reverse()) await close()
  delete (globalThis as any).__metricsMutantSampler
  vi.useRealTimers(); vi.restoreAllMocks()
})
async function waitFor(check: () => void) {
  const deadline = Date.now() + 6000
  for (;;) {
    try { check(); return } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}
async function record(value: unknown) {
  if (process.env.AGENTMUX_METRICS_EVIDENCE) await appendFile(join(process.env.AGENTMUX_METRICS_EVIDENCE, 'main-observations.jsonl'), JSON.stringify(value) + '\n')
}
function samplerState(sampler: ProcessResourceSampler) {
  const owner = sampler as unknown as { subscribers: Set<unknown>; timer: unknown }
  return { consumers: owner.subscribers.size, timer: owner.timer !== null }
}
function startCli(directory: string, command: 'get' | 'watch') {
  expect(process.env.AGENTMUX_METRICS_CLI).toBeTruthy()
  const child = spawn(process.execPath, [process.env.AGENTMUX_METRICS_CLI!, 'metrics', command], {
    env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let stdout = '', stderr = ''
  let closed = false
  child.stdout!.on('data', chunk => { stdout += chunk.toString() }); child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  child.once('close', () => { closed = true })
  return { child, get closed() { return closed }, get stdout() { return stdout }, get stderr() { return stderr },
    frames: () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)),
    errors: () => stderr.split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
async function registered() {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-main-'))
  fixture.directory = directory; fixture.handlers.clear(); fixture.ipc.listeners.clear()
  const priorDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
  process.env.AGENTMUX_RUNTIME_DIRECTORY = directory
  cleanup.push(async () => { if (priorDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY; else process.env.AGENTMUX_RUNTIME_DIRECTORY = priorDirectory; await rm(directory, { recursive: true, force: true }) })
  const storage = join(directory, 'selected-runtime'); await mkdir(storage); await writeFile(join(storage, 'retained'), 'retained factual bytes')
  const configStore = new ConfigStore(join(directory, 'config.json'))
  await configStore.save(structuredClone(DEFAULT_CONFIG))
  const config = await configStore.get()
  const configBefore = await readFile(join(directory, 'config.json'))
  let clock = 1000
  const readTable = vi.fn(async () => 'PID PPID RSS %CPU\n100 1 64 2\n101 100 32 1\n300 1 128 3\n777 1 1024 99')
  const appMetrics = () => [{ pid: 300, creationTime: 1, type: 'Browser', memory: { workingSetSize: 128 }, cpu: { percentCPUUsage: 3 } }] as Electron.ProcessMetric[]
  const sampler = new ProcessResourceSampler(readTable, () => clock, appMetrics)
  const other = new ProcessResourceSampler(readTable, () => clock, appMetrics)
  ;(globalThis as any).__metricsMutantSampler = other
  cleanup.push(() => { sampler.dispose(); other.dispose() })
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), undefined, sampler)
  const events = new Map<string, (event: any) => void>()
  const resourceReads = vi.fn(async () => ({ observedAt: 900, runCount: 1, runningRuns: 1, terminatedRuns: 0,
    terminatedUnattachedRuns: 0, attachments: 1, retainedOutputBytes: 64 }))
  const diagnostics = vi.fn(async () => ({ ctxmux: { state: { servingDirectory: storage } } }))
  const stop = vi.fn(), input = vi.fn(), attach = vi.fn(), resume = vi.fn()
  const fakeClient = (hostId: string) => ({ onEvent: (listener: (event: any) => void) => { events.set(hostId, listener); return () => events.delete(hostId) },
    runtimeResourceSnapshot: resourceReads, runtimeDiagnostics: diagnostics, runtimeIdentity: () => null,
    stopAgent: stop, writeAgentInput: input, attach: attach, resume: resume })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [
    { id: 'local', executionHost: { kind: 'local' }, client: fakeClient('local') },
    { id: 'remote', executionHost: { kind: 'ssh' }, client: fakeClient('remote') }
  ] as any, removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  // Only connected public owner facts are injected; actual commit/publish/attach/sampler stay loaded.
  let rendererReads = 0, rendererRelease: (() => void) | undefined
  const originalStore = useAppStore.getState()
  vi.spyOn(api.control, 'onRequest').mockImplementation(listener => {
    const control = createRendererControlApi({ onRequest: fn => { fixture.rendererRequest = fn; return () => { fixture.rendererRequest = undefined } },
      onCancellation: fn => { fixture.rendererCancel = fn; return () => { fixture.rendererCancel = undefined } },
      respond: response => { for (const accept of fixture.ipc.listeners.get(CONTROL_RESPONSE_CHANNEL) ?? []) accept({ sender }, response) }
    })
    rendererRelease = control.onRequest(listener)
    return rendererRelease
  })
  const sender = new class extends EventEmitter {
    readonly id = 919
    readonly mainFrame = { framesInSubtree: [{ detached: false, osProcessId: 300 }] }
    destroyed = false; loading = false
    isDestroyed() { return this.destroyed }
    isLoadingMainFrame() { return this.loading }
    send(channel: string, value: unknown) {
      if (channel === CONTROL_REQUEST_CHANNEL) { rendererReads++; fixture.rendererRequest?.(value) }
      if (channel === CONTROL_CANCEL_CHANNEL) fixture.rendererCancel?.(value)
      if (channel === RESOURCE_USAGE_CHANNEL) ipcFrames.push(value)
    }
  }()
  const ipcFrames: unknown[] = []
  const disposeRenderer = await useAppStore.getState().initialize()
  useAppStore.setState({ config, agentComposerDrafts: { 'healthy-session': 'preserved input' } })
  cleanup.push(() => { disposeRenderer(); rendererRelease?.(); useAppStore.setState(originalStore, true) })
  const dispose = await registerIpc({ window: { id: 7, isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    runtime, configStore, progressLoops: { subscribe: () => () => {} } as any,
    scratchTopics: {} as any, workspaceFiles: { dispose: async () => {} } as any })
  cleanup.push(dispose)
  events.get('local')!({ type: 'process-state', state: 'running', pid: 100, run: { runId: 'healthy-run', hostId: 'local' } })
  events.get('remote')!({ type: 'process-state', state: 'running', pid: 777, run: { runId: 'remote-run', hostId: 'remote' } })
  return { directory, sampler, runtime, configBefore, configStore, resourceReads, diagnostics, readTable, sender, ipcFrames,
    stop, input, attach, resume, get rendererReads() { return rendererReads }, tick: () => { clock += 1000 }, dispose }
}

describe('registered Main metrics and actual CLI', () => {
  it('shares one nonempty sampler for two CLI watches, get and the original IPC through two periods and releases to zero', async () => {
    const f = await registered()
    vi.useFakeTimers({ toFake: ['setInterval','clearInterval'] })
    const first = startCli(f.directory, 'watch'), second = startCli(f.directory, 'watch')
    await waitFor(() => { expect(first.frames().length + first.errors().length).toBeGreaterThan(0); expect(second.frames().length + second.errors().length).toBeGreaterThan(0) })
    expect(first.errors()).toEqual([]); expect(second.errors()).toEqual([])
    await waitFor(() => expect(first.frames().filter(frame => frame.event === 'snapshot').length).toBeGreaterThan(0))
    await waitFor(() => expect(second.frames().filter(frame => frame.event === 'snapshot').length).toBeGreaterThan(0))
    expect(samplerState(f.sampler)).toEqual({ consumers: 2, timer: true })
    expect(f.readTable).toHaveBeenCalledTimes(1)
    expect(f.resourceReads).toHaveBeenCalledTimes(2) // Once per connected host, once for the shared observation.
    expect(f.diagnostics).toHaveBeenCalledTimes(1)
    expect(f.rendererReads).toBe(1)
    const get = startCli(f.directory, 'get')
    await waitFor(() => expect(get.closed).toBe(true))
    expect(get.errors()).toEqual([]); expect(get.frames()).toHaveLength(1)
    expect(get.frames()[0]).toMatchObject({ ok: true, operation: 'metrics.get' })
    expect(samplerState(f.sampler).consumers).toBe(2)
    const snapshot = parseMetricsObservation(get.frames()[0].result.observation)
    expect(snapshot.process.data).toHaveLength(1)
    expect(snapshot.process.data![0]).toMatchObject({ runId: 'healthy-run', hostId: 'local', rootPid: 100, processCount: 2, rssKib: 96 })
    expect(snapshot.runtime.data).toHaveLength(2)
    expect(snapshot.runtime.data![0]!.runtimeStorageObservedAt).toBeTypeOf('number')
    expect(snapshot.runtime.data![1]!.process).toMatchObject({ cpuPercent: null, rssKib: null })
    expect(snapshot.renderer.data).toMatchObject({ window: { windowId: 7, webContentsId: 919, generation: 0 }, counts: { monacoEditors: null, monacoModels: null } })
    fixture.handlers.get('resourceUsage:subscribe')!({ sender: f.sender })
    expect(samplerState(f.sampler).consumers).toBe(3)
    expect(f.ipcFrames.length).toBeGreaterThan(0)
    f.tick(); await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(f.readTable).toHaveBeenCalledTimes(2))
    expect(f.resourceReads).toHaveBeenCalledTimes(2); expect(f.diagnostics).toHaveBeenCalledTimes(1)
    expect(f.rendererReads).toBe(2)
    await waitFor(() => expect(first.frames().filter(frame => frame.event === 'snapshot').length).toBeGreaterThan(1))
    await waitFor(() => expect(second.frames().filter(frame => frame.event === 'snapshot').length).toBeGreaterThan(1))
    const raw = first.frames()
    expect(raw[0]).toMatchObject({ event: 'attached', operation: 'metrics.watch', ok: true })
    const frames = raw.filter(frame => frame.event === 'snapshot')
    expect(frames.length).toBeGreaterThan(1)
    expect(new Set(raw.map(frame => frame.requestId)).size).toBe(1)
    expect(frames.at(-1)!.result.observation.runtime.lastSuccessAt).toBe(snapshot.runtime.lastSuccessAt)
    first.child.kill('SIGINT'); await waitFor(() => expect(first.closed).toBe(true))
    expect(samplerState(f.sampler).consumers).toBe(2)
    fixture.handlers.get('resourceUsage:unsubscribe')!({ sender: f.sender })
    expect(samplerState(f.sampler).consumers).toBe(1)
    second.child.kill('SIGTERM'); await waitFor(() => expect(second.closed).toBe(true))
    expect(samplerState(f.sampler)).toEqual({ consumers: 0, timer: false })
    expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.attach).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled()
    expect(await readFile(join(f.directory, 'config.json'))).toEqual(f.configBefore)
    expect(useAppStore.getState().agentComposerDrafts['healthy-session']).toBe('preserved input')
    const reads = f.readTable.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.readTable).toHaveBeenCalledTimes(reads)
    await record({ case: 'shared-positive', raw: [first.stdout, second.stdout, get.stdout], readTable: reads,
      runtimeReads: f.resourceReads.mock.calls.length, storageReads: f.diagnostics.mock.calls.length,
      rendererReads: f.rendererReads, consumers: samplerState(f.sampler), snapshot })
  })
  it('current window destruction ends a live CLI watch and releases immediately', async () => {
    const f = await registered(), watch = startCli(f.directory, 'watch')
    await waitFor(() => expect(watch.frames().filter(frame => frame.event === 'snapshot').length + watch.errors().length).toBeGreaterThan(0))
    expect(watch.errors()).toEqual([])
    f.sender.destroyed = true; f.sender.emit('destroyed')
    await waitFor(() => expect(watch.closed).toBe(true))
    expect(samplerState(f.sampler)).toEqual({ consumers: 0, timer: false })
    expect(watch.frames().at(-1)).toMatchObject({ event: 'end', result: { reason: 'owner-closed' } })
  })
  it('an actual CLI stdout pipe disconnect ends consumption without a further sampling period', async () => {
    const f = await registered()
    vi.useFakeTimers({ toFake: ['setInterval','clearInterval'] })
    const watch = startCli(f.directory, 'watch')
    await waitFor(() => expect(watch.frames().filter(frame => frame.event === 'snapshot').length + watch.errors().length).toBeGreaterThan(0))
    expect(watch.errors()).toEqual([])
    expect(samplerState(f.sampler)).toEqual({ consumers: 1, timer: true })
    watch.child.stdout!.destroy()
    // One real write discovers EPIPE; release must not depend on another period.
    f.tick(); await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(watch.closed).toBe(true))
    expect(watch.child.exitCode).toBe(1)
    expect(watch.errors()).toHaveLength(1)
    expect(watch.errors()[0]).toMatchObject({ ok: false, operation: 'metrics.watch' })
    expect(samplerState(f.sampler)).toEqual({ consumers: 0, timer: false })
    const reads = f.readTable.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.readTable).toHaveBeenCalledTimes(reads)
    expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
    await record({ case: 'stdout-disconnect', raw: watch.stdout, error: watch.stderr, reads,
      consumers: samplerState(f.sampler), exitCode: watch.child.exitCode })
  })
})

describe('same sampler source age and bounded observations', () => {
  it('reports first-frame Runtime pending, then its own completion time without refreshing process success', async () => {
    let now = 1000, complete!: (value: any[]) => void
    const sampler = new ProcessResourceSampler(async () => '100 1 42 2', () => now, () => [])
    cleanup.push(() => sampler.dispose())
    sampler.trackRun('healthy-run', 100, 'local')
    sampler.setObservationSources({ observeRuntime: () => new Promise(resolve => { complete = resolve }),
      processOwners: () => ({ rendererPids: [], browserPids: [] }),
      mainOwners: () => ({ sessionAttachmentOwners: 1, sessionAttachmentLeases: 1, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }) })
    const values: any[] = []
    const port = createResourceMetricsPort({ sampler, currentWindow: () => null, now: () => now })
    const subscription = await port.subscribe(value => values.push(parseMetricsObservation(value)), vi.fn(), new AbortController().signal)
    await waitFor(() => expect(values.length).toBeGreaterThan(0))
    expect(values[0].process.data).toHaveLength(1)
    expect(values[0].runtime).toEqual({ state: 'pending', data: null, observedAt: null, lastSuccessAt: null, reason: null })
    now = 1200
    complete([{ hostId: 'local', resources: { observedAt: 900, runCount: 1, runningRuns: 1, terminatedRuns: 0,
      terminatedUnattachedRuns: 0, attachments: 1, retainedOutputBytes: 7 }, unavailable: null,
      process: { cpuPercent: null, rssKib: null, unavailable: 'PID unavailable' }, runtimeStorage: null,
      runtimeStorageObservedAt: null, runtimeStorageUnavailable: 'No published directory' }])
    await waitFor(() => expect(values.at(-1).runtime.state).toBe('available'))
    expect(values.at(-1).runtime.lastSuccessAt).toBe(1200)
    expect(values.at(-1).process.lastSuccessAt).toBe(1000)
    subscription.dispose()
  })
  it('retains real success ages after failure and does not refresh Runtime/storage with a process tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval','clearInterval'] })
    let now = 1000, fail = false
    const read = vi.fn(async () => { if (fail) throw new Error('table unavailable'); return '100 1 42 2' })
    const sampler = new ProcessResourceSampler(read, () => now, () => []); cleanup.push(() => sampler.dispose())
    const runtime = vi.fn(async () => [{ hostId: 'local', resources: { observedAt: 800, runCount: 1, runningRuns: 1,
      terminatedRuns: 0, terminatedUnattachedRuns: 0, attachments: 1, retainedOutputBytes: 3 }, unavailable: null,
      process: { cpuPercent: null, rssKib: null, unavailable: 'PID unavailable' }, runtimeStorage: { path: '/selected', bytes: 7 },
      runtimeStorageUnavailable: null, runtimeStorageObservedAt: 850 }] as const as any)
    sampler.setObservationSources({ observeRuntime: runtime, processOwners: () => ({ rendererPids: [], browserPids: [] }),
      mainOwners: () => ({ sessionAttachmentOwners: 1, sessionAttachmentLeases: 1, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }) })
    sampler.trackRun('healthy-run', 100, 'local')
    const values: any[] = []
    const port = createResourceMetricsPort({ sampler, currentWindow: () => null, now: () => now })
    const subscription = await port.subscribe(v => values.push(v), vi.fn(), new AbortController().signal)
    await waitFor(() => expect(values.length).toBeGreaterThan(0))
    const initial = values.at(-1); expect(initial.process.data).toHaveLength(1)
    fail = true; now = 4000
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const failed = values.at(-1)
    expect(failed.process).toMatchObject({ state: 'stale', observedAt: 1000, lastSuccessAt: 1000, reason: 'table unavailable' })
    expect(failed.runtime).toMatchObject({ observedAt: initial.runtime.observedAt, lastSuccessAt: initial.runtime.lastSuccessAt })
    expect(failed.runtime.data[0].resources.observedAt).toBe(800)
    expect(failed.runtime.data[0].runtimeStorageObservedAt).toBe(850)
    expect(runtime).toHaveBeenCalledOnce()
    subscription.dispose(); expect(samplerState(sampler)).toEqual({ consumers: 0, timer: false })
    await record({ case: 'source-age', initial, failed })
  })
  it('keeps process and Renderer reads single-flight and rejects ended generation results on close/reopen', async () => {
    vi.useFakeTimers({ toFake: ['setInterval','clearInterval'] })
    let resolveTable!: (value: string) => void, resolveRenderer!: (value: any) => void
    const read = vi.fn(() => new Promise<string>(resolve => { resolveTable = resolve }))
    const renderer = vi.fn(() => new Promise<any>(resolve => { resolveRenderer = resolve }))
    const sampler = new ProcessResourceSampler(read, () => 1000, () => []); cleanup.push(() => sampler.dispose())
    sampler.setObservationSources({ observeRuntime: async () => [], observeRenderer: renderer,
      processOwners: () => ({ rendererPids: [], browserPids: [] }),
      mainOwners: () => ({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }) })
    const first: any[] = [], next: any[] = []
    const off = sampler.subscribe(v => first.push(v))
    await waitFor(() => expect(renderer).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledOnce(); expect(renderer).toHaveBeenCalledOnce()
    off(); const offNext = sampler.subscribe(v => next.push(v))
    resolveTable('100 1 64 3'); resolveRenderer({ observedAt: 900, data: { window: { windowId: 7, webContentsId: 919, generation: 0 }, counts: readRendererResourceOwnerCounts() } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(first).toEqual([]); expect(next).toEqual([])
    expect(renderer).toHaveBeenCalledTimes(2)
    offNext(); expect(samplerState(sampler)).toEqual({ consumers: 0, timer: false })
  })
  it('uses actual bridge cancellation and current generation to reject a late Renderer reply', async () => {
    let request: any, window = { windowId: 7, webContentsId: 919, generation: 0 }
    const cancellation = vi.fn()
    const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendRequest: value => { request = value }, sendCancellation: cancellation })
    const reading = observeRendererResources(bridge, () => window, new AbortController().signal)
    expect(request.operation).toBe('metrics.renderer')
    window = { ...window, generation: 1 }
    bridge.accept({ requestId: request.requestId, ok: true, result: { operation: 'metrics.renderer', window: request.window,
      observedAt: 1000, counts: readRendererResourceOwnerCounts() } })
    await expect(reading).rejects.toMatchObject({ code: 'CONTROL_OWNER_LOST' })
    const controller = new AbortController()
    const cancelled = observeRendererResources(bridge, () => window, controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(cancellation).toHaveBeenCalledOnce()
    bridge.dispose()
  })
})
