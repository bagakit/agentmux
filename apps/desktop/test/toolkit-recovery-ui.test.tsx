// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { usePerformanceObservation } from '../src/renderer/src/lib/use-performance-observation.js'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics.js'
import type { ToolkitDesktopApi, ToolkitMetricsSnapshot } from '../src/shared/toolkit.js'
const roots: (() => void)[] = []
afterEach(() => { for (const close of roots.splice(0).reverse()) act(close) })
function renderHook<T>(render: () => T) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element), result = {} as { current: T }
  function Reader() { result.current = render(); return null }
  act(() => root.render(<Reader />))
  let closed = false
  const unmount = () => { if (!closed) { closed = true; act(() => root.unmount()); element.remove() } }
  roots.push(unmount)
  return { result, unmount }
}

function unknown(id = 'original-unknown'): ToolkitMetricsSnapshot {
  return { ...deepMetricsSnapshot(), state: 'unknown', executionId: id, run: null, reason: 'Original creation unconfirmed.',
    observation: null, document: null, observedAt: null, sequence: 0, trend: [] }
}
function fixture() {
  let publish!: (value: ToolkitMetricsSnapshot) => void
  const dispose = vi.fn(), run = vi.fn<ToolkitDesktopApi['run']>()
  const api = { run, observe: vi.fn<ToolkitDesktopApi['observe']>((_id, callback) => {
    publish = callback; callback(unknown()); return { dispose }
  }) }
  const hook = renderHook(() => usePerformanceObservation(api, true))
  return { ...hook, api, run, dispose, publish: (value: ToolkitMetricsSnapshot) => publish(value) }
}

it('opening does not retry; explicit double press admits one fresh identity and retries retain that identity', async () => {
  const f = fixture()
  expect(f.run).not.toHaveBeenCalled()
  let reject!: (reason: Error) => void
  f.run.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
  let pending!: Promise<void>
  act(() => { pending = f.result.current.startNewObservation(); void f.result.current.startNewObservation() })
  expect(f.run).toHaveBeenCalledOnce()
  const input = f.run.mock.calls[0]![1]!
  expect(input).toMatchObject({ expectedExecutionId: 'original-unknown' })
  expect(input.invocationId).not.toBe('original-unknown')
  await act(async () => { reject(new Error('Original reply unknown.')); await pending })
  expect(f.result.current.error).toBe('Original reply unknown.')
  f.run.mockResolvedValueOnce({ ...unknown(input.invocationId), state: 'observing', run: { hostId: 'local', runId: 'new-run' }, reason: null })
  await act(async () => { await f.result.current.startNewObservation() })
  expect(f.run.mock.calls[1]![1]).toEqual(input)
  expect(f.result.current.snapshot).toMatchObject({ executionId: input.invocationId, state: 'observing', run: { runId: 'new-run' } })
  expect(f.result.current.error).toBeNull()
  f.unmount(); expect(f.dispose).toHaveBeenCalledOnce()
})

it('a late recovery reply cannot replace a later execution received by the original observer', async () => {
  const f = fixture()
  let resolve!: (value: ToolkitMetricsSnapshot) => void
  f.run.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
  let pending!: Promise<void>
  act(() => { pending = f.result.current.startNewObservation() })
  const input = f.run.mock.calls[0]![1]!
  act(() => f.publish(unknown('later-execution')))
  await act(async () => { resolve(unknown(input.invocationId)); await pending })
  expect(f.result.current.snapshot?.executionId).toBe('later-execution')
  expect(f.run).toHaveBeenCalledOnce()
})

it('a known original Run keeps its existing reconciliation path', async () => {
  const f = fixture()
  act(() => f.publish({ ...unknown(), run: { hostId: 'local', runId: 'original-run' } }))
  await act(async () => { await f.result.current.startNewObservation() })
  expect(f.run).not.toHaveBeenCalled()
})

it.each(['reply', 'failure'] as const)('the original stream stays authoritative over a late same-execution recovery %s', async kind => {
  const f = fixture()
  let resolve!: (value: ToolkitMetricsSnapshot) => void, reject!: (error: Error) => void
  f.run.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no }))
  let pending!: Promise<void>
  act(() => { pending = f.result.current.startNewObservation() })
  const input = f.run.mock.calls[0]![1]!
  const newer = { ...unknown(input.invocationId), sequence: 2, reason: 'New original stream facts.' }
  act(() => f.publish(newer))
  await act(async () => {
    if (kind === 'reply') resolve({ ...unknown(input.invocationId), state: 'observing' })
    else reject(new Error('Earlier recovery reply lost.'))
    await pending
  })
  expect(f.result.current.snapshot).toEqual(newer)
  expect(f.result.current.error).toBeNull()
})
