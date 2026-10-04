import { afterEach, expect, it, vi } from 'vitest'
import { MainPerformanceDiagnostics } from '../src/main/performance-diagnostics.js'
import { createInputPerformanceRecorder, hostedCarrierPerformance } from '@agentmux/core'
const main = () => ({ processId: 100, observedAt: Date.now(), input: createInputPerformanceRecorder().snapshot(), carrier: hostedCarrierPerformance.snapshot() })
const storage = { location: 'main-user-home-volume' as const, availableBytes: 17, totalBytes: 100 }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it('keeps fresh Main and volume facts when a host never answers, preserves single-flight until actual settlement, and re-reads later', async () => {
  vi.useFakeTimers()
  let resolve!: (value: ReturnType<typeof main>) => void
  const stalled = new Promise<ReturnType<typeof main>>(done => { resolve = done })
  const reactions = vi.spyOn(stalled, 'then')
  let calls = 0, lastSignal!: AbortSignal, fresh = false
  const source = (options: { signal: AbortSignal }) => { calls++; lastSignal = options.signal; return fresh ? Promise.resolve(main()) : stalled }
  const readStorage = vi.fn(async () => storage), observer = new MainPerformanceDiagnostics(readStorage)
  const entries = [{ client: { clientPerformanceDiagnostics: source }, executionHost: { id: 'never-host' } }]
  const signal = new AbortController().signal
  const first = observer.observe(entries, main, signal)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await first).toMatchObject({ main: { processId: 100 }, storage, storageUnavailable: null,
    hosts: [{ hostId: 'never-host', data: null, unavailable: expect.stringContaining('timed out') }] })
  expect(lastSignal.aborted).toBe(true)
  const again = observer.observe(entries, main, signal)
  await vi.advanceTimersByTimeAsync(1000); await again
  expect(calls).toBe(1)
  for (let i = 0; i < 100; i++) await observer.observe(entries, main, signal)
  expect(reactions).toHaveBeenCalledTimes(1)
  resolve(main()); await Promise.resolve(); await Promise.resolve()
  fresh = true
  expect((await observer.observe(entries, main, signal)).hosts[0]!.data?.processId).toBe(100)
  expect(calls).toBe(2)
})
it('does not let a stalled volume erase healthy host or local facts or duplicate filesystem reads', async () => {
  vi.useFakeTimers()
  const stalled = new Promise<typeof storage>(() => {}), reactions = vi.spyOn(stalled, 'then')
  let calls = 0
  const readStorage = () => { calls++; return stalled }
  const observer = new MainPerformanceDiagnostics(readStorage)
  const source = vi.fn(async () => main()), entries = [{ client: { clientPerformanceDiagnostics: source }, executionHost: { id: 'healthy-host' } }]
  const signal = new AbortController().signal
  for (let i = 0; i < 2; i++) {
    const value = observer.observe(entries, main, signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await value).toMatchObject({ main: { processId: 100 }, hosts: [{ data: { processId: 100 }, unavailable: null }],
      storage: null, storageUnavailable: expect.stringContaining('timed out') })
  }
  expect(calls).toBe(1)
  for (let i = 0; i < 100; i++) await observer.observe(entries, main, signal)
  expect(reactions).toHaveBeenCalledTimes(1)
})
it('bounds host inventory and cancellation releases only observation with no late projection or new read', async () => {
  vi.useFakeTimers()
  const source = vi.fn((_options: { signal: AbortSignal }) => new Promise<ReturnType<typeof main>>(() => {}))
  const client = { clientPerformanceDiagnostics: source }
  const entries = Array.from({ length: 100 }, (_, i) => ({ client, executionHost: { id: `host-${i}` } }))
  const observer = new MainPerformanceDiagnostics(async () => storage), controller = new AbortController()
  const value = observer.observe(entries, main, controller.signal)
  const rejected = expect(value).rejects.toThrow('released observation')
  controller.abort(new Error('released observation'))
  await rejected
  expect(source).toHaveBeenCalledTimes(1)
  expect(source.mock.calls[0]![0].signal.aborted).toBe(true)
  const next = observer.observe(entries, main, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await next).toMatchObject({ hosts: expect.any(Array), omittedHosts: 36 })
  expect((await next).hosts).toHaveLength(64)
  expect(source).toHaveBeenCalledTimes(1)
})
