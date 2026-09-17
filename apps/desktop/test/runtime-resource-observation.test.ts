import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore, type AgentMuxRuntimeResourceSnapshot } from '@agentmux/core'
import type { RuntimeUsage, UsageSnapshot } from '../src/shared/process-usage.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'

const fixture = vi.hoisted(() => ({ storage: vi.fn() }))
vi.mock('@agentmux/core', async (original) => ({
  ...await original<typeof import('@agentmux/core')>(),
  runtimeStorageUsage: fixture.storage
}))

import { RuntimeController } from '../src/main/runtime-controller.js'

const resources: AgentMuxRuntimeResourceSnapshot = {
  observedAt: 10, runCount: 4, runningRuns: 1, terminatedRuns: 3,
  terminatedUnattachedRuns: 2, attachments: 2, retainedOutputBytes: 1234
}
const runtimeRow: RuntimeUsage = {
  hostId: 'local', resources, unavailable: null,
  process: { cpuPercent: null, rssKib: null, unavailable: 'ctxmux does not publish its daemon PID' },
  runtimeStorage: { path: '/fixture/current', bytes: 7890 },
  runtimeStorageUnavailable: null
}

function metric(pid: number, type: Electron.ProcessMetric['type'], cpu: number, rss: number, creationTime = 1): Electron.ProcessMetric {
  return {
    pid, type, creationTime,
    cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: rss, peakWorkingSetSize: rss, privateBytes: rss }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function sampling(observeRuntime = vi.fn(async () => [runtimeRow])) {
  let now = 1000
  let current = [
    metric(10, 'Browser', 10, 100), metric(11, 'Tab', 20, 200),
    metric(12, 'Tab', 30, 300), metric(13, 'GPU', 40, 400),
    metric(14, 'Utility', 50, 500), metric(15, 'Tab', 60, 600)
  ]
  const appMetrics = vi.fn(() => current)
  const table = vi.fn(async () => 'PID PPID RSS %CPU\n100 1 1000 5\n101 100 100 1')
  const sampler = new ProcessResourceSampler(table, () => now, appMetrics)
  const mainOwners = vi.fn(() => ({
    sessionAttachmentOwners: 2, sessionAttachmentLeases: 3, fileWatchers: 1,
    browserViews: 2, releasedBrowserViews: 1
  }))
  const processOwners = vi.fn(() => ({ rendererPids: [11, 11], browserPids: [12, 12] }))
  sampler.setObservationSources({
    observeRuntime, processOwners, mainOwners
  })
  sampler.trackRun('run-a', 100)
  const seen: UsageSnapshot[] = []
  return {
    sampler, seen, table, appMetrics, observeRuntime, mainOwners, processOwners,
    open: () => sampler.subscribe((snapshot) => seen.push(snapshot)),
    latest: () => seen.at(-1)!,
    metrics: (next: Electron.ProcessMetric[]) => { current = next },
    tick: async () => { now += 1000; await vi.advanceTimersByTimeAsync(1000) }
  }
}

beforeEach(() => { vi.useFakeTimers(); fixture.storage.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('product resource subscription', () => {
  it('publishes actual process roles, warms CPU, deduplicates PIDs, and keeps one Runtime observation per open', async () => {
    const h = sampling()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.table).not.toHaveBeenCalled()
    expect(h.appMetrics).not.toHaveBeenCalled()
    expect(h.observeRuntime).not.toHaveBeenCalled()
    const close = h.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.latest().app?.groups).toEqual([
      { role: 'main', processCount: 1, rssKib: 100, cpuPercent: null },
      { role: 'renderer', processCount: 1, rssKib: 200, cpuPercent: null },
      { role: 'browser', processCount: 1, rssKib: 300, cpuPercent: null },
      { role: 'gpu', processCount: 1, rssKib: 400, cpuPercent: null },
      { role: 'utility', processCount: 1, rssKib: 500, cpuPercent: null },
      { role: 'other', processCount: 1, rssKib: 600, cpuPercent: null }
    ])
    expect(h.latest().app).toMatchObject({ processCount: 6, cpuPercent: null, rssKib: 2100, unavailable: null })
    expect(h.latest().runtime).toEqual([runtimeRow])
    expect(h.latest().mainOwners).toEqual(h.mainOwners())
    await h.tick()
    expect(h.latest().app?.groups.map(({ role, cpuPercent }) => [role, cpuPercent])).toEqual([
      ['main', 10], ['renderer', 20], ['browser', 30], ['gpu', 40], ['utility', 50], ['other', 60]
    ])
    expect(h.latest().app?.cpuPercent).toBe(210)
    h.metrics([metric(10, 'Browser', 1, 99), metric(10, 'Browser', 1, 99)])
    await h.tick()
    expect(h.latest().app?.processCount).toBe(1)
    expect(h.latest().app?.rssKib).toBe(99)
    // CPU names a ten-second peak; RSS names the latest water level.
    expect(h.latest().app?.groups[0]?.cpuPercent).toBe(10)
    h.processOwners.mockReturnValue({ rendererPids: [12], browserPids: [12] })
    h.metrics([metric(12, 'Tab', 30, 300)])
    await h.tick()
    expect(h.latest().app?.groups.map(({ role, processCount, rssKib }) => [role, processCount, rssKib])).toEqual([
      ['main', 0, 0], ['renderer', 0, 0], ['browser', 0, 0],
      ['gpu', 0, 0], ['utility', 0, 0], ['other', 1, 300]
    ])
    h.metrics([metric(10, 'Browser', 0, 88, 2)])
    await h.tick()
    expect(h.latest().app?.cpuPercent).toBeNull()
    expect(h.observeRuntime).toHaveBeenCalledOnce()
    close()
    const calls = h.table.mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.table).toHaveBeenCalledTimes(calls)
    const closeAgain = h.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.observeRuntime).toHaveBeenCalledTimes(2)
    expect(h.latest().app?.cpuPercent).toBeNull()
    closeAgain()
    h.sampler.dispose()
  })

  it('Runtime and Electron failures stay separate from current Agent readings', async () => {
    const h = sampling(vi.fn(async () => { throw new Error('Runtime inventory failed') }))
    const close = h.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.latest().runtimeUnavailable).toBe('Runtime inventory failed')
    expect(h.latest().runtime).toBeNull()
    expect(h.latest().app?.rssKib).toBe(2100)
    expect(h.latest().runs).toEqual([{ runId: 'run-a', processCount: 2, cpuPercent: 6, rssKib: 1100 }])
    h.appMetrics.mockImplementationOnce(() => { throw new Error('Electron metrics failed') })
    await h.tick()
    expect(h.latest().app).toMatchObject({ rssKib: 2100, unavailable: 'Electron metrics failed' })
    expect(h.latest().unavailable).toBeNull()
    expect(h.latest().runs).toEqual([{ runId: 'run-a', processCount: 2, cpuPercent: 6, rssKib: 1100 }])
    h.table.mockRejectedValueOnce(new Error('ps failed'))
    await h.tick()
    expect(h.latest().unavailable).toBe('ps failed')
    expect(h.latest().app?.unavailable).toBeNull()
    expect(h.latest().app?.cpuPercent).toBe(210)
    close()
    h.sampler.dispose()
  })

  it('bounds rapid reopen to one pending Runtime read and then observes only the current generation', async () => {
    const old = deferred<RuntimeUsage[]>()
    const current = deferred<RuntimeUsage[]>()
    const observe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const h = sampling(observe)
    let close = h.open()
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 5; index += 1) {
      close()
      close = h.open()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(observe).toHaveBeenCalledTimes(1)
    expect(h.latest().runtime).toBeNull()
    // App/Agent sampling keeps running while old Runtime I/O is pending.
    await h.tick()
    expect(h.latest().runs).toEqual([{ runId: 'run-a', processCount: 2, cpuPercent: 6, rssKib: 1100 }])
    expect(h.latest().app?.cpuPercent).toBe(210)
    old.resolve([{ ...runtimeRow, hostId: 'old-open' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(h.latest().runtime).toBeNull()
    current.resolve([runtimeRow])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.latest().runtime).toEqual([runtimeRow])
    close()
    h.sampler.dispose()
  })

  it('does not start deferred Runtime I/O after the last reopen closes', async () => {
    const old = deferred<RuntimeUsage[]>()
    const observe = vi.fn().mockReturnValueOnce(old.promise)
    const h = sampling(observe)
    let close = h.open()
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 3; index += 1) {
      close()
      close = h.open()
      await vi.advanceTimersByTimeAsync(0)
    }
    close()
    const count = h.seen.length
    old.resolve([runtimeRow])
    await vi.advanceTimersByTimeAsync(0)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(h.seen).toHaveLength(count)
    h.sampler.dispose()
  })

  it.each(['success', 'failure'])('closing invalidates late Runtime %s across a new observation', async (outcome) => {
    const old = deferred<RuntimeUsage[]>()
    const current = deferred<RuntimeUsage[]>()
    const observe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const h = sampling(observe)
    const firstClose = h.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.latest().runtime).toBeNull()
    firstClose()
    const secondClose = h.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(observe).toHaveBeenCalledTimes(1)
    const beforeOld = h.seen.length
    if (outcome === 'success') old.resolve([{ ...runtimeRow, hostId: 'previous-observation' }])
    else old.reject(new Error('previous observation failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.seen).toHaveLength(beforeOld)
    expect(observe).toHaveBeenCalledTimes(2)
    current.resolve([runtimeRow])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.latest().runtime).toEqual([runtimeRow])
    expect(h.latest().runtimeUnavailable).toBeNull()
    secondClose()
    h.sampler.dispose()
  })
})

describe('existing RuntimeController resource observation owner', () => {
  it('uses public connected snapshots and measures only the selected Runtime storage once', async () => {
    fixture.storage.mockResolvedValue(runtimeRow.runtimeStorage)
    const client = {
      runtimeResourceSnapshot: vi.fn(async () => resources),
      connect: vi.fn(() => { throw new Error('resource observation must not activate Runtime') }),
      stopTerminal: vi.fn(), remove: vi.fn()
    }
    const controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
    Object.assign(controller, { hosts: new Map([
      ['local', { executionHost: { kind: 'local' }, client }],
      ['other-local', { executionHost: { kind: 'local' }, client }]
    ]) })
    const rows = await controller.resourceUsageObservation()
    expect(rows).toEqual([{ ...runtimeRow, hostId: 'local' }, { ...runtimeRow, hostId: 'other-local' }])
    expect(fixture.storage).toHaveBeenCalledOnce()
    expect(fixture.storage).toHaveBeenCalledWith()
    expect(client.runtimeResourceSnapshot).toHaveBeenCalledTimes(2)
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.stopTerminal).not.toHaveBeenCalled()
    expect(client.remove).not.toHaveBeenCalled()
  })

  it('a per-host Runtime failure and storage error leave the other host inventory intact', async () => {
    fixture.storage.mockRejectedValue(new Error('directory observation failed'))
    const good = { runtimeResourceSnapshot: async () => resources }
    const bad = { runtimeResourceSnapshot: async () => { throw new Error('disconnected') } }
    const controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
    Object.assign(controller, { hosts: new Map([
      ['working', { executionHost: { kind: 'local' }, client: good }],
      ['failed', { executionHost: { kind: 'local' }, client: bad }]
    ]) })
    const rows = await controller.resourceUsageObservation()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ hostId: 'working', resources, unavailable: null,
      runtimeStorage: null, runtimeStorageUnavailable: 'directory observation failed' })
    expect(rows[1]).toMatchObject({ hostId: 'failed', resources: null, unavailable: 'disconnected',
      runtimeStorage: null, runtimeStorageUnavailable: 'directory observation failed' })
    expect(fixture.storage).toHaveBeenCalledOnce()
    expect(fixture.storage).toHaveBeenCalledWith()
  })
})
