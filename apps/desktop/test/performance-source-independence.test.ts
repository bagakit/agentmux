import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { parseMetricsObservation, type MetricsObservation } from '@agentmux/core/control'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const table = '100 1 64 8\n101 100 32 2'
function fixture() {
  let at = 1000, cpu = 1
  const pending: ReturnType<typeof deferred<string>>[] = []
  const read = vi.fn(() => { const result = deferred<string>(); pending.push(result); return result.promise })
  const app = vi.fn(() => [{ pid: 200, creationTime: 10, type: 'Tab', cpu: { percentCPUUsage: 0, cumulativeCPUUsage: cpu }, memory: { workingSetSize: 64 } }] as Electron.ProcessMetric[])
  const sampler = new ProcessResourceSampler(read, () => at, app, () => at)
  const owners = vi.fn(() => ({ sessionAttachmentOwners: 1, sessionAttachmentLeases: 1, fileWatchers: 2, browserViews: 0, releasedBrowserViews: 0 }))
  // Unrelated sources stay pending, so their completion cannot sign this publication oracle.
  sampler.setObservationSources({ observeRuntime: () => new Promise(() => {}), processOwners: () => ({ rendererPids: [200], browserPids: [] }), mainOwners: owners })
  sampler.trackRun('original-run', 100, 'local')
  const seen: MetricsObservation[] = [], port = createResourceMetricsPort({ sampler, currentWindow: () => ({ windowId: 1, webContentsId: 2, generation: 3 }), now: () => at })
  const watch = async () => port.subscribe(value => seen.push(parseMetricsObservation(value)), () => {}, new AbortController().signal)
  const advance = async (ms = 1000) => { at += ms; cpu += ms / 2000; await vi.advanceTimersByTimeAsync(ms); await flush() }
  return { sampler, read, app, owners, port, seen, watch, pending, advance, advanceSync: (ms = 1000) => { at += ms; cpu += ms / 2000; vi.advanceTimersByTime(ms) }, setAt: (value: number) => { at = value } }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('publishes independent App and Main facts while one process-table read spans several ticks', async () => {
  vi.useFakeTimers()
  const f = fixture(), lease = await f.watch()
  try {
    expect(f.seen[0]?.app).toMatchObject({ state: 'available', data: { processes: [{ pid: 200, creationTime: 10, role: 'renderer' }], cpuPercent: null, rssKib: 64 } })
    expect(f.seen[0]?.main).toMatchObject({ state: 'available', data: { fileWatchers: 2 } })
    expect(f.seen[0]?.process).toMatchObject({ state: 'pending', data: null, lastSuccessAt: null })
    await flush(); f.seen.length = 0 // Independent unavailable Renderer/diagnostics receipts are already settled.
    const appCalls = f.app.mock.calls.length, ownerCalls = f.owners.mock.calls.length
    for (let i = 0; i < 3; i++) await f.advance()
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.app).toHaveBeenCalledTimes(appCalls + 3); expect(f.owners).toHaveBeenCalledTimes(ownerCalls + 3)
    const frames = f.seen.filter(o => o.app.lastSuccessAt !== 1000)
    expect([...new Set(frames.map(o => o.app.lastSuccessAt))]).toEqual([2000, 3000, 4000])
    expect(f.seen.at(-1)?.app.data?.cpuPercent).toBe(50)
    expect(f.seen.at(-1)?.process.state).toBe('pending')
  } finally { lease.dispose(); f.sampler.dispose(); f.port.dispose(); f.pending[0]!.resolve(table); await flush() }
})

it('publishes a completed process source on a later tick without adding a completion frame or refreshing its time', async () => {
  vi.useFakeTimers()
  const f = fixture(), lease = await f.watch()
  try {
    await flush(); f.seen.length = 0
    await f.advance(750); f.pending[0]!.resolve(table); await flush()
    expect(f.seen).toHaveLength(0)
    await f.advance(250)
    expect(f.seen.at(-1)?.process).toMatchObject({ state: 'available', observedAt: 1750, lastSuccessAt: 1750, data: [{ runId: 'original-run', rssKib: 96 }] })
    expect(f.seen.at(-1)?.app.lastSuccessAt).toBe(2000)
    const calls = f.app.mock.calls.length
    await f.advance()
    expect(f.app).toHaveBeenCalledTimes(calls + 1)
    expect(f.seen.at(-1)?.process.lastSuccessAt).toBe(1750)
    expect(f.read).toHaveBeenCalledTimes(2)
  } finally { lease.dispose(); f.sampler.dispose(); f.pending.at(-1)!.resolve(table); await flush() }
})

it.each(['success', 'failure'] as const)('keeps fresh App observation after reopen while a retired process %s settles', async mode => {
  vi.useFakeTimers()
  const f = fixture(), first = await f.watch()
  await flush(); first.dispose(); f.setAt(5000)
  const reopened = await f.watch()
  try {
    await flush(); expect(f.seen.at(-1)?.app).toMatchObject({ state: 'available', lastSuccessAt: 5000, data: { cpuPercent: null } })
    const before = f.seen.length
    if (mode === 'success') f.pending[0]!.resolve(table)
    else f.pending[0]!.reject(new Error('retired process failure'))
    await flush(); expect(f.seen).toHaveLength(before)
    await f.advance()
    expect(f.seen.at(-1)?.process).toMatchObject({ state: 'pending', data: null, reason: null })
    expect(f.seen.at(-1)?.app.data?.cpuPercent).toBe(50)
    expect(f.read).toHaveBeenCalledTimes(2)
  } finally { reopened.dispose(); f.sampler.dispose(); f.pending.at(-1)!.resolve(table); await flush() }
})

it('retains successful Run data and its source age when a later process read fails, independently of App CPU', async () => {
  vi.useFakeTimers()
  const f = fixture(), lease = await f.watch()
  try {
    await flush(); await f.advance(500); f.pending[0]!.resolve(table); await flush(); await f.advance(500)
    const successful = f.seen.at(-1)!.process
    await f.advance(500); f.pending[1]!.reject(new Error('process source failed')); await flush(); await f.advance(500)
    expect(f.seen.at(-1)?.process).toMatchObject({ state: 'stale', data: successful.data, lastSuccessAt: 1500, reason: 'process source failed' })
    expect(f.seen.at(-1)?.app).toMatchObject({ state: 'available', lastSuccessAt: 3000, data: { cpuPercent: 50 } })
  } finally { lease.dispose(); f.sampler.dispose(); f.pending.at(-1)!.resolve(table); await flush() }
})

it('keeps no-consumer and synchronous subscription failure free of sampling clocks', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    await f.advance(5000); expect(f.read).not.toHaveBeenCalled(); expect(f.app).not.toHaveBeenCalled()
    expect(() => f.sampler.subscribe(() => { throw new Error('subscriber failed') })).toThrow('subscriber failed')
    const app = f.app.mock.calls.length, read = f.read.mock.calls.length
    await f.advance(5000); expect(f.app).toHaveBeenCalledTimes(app); expect(f.read).toHaveBeenCalledTimes(read)
    f.pending[0]!.resolve(table); await flush()
    expect(vi.getTimerCount()).toBe(0)
  } finally { f.sampler.dispose() }
})

it.each(['stop', 'reopen', 'add', 'remove-peer'] as const)('keeps subscription publication and sampling correct under synchronous %s', async mode => {
  vi.useFakeTimers()
  const f = fixture(), synchronous: number[] = [], peer: number[] = []
  let release = () => {}, second = () => {}, fired = false
  release = f.sampler.subscribe(sample => {
    if (sample.appObservedAt !== 2000 || fired) return
    fired = true
    if (mode === 'stop' || mode === 'reopen') release()
    if (mode === 'remove-peer') second()
    if (mode === 'add' || mode === 'reopen') second = f.sampler.subscribe(value => {
      synchronous.push(value.app?.cpuPercent ?? -1)
    })
  })
  if (mode === 'remove-peer') second = f.sampler.subscribe(value => { if (value.appObservedAt === 2000) peer.push(1) })
  try {
    await flush(); f.pending[0]!.resolve(table); await flush()
    f.advanceSync() // Inspect the synchronous broadcast before independent async source receipts.
    if (mode === 'stop') {
      await flush()
      expect(f.read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
      const calls = f.app.mock.calls.length; await f.advance(); expect(f.app).toHaveBeenCalledTimes(calls)
    } else if (mode === 'remove-peer') expect(peer).toEqual([])
    else expect(synchronous).toEqual([mode === 'reopen' ? -1 : 50])
  } finally { release(); second(); f.sampler.dispose(); for (const pending of f.pending) pending.resolve(table); await flush() }
})

it('returns the independent first frame through the original Unix get/watch and source-compiled CLI without resolving PS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-independent-')), f = fixture()
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: vi.fn(), metrics: f.port }, join(directory, 'control.sock'))
  const leases: { dispose(): void }[] = []
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'control.sock') } })
    const get = await rpc.call('system.metrics.get', {})
    expect(get.observation.app).toMatchObject({ state: 'available', data: { processes: [{ pid: 200, creationTime: 10 }] } })
    expect(get.observation.process.state).toBe('pending')
    const watched: MetricsObservation[] = []
    leases.push(await rpc.subscribe('system.metrics.watch', {}, { onInitial: value => watched.push(value.observation), onEvent: event => { if (event.type === 'snapshot') watched.push(event.data) }, onEnd: () => {} }))
    expect(watched[0]?.app.state).toBe('available'); expect(watched[0]?.process.state).toBe('pending')
    await mkdir(join(directory, 'compiled'))
    const entry = await compileRendererProfileCli(resolve(import.meta.dirname, '../../..'), join(directory, 'compiled'), {}, process.env.AGENTMUX_PERFORMANCE_LOADED)
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [entry, '--endpoint', 'unix://' + join(directory, 'control.sock'), 'system', 'metrics', 'get'], { env: objectCliEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Private metrics CLI exceeded its test observation wait')) }, 15000)
      child.on('error', error => { clearTimeout(timer); reject(error) }); child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }) })
    })
    expect(output.code).toBe(0); expect(output.stderr).toBe('')
    const actual = parseMetricsObservation(JSON.parse(output.stdout).result.observation)
    expect(actual.app.data?.processes[0]).toMatchObject({ pid: 200, creationTime: 10 })
    expect(actual.process.state).toBe('pending'); expect(f.read).toHaveBeenCalledTimes(1)
    if (process.env.AGENTMUX_INDEPENDENCE_EVIDENCE) appendFileSync(process.env.AGENTMUX_INDEPENDENCE_EVIDENCE,
      JSON.stringify({ chain: ['ProcessResourceSampler', 'createResourceMetricsPort', 'AgentMuxControlServer', 'original public get/watch', 'source-compiled CLI'], get: get.observation, watch: watched[0], cli: actual, processReads: f.read.mock.calls.length, lifecycleActions: false }) + '\n')
  } finally {
    for (const lease of leases) await lease.dispose()
    await rpc?.dispose(); await server.stop(); f.sampler.dispose(); f.port.dispose(); for (const pending of f.pending) pending.resolve(table)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
