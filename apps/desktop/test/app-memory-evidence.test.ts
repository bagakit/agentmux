import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseAppMemoryEvidence } from '@agentmux/core/control'
import { AppMemoryEvidenceOwner } from '../src/main/app-memory-evidence.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
const closes: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.useRealTimers() })

const processMetric = (pid: number, creationTime: number, rssKib: number, type: string) =>
  ({ pid, creationTime, type, memory: { workingSetSize: rssKib }, cpu: { cumulativeCPUUsage: 0 } }) as Electron.ProcessMetric

it('retains exact application and process peaks across Main instances with bounded records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amem-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'evidence.json')
  let observedAt = 1000, mainCreation = 10, rendererRss = 100
  const metrics = () => [processMetric(process.pid, mainCreation, 20, 'Browser'),
    processMetric(200, mainCreation + 1, rendererRss, 'Tab')]
  const owner = new AppMemoryEvidenceOwner(file, { metrics, now: () => observedAt })
  await owner.sampleOnce(); await owner.settle()
  observedAt = 2000; rendererRss = 700
  await owner.sampleOnce(); await owner.settle()
  expect((await owner.inspect()).segments[0]).toMatchObject({ sampleCount: 2,
    peak: { observedAt: 2000, rssKib: 720, processCount: 2, omittedProcesses: 0 },
    largestProcess: { pid: 200, creationTime: 11, rssKib: 700, observedAt: 2000 } })
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  owner.dispose()

  mainCreation = 30; observedAt = 3000; rendererRss = 50
  const restored = new AppMemoryEvidenceOwner(file, { metrics, now: () => observedAt })
  await restored.sampleOnce(); await restored.settle()
  const evidence = parseAppMemoryEvidence(await restored.inspect())
  expect(evidence.segments).toHaveLength(2)
  expect(evidence.segments[0]?.peak.rssKib).toBe(720)
  expect(evidence.segments[1]?.main.creationTime).toBe(30)
  for (let index = 0; index < 9; index++) {
    mainCreation += 10; observedAt += 1000
    await restored.sampleOnce(); await restored.settle()
  }
  expect((await restored.inspect()).segments).toHaveLength(8)
  expect((await readFile(file, 'utf8')).length).toBeLessThan(20_000)
  restored.dispose()
})

it('keeps sampling and persistence failures visible without overwriting unreadable evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amem-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'evidence.json')
  await writeFile(file, 'original unreadable evidence')
  const owner = new AppMemoryEvidenceOwner(file, { now: () => 1000,
    metrics: () => [processMetric(process.pid, 10, 20, 'Browser')] })
  await owner.sampleOnce()
  expect((await owner.inspect()).persistence).toMatchObject({ state: 'unconfirmed' })
  expect(await readFile(file, 'utf8')).toBe('original unreadable evidence')
  owner.dispose()

  const failed = new AppMemoryEvidenceOwner(join(directory, 'new.json'), { now: () => 1000,
    metrics: () => [processMetric(process.pid, 10, 20, 'Browser')],
    write: async () => { throw new Error('storage unavailable') } })
  await failed.sampleOnce(); await failed.settle()
  expect((await failed.inspect()).persistence).toMatchObject({ state: 'unconfirmed', reason: 'storage unavailable' })
  failed.dispose()
})

it('samples in Main without a panel consumer and releases its own timer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amem-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const metrics = vi.fn(() => [processMetric(process.pid, 10, 20, 'Browser')])
  const owner = new AppMemoryEvidenceOwner(join(directory, 'evidence.json'), { metrics, now: () => 1000 })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  await owner.start(); await owner.settle()
  expect(metrics).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(30_000); await owner.settle()
  expect(metrics).toHaveBeenCalledTimes(2)
  owner.dispose()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(metrics).toHaveBeenCalledTimes(2)
})

it('disposal during the original load prevents late sampling, writes and timer installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amem-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'evidence.json')
  await writeFile(file, JSON.stringify({ schema: 'agentmux.app-memory-evidence.v1', segments: [] }))
  let release!: (value: string) => void, entered!: () => void
  const pendingRead = new Promise<string>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  const metrics = vi.fn(() => [processMetric(process.pid, 10, 20, 'Browser')]), write = vi.fn()
  const owner = new AppMemoryEvidenceOwner(file, { metrics, write,
    read: async () => { entered(); return pendingRead } })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const first = owner.start(), second = owner.start()
  await reading
  owner.dispose()
  release(JSON.stringify({ schema: 'agentmux.app-memory-evidence.v1', segments: [] }))
  await Promise.all([first, second])
  await owner.start(); await owner.sampleOnce(); await owner.settle()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(vi.getTimerCount()).toBe(0)
  expect(metrics).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('shares one startup and retries unavailable samples on the original low-frequency clock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amem-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const metrics = vi.fn().mockImplementationOnce(() => { throw new Error('metrics temporarily unavailable') })
    .mockImplementation(() => [processMetric(process.pid, 10, 20, 'Browser')])
  const owner = new AppMemoryEvidenceOwner(join(directory, 'evidence.json'), { metrics })
  closes.push(() => owner.dispose())
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  await Promise.all([owner.start(), owner.start()])
  expect(metrics).toHaveBeenCalledOnce()
  expect((await owner.inspect()).sampling).toEqual({ state: 'unavailable', reason: 'metrics temporarily unavailable' })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(30_000); await owner.settle()
  expect(metrics).toHaveBeenCalledTimes(2)
  expect((await owner.inspect()).sampling.state).toBe('available')
})

it('bounds process details and coalesces pending writes into the latest retained peaks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amem-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  let release!: () => void, observedAt = 1000, value = 100
  const firstWrite = new Promise<void>(resolve => { release = resolve })
  const writes: string[] = []
  const owner = new AppMemoryEvidenceOwner(join(directory, 'evidence.json'), {
    now: () => observedAt, metrics: () => [processMetric(process.pid, 10, 20, 'Browser'),
      ...Array.from({ length: 20 }, (_, index) => processMetric(200 + index, 11 + index, value, 'Tab'))],
    write: async (_file, contents) => { writes.push(String(contents)); if (writes.length === 1) await firstWrite }
  })
  closes.push(() => owner.dispose())
  await owner.sampleOnce()
  observedAt += 1000; value = 200; await owner.sampleOnce()
  observedAt += 1000; value = 300; await owner.sampleOnce()
  expect(writes).toHaveLength(1)
  expect((await owner.inspect()).persistence).toMatchObject({ state: 'pending', coalescedWrites: 1 })
  release(); await owner.settle()
  expect(writes).toHaveLength(2)
  const evidence = parseAppMemoryEvidence(await owner.inspect())
  expect(evidence.segments[0]?.peak).toMatchObject({ rssKib: 6020, processCount: 21, omittedProcesses: 5 })
  expect(evidence.segments[0]?.peak.processes).toHaveLength(16)
  expect(JSON.parse(writes[1]!).segments[0].peak.rssKib).toBe(6020)
  expect(evidence.persistence.state).toBe('confirmed')
})

it('exposes retained evidence through the real public CLI without opening resource sampling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amem-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const readMetrics = vi.fn(() => [processMetric(process.pid, 10, 20, 'Browser'), processMetric(200, 11, 700, 'Tab')])
  const owner = new AppMemoryEvidenceOwner(join(directory, 'evidence.json'), { now: () => 1000, metrics: readMetrics })
  await owner.sampleOnce(); await owner.settle(); owner.dispose()
  const restoredMetrics = vi.fn(() => { throw new Error('Reading retained memory must not resample.') })
  const restored = new AppMemoryEvidenceOwner(join(directory, 'evidence.json'), { metrics: restoredMetrics })
  const subscribe = vi.fn(() => { throw new Error('Resource panel sampling must remain closed.') })
  const metrics = createResourceMetricsPort({ sampler: { subscribe } as any, currentWindow: () => null, appMemory: restored })
  closes.push(() => { metrics.dispose(); restored.dispose() })
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [],
    execute: vi.fn(), metrics })
  await server.start(); closes.push(() => server.stop())
  const compiled = join(directory, 'compiled')
  await mkdir(compiled)
  const frozen = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(await readFile(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
  const cli = await compileRendererProfileCli(resolve(import.meta.dirname, '../../..'), compiled, frozen, process.env.AGENTMUX_PERFORMANCE_LOADED)
  const run = (...args: string[]) => promisify(execFile)(process.execPath,
    [cli, '--endpoint', 'unix://' + join(directory, 'control.sock'), ...args],
    { env: objectCliEnvironment(directory), timeout: 15000 })
  const result = await run('system', 'metrics', 'app-memory', 'inspect')
  const evidence = parseAppMemoryEvidence(JSON.parse(result.stdout).result.evidence)
  expect(evidence.segments[0]?.peak).toMatchObject({ rssKib: 720, processCount: 2 })
  expect(evidence.sampling.state).toBe('unavailable')
  expect(evidence.persistence.state).toBe('unconfirmed')
  const help = await run('system', 'metrics', 'app-memory', 'inspect', '--help')
  expect(help.stdout).toContain('sampling gaps remain unknown')
  expect(help.stdout).toContain('working-set')
  expect(restoredMetrics).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
  expect(readMetrics).toHaveBeenCalledOnce()
  metrics.dispose()
  await expect(metrics.inspectAppMemory!()).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})
