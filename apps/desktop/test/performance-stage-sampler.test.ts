import { afterEach, expect, it, vi } from 'vitest'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { createInputPerformanceRecorder, hostedCarrierPerformance } from '@agentmux/core'
import { parseMetricsObservation, type MetricsObservation } from '@agentmux/core/control'
import { createRendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { aggregateUsage, pruneSamples } from '../src/shared/process-usage'
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it('normalizes real App sampler values to one-core CPU while preserving warmup and PID reuse', async () => {
  vi.useFakeTimers()
  let at = 1000, creation = 1
  const sampler = new ProcessResourceSampler(async () => '100 1 64 100', () => at,
    () => [{ pid: 200, creationTime: creation, type: 'Browser', cpu: { percentCPUUsage: 12.5, cumulativeCPUUsage: at / 1000 }, memory: { workingSetSize: 64 } }] as Electron.ProcessMetric[], () => at)
  sampler.trackRun('synthetic-run', 100, 'local')
  const seen: MetricsObservation[] = []
  const port = createResourceMetricsPort({ sampler, currentWindow: () => null, now: () => at })
  const subscription = await port.subscribe(snapshot => seen.push(parseMetricsObservation(snapshot)), () => {}, new AbortController().signal)
  await flush()
  expect(seen.at(-1)?.app.data?.cpuPercent).toBeNull()
  at += 1000; await vi.advanceTimersByTimeAsync(1000); await flush()
  expect(seen.at(-1)).toMatchObject({ units: { cpuBasis: 'one-logical-core' }, app: { data: { cpuPercent: 100 } }, process: { data: [{ cpuPercent: 100 }] } })
  creation++; at += 1000; await vi.advanceTimersByTimeAsync(1000); await flush()
  expect(seen.at(-1)?.app.data?.cpuPercent).toBeNull()
  subscription.dispose(); port.dispose(); sampler.dispose()
})
it('samples diagnostics only during demand, rejects old generations and preserves unavailable instead of zero', async () => {
  vi.useFakeTimers()
  const input = createInputPerformanceRecorder()
  const main = { processId: 100, observedAt: 1000, input: input.snapshot(), carrier: hostedCarrierPerformance.snapshot() }
  let answer!: (value: any) => void
  const observe = vi.fn(() => new Promise<any>(resolve => { answer = resolve }))
  const sampler = new ProcessResourceSampler(async () => '', () => 1000, () => [], () => 1000)
  sampler.setObservationSources({ observeRuntime: async () => [], processOwners: () => ({ rendererPids: [], browserPids: [] }),
    mainOwners: () => ({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }), observeDiagnostics: observe })
  expect(observe).not.toHaveBeenCalled()
  const seen: MetricsObservation[] = []
  const port = createResourceMetricsPort({ sampler, currentWindow: () => null })
  const a = await port.subscribe(snapshot => seen.push(parseMetricsObservation(snapshot)), () => {}, new AbortController().signal)
  const histogram = (sampler as unknown as { eventLoop: import('node:perf_hooks').IntervalHistogram }).eventLoop
  expect(histogram.enable()).toBe(false) // It is already enabled by actual demand.
  await flush(); expect(observe).toHaveBeenCalledTimes(1)
  const old = answer; a.dispose()
  expect(histogram.disable()).toBe(false) // Last consumer already stopped the native monitor.
  const b = await port.subscribe(snapshot => seen.push(parseMetricsObservation(snapshot)), () => {}, new AbortController().signal)
  expect(histogram.enable()).toBe(false)
  await flush(); old({ main, hosts: [], omittedHosts: 0, storage: null, storageUnavailable: 'unknown synthetic volume' }); await flush()
  expect(observe).toHaveBeenCalledTimes(2)
  expect(seen.at(-1)?.diagnostics.state).toBe('pending')
  answer({ main, hosts: [{ hostId: 'offline', data: null, unavailable: 'disconnected owner' }], omittedHosts: 0, storage: null, storageUnavailable: 'unknown synthetic volume' }); await flush()
  expect(seen.at(-1)?.diagnostics).toMatchObject({ state: 'available', data: { hosts: [{ data: null, unavailable: 'disconnected owner' }], eventLoop: { generation: 1, count: 0, meanMs: null, maxMs: null } } })
  await vi.advanceTimersByTimeAsync(3000); await flush()
  expect(seen.at(-1)?.diagnostics).toMatchObject({ state: 'stale', reason: expect.stringContaining('timed out') })
  b.dispose(); const calls = observe.mock.calls.length
  await vi.advanceTimersByTimeAsync(5000); expect(observe).toHaveBeenCalledTimes(calls)
  port.dispose(); sampler.dispose()
})
it('keeps fixed overlay cause counters and separate user/protocol/paste request completion facts', async () => {
  let ms = 0
  const observer = createRendererPerformance(() => ms, () => 1000 + ms)
  for (let i = 0; i < 1000; i++) observer.observeOverlay({ reason: 'mutation', scheduled: i === 0, coalesced: i > 0, nativeDemandCount: 1 })
  observer.observeOverlay({ reason: 'collect', scheduled: false, coalesced: false, nativeDemandCount: 1, candidateCount: 3, geometryReadCount: 2, collectMs: 7 })
  observer.observeInputRequest('user', Promise.resolve(), ms)
  const failed = Promise.reject(new Error('do not store this body'))
  observer.observeInputRequest('protocol', failed, ms); observer.observeInputRequest('paste', Promise.resolve(), ms)
  ms += 11; await flush()
  const value = observer.snapshot()
  expect(value.overlay).toMatchObject({ triggers: { mutation: 1000, collect: 1 }, scheduled: 1, coalesced: 999, candidates: 3, geometryReads: 2, collect: { totalMs: 7 } })
  expect(value.inputRequests).toMatchObject({ user: { completed: 1, pending: 0 }, protocol: { failed: 1, pending: 0 }, paste: { completed: 1, pending: 0 } })
  value.overlay.triggers.mutation = 0; expect(observer.snapshot().overlay.triggers.mutation).toBe(1000)
  expect(JSON.stringify(value)).not.toContain('do not store this body')
})
it('keeps current memory/process facts and unknown CPU for missing/reset counters or nonpositive intervals', async () => {
  vi.useFakeTimers()
  let at = 1000, rss = 64, seconds: number | undefined
  const sampler = new ProcessResourceSampler(async () => '', () => at,
    () => [{ pid: 200, creationTime: 1, type: 'Browser', cpu: { percentCPUUsage: 12.5, cumulativeCPUUsage: seconds }, memory: { workingSetSize: rss } }] as Electron.ProcessMetric[], () => at)
  const seen: MetricsObservation[] = [], port = createResourceMetricsPort({sampler,currentWindow:()=>null})
  const subscription = await port.subscribe(value => seen.push(parseMetricsObservation(value)), () => {}, new AbortController().signal)
  await flush()
  for (const value of [undefined, 5, 3, 4]) {
    seconds = value; rss += 64
    // Deliberately no monotonic interval; old percentCPUUsage still must not become a value.
    await vi.advanceTimersByTimeAsync(1000); await flush()
    expect(seen.at(-1)?.app).toMatchObject({state:'available',data:{processCount:1,rssKib:rss,cpuPercent:null}})
  }
  subscription.dispose();port.dispose();sampler.dispose()
})
it('keeps reading history bounded under frozen/backwards wall clocks and expires real ten-second peaks', async () => {
  vi.useFakeTimers()
  let mono = 0, cpu = 100
  const sampler = new ProcessResourceSampler(async () => `100 1 64 ${cpu}`, () => 1000, () => [], () => mono)
  sampler.trackRun('synthetic-run',100,'local')
  const seen: MetricsObservation[] = [],port=createResourceMetricsPort({sampler,currentWindow:()=>null})
  const subscription=await port.subscribe(value=>seen.push(parseMetricsObservation(value)),()=>{},new AbortController().signal)
  await flush();expect(seen.at(-1)?.process.data?.[0]?.cpuPercent).toBe(100)
  cpu=1
  // Two samples are fewer than the history cap: expiration must follow the real
  // monotonic interval, even while the wall-clock timestamp remains frozen.
  mono=11_001;await vi.advanceTimersByTimeAsync(1000);await flush()
  expect(seen.at(-1)?.process.data?.[0]?.cpuPercent).toBe(1)
  for(let i=0;i<25;i++){mono+=1000;await vi.advanceTimersByTimeAsync(1000);await flush()}
  expect(seen.at(-1)?.process.data?.[0]?.cpuPercent).toBe(1)
  const history=pruneSamples(Array.from({length:1000},()=>({observedAt:1000,cpuPercent:1,rssKib:64})),1000)
  expect(history).toHaveLength(11)
  expect(aggregateUsage([{observedAt:2000,cpuPercent:100,rssKib:64}],1000)).toEqual({cpuPercent:null,rssKib:null})
  subscription.dispose();port.dispose();sampler.dispose()
})
