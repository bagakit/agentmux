import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { RendererMemoryInspector } from '../src/main/renderer-memory.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import { rpcControlRequest, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import { parseRendererWorkerMemoryResult, RENDERER_WORKER_MEMORY_LIMITS } from '../../../packages/core/src/renderer-worker-memory.js'

const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
const rootUsage = { usedSize: 1024, totalSize: 4096, embedderHeapUsedSize: 0, backingStorageSize: 0 }
const childUsage = { usedSize: 512, totalSize: 2048, embedderHeapUsedSize: 32, backingStorageSize: 32 * 1024 * 1024 }
type Child = { sessionId: string; targetId: string; isolateId: string; parent?: string; url?: unknown; title?: unknown; usage?: Record<string, unknown> }
const first: Child = { sessionId: 'one', targetId: 'target-one', isolateId: 'isolate-one', url: 'blob:private-source', title: 'original worker' }
function fixture(children: Child[] = [first]) {
  let current: typeof target | null = { ...target }
  const state = { attached: false, devtools: false, destroyed: false, healthyWorkers: children.length }
  const debuggerClient = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => state.attached),
    attach: vi.fn(() => { state.attached = true }),
    detach: vi.fn(() => { state.attached = false; debuggerClient.emit('detach') }),
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'root-target', type: 'page' } }
      if (method === 'Runtime.getIsolateId') return { id: sessionId ? children.find(row => row.sessionId === sessionId)?.isolateId : 'root-isolate' }
      if (method === 'Runtime.getHeapUsage') return sessionId ? { ...(children.find(row => row.sessionId === sessionId)?.usage ?? childUsage) } : { ...rootUsage }
      if (method === 'Target.setAutoAttach') {
        expect(params).toMatchObject({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
        for (const row of children.filter(row => row.parent === sessionId)) debuggerClient.emit('message', {}, 'Target.attachedToTarget', {
          sessionId: row.sessionId, waitingForDebugger: false, targetInfo: { targetId: row.targetId, type: 'worker', url: row.url, title: row.title } }, sessionId)
        return {}
      }
      throw Error('Unexpected native command')
    })
  })
  const contents = Object.assign(new EventEmitter(), { debugger: debuggerClient, isDestroyed: () => state.destroyed, isDevToolsOpened: () => state.devtools })
  const inspector = new RendererMemoryInspector(contents as unknown as WebContents, () => current)
  return { inspector, state, debuggerClient, contents, setCurrent: (next: typeof current) => { current = next } }
}
async function run(f: ReturnType<typeof fixture>) {
  const read = f.inspector.inspectWorkers({ target }); await vi.advanceTimersByTimeAsync(250); return read
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('measures the exact root/related child without foreign selection, pause, GC or totals and releases the same owner', async () => {
  vi.useFakeTimers(); const f = fixture(), result = await run(f)
  expect(result).toMatchObject({ status: 'completed', root: { isolateId: 'root-isolate', usage: rootUsage },
    discovery: { coverage: 'bounded', observed: 1, omitted: 0, pending: 0 }, sourceVerified: { before: true, after: true }, cleanup: { detached: 'confirmed' } })
  expect(result.isolates).toEqual([{ isolateId: first.isolateId, sessionId: first.sessionId, targetId: first.targetId, usage: childUsage, sampledAt: expect.any(Number) }])
  expect(result.relations[0]).toMatchObject({ parentSessionId: null, status: 'measured', process: null, target: { url: { state: 'present', value: first.url } } })
  expect(f.debuggerClient.sendCommand.mock.calls.filter(row => row[0] === 'Runtime.getHeapUsage')).toEqual([['Runtime.getHeapUsage', {}, undefined], ['Runtime.getHeapUsage', {}, first.sessionId]])
  expect(f.debuggerClient.sendCommand.mock.calls.every(([method]) => ['Target.getTargetInfo', 'Target.setAutoAttach', 'Runtime.getIsolateId', 'Runtime.getHeapUsage'].includes(method))).toBe(true)
  expect(result).not.toHaveProperty('total'); expect(result).not.toHaveProperty('totalBytes')
  expect(f.debuggerClient.detach).toHaveBeenCalledOnce(); expect(f.state.healthyWorkers).toBe(1)
  expect(f.contents.eventNames()).toEqual([]); expect(f.debuggerClient.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
})
it('recursively observes native nested session relations rather than selecting labels', async () => {
  vi.useFakeTimers(); const f = fixture([first, { sessionId: 'nested', targetId: 'nested-target', isolateId: 'nested-isolate', parent: 'one', title: 'foreign-looking label' }])
  const result = await run(f); expect(result.status).toBe('completed'); expect(result.isolates).toHaveLength(2)
  expect(result.relations.find(row => row.sessionId === 'nested')).toMatchObject({ parentSessionId: 'one', status: 'measured' })
})
it('preserves root aliases and duplicate related aliases while measuring each distinct worker isolate once', async () => {
  vi.useFakeTimers(); const f = fixture([first, { sessionId: 'same', targetId: 'another', isolateId: first.isolateId }, { sessionId: 'main', targetId: 'alias-main', isolateId: 'root-isolate' }])
  const result = await run(f); expect(result.status).toBe('completed'); expect(result.relations).toHaveLength(3); expect(result.isolates).toHaveLength(1)
  expect(result.relations.map(row => row.status)).toEqual(['measured', 'worker-alias', 'root-alias'])
  expect(f.debuggerClient.sendCommand.mock.calls.filter(row => row[0] === 'Runtime.getHeapUsage')).toHaveLength(2)
})
it('does not describe an empty bounded observation as exhaustive discovery', async () => {
  vi.useFakeTimers(); const result = await run(fixture([])); expect(result).toMatchObject({ status: 'completed', relations: [], isolates: [], discovery: { coverage: 'bounded', observed: 0, scope: 'root-and-nested-dedicated-workers' } })
})
it('keeps true zero and missing experimental values distinct', async () => {
  vi.useFakeTimers(); const result = await run(fixture([{ ...first, usage: { usedSize: 0, totalSize: 1024, backingStorageSize: 0 } }]))
  expect(result.isolates[0]!.usage).toEqual({ usedSize: 0, totalSize: 1024, embedderHeapUsedSize: null, backingStorageSize: 0 })
})
it('keeps successful worker facts when a sibling native identity is malformed', async () => {
  vi.useFakeTimers(); const result = await run(fixture([first, { sessionId: 'bad', targetId: 'bad-target', isolateId: '' }]))
  expect(result).toMatchObject({ status: 'partial', discovery: { coverage: 'partial' } }); expect(result.isolates).toHaveLength(1)
  expect(result.relations.find(row => row.sessionId === 'bad')).toMatchObject({ status: 'failed', isolateId: null })
})
it('retains numeric facts while source metadata is absent, empty, truncated or transport-omitted', async () => {
  vi.useFakeTimers(); const children = Array.from({ length: 6 }, (_, i) => ({ sessionId: `s${i}`, targetId: `t${i}`, isolateId: `i${i}`, url: 'x'.repeat(4096), title: i === 0 ? '' : undefined }))
  const result = await run(fixture(children)); expect(result.status).toBe('partial'); expect(result.isolates).toHaveLength(6)
  expect(result.relations[0]!.target.title).toEqual({ state: 'present', value: '', originalLength: 0 })
  expect(result.relations[1]!.target.title).toEqual({ state: 'absent', value: null, originalLength: null })
  expect(result.relations[0]!.target.url).toMatchObject({ state: 'truncated', originalLength: 4096 })
  expect(result.relations[5]!.target.url).toMatchObject({ state: 'omitted', value: null, originalLength: 4096 })
})
it('bounds only this observation while keeping actual healthy worker capacity independent', async () => {
  vi.useFakeTimers(); const children = Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, targetId: `t${i}`, isolateId: `i${i}` })); const f = fixture(children), result = await run(f)
  expect(result.status).toBe('partial'); expect(result.relations).toHaveLength(RENDERER_WORKER_MEMORY_LIMITS.relations); expect(result.discovery.omitted).toBe(4)
  expect(f.state.healthyWorkers).toBe(20)
})
it('refuses a forged unrelated parent session instead of selecting its target name', async () => {
  vi.useFakeTimers(); const f = fixture(); const send = f.debuggerClient.sendCommand.getMockImplementation()!
  f.debuggerClient.sendCommand.mockImplementation(async (...args) => { const value = await send(...args); if (args[0] === 'Target.setAutoAttach' && !args[2]) f.debuggerClient.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'foreign', waitingForDebugger: false, targetInfo: { type: 'worker', targetId: 'f' } }, 'unknown-parent'); return value })
  const result = await run(f); expect(result.status).toBe('partial'); expect(result.relations.map(row => row.sessionId)).toEqual(['one'])
})
it('reports a known child ending as partial without discarding its earlier numeric sample', async () => {
  vi.useFakeTimers(); const f = fixture(); const read = f.inspector.inspectWorkers({ target }); await vi.advanceTimersByTimeAsync(20)
  f.debuggerClient.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'one' }); await vi.advanceTimersByTimeAsync(250)
  const result = await read; expect(result.status).toBe('partial'); expect(result.isolates).toHaveLength(1); expect(result.relations[0]!.endedAt).not.toBeNull()
})
it.each(['devtools', 'attached'])('preserves the existing %s debugger and refuses only the exact query', async kind => {
  const f = fixture(); if (kind === 'devtools') f.state.devtools = true; else f.state.attached = true
  await expect(f.inspector.inspectWorkers({ target })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' }); expect(f.debuggerClient.attach).not.toHaveBeenCalled(); expect(f.debuggerClient.detach).not.toHaveBeenCalled()
})
it.each(['pid', 'creationTime', 'windowId', 'webContentsId', 'generation'] as const)('keeps the root source fence for %s replacement', async key => {
  vi.useFakeTimers(); const f = fixture(); const pending = f.inspector.inspectWorkers({ target }); await vi.advanceTimersByTimeAsync(10)
  f.setCurrent({ ...target, [key]: target[key] + 1 }); f.contents.emit('did-start-navigation'); await vi.advanceTimersByTimeAsync(250)
  const result = await pending; expect(result).toMatchObject({ status: 'unknown', target, sourceVerified: { before: true, after: false }, cleanup: { detached: 'confirmed' } })
})
it('shares the active owner with default v1 reads, then returns default v1 unchanged after cleanup', async () => {
  vi.useFakeTimers(); const f = fixture(), pending = f.inspector.inspectWorkers({ target })
  await expect(f.inspector.inspect({ target })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await vi.advanceTimersByTimeAsync(250); await pending
  expect(await f.inspector.inspect({ target })).toMatchObject({ schema: 'agentmux.renderer-memory.v1', usage: rootUsage })
})
it('cancellation releases only the original owner, ignores late replies and never detaches a later foreign owner', async () => {
  vi.useFakeTimers(); const f = fixture(); const send = f.debuggerClient.sendCommand.getMockImplementation()!; let finish!: (v: Record<string, unknown>) => void
  f.debuggerClient.sendCommand.mockImplementation((...args) => args[0] === 'Runtime.getHeapUsage' && args[2] === 'one' ? new Promise(resolve => { finish = resolve }) : send(...args))
  const read = f.inspector.inspectWorkers({ target }); await vi.advanceTimersByTimeAsync(10); f.debuggerClient.emit('detach'); f.state.attached = true
  await vi.advanceTimersByTimeAsync(250); const result = await read, before = JSON.stringify(result); expect(result.status).toBe('unknown'); expect(result.cleanup.detached).toBe('owner-lost')
  finish(childUsage); await Promise.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(JSON.stringify(result)).toBe(before); expect(f.debuggerClient.detach).not.toHaveBeenCalled(); expect(f.state.attached).toBe(true)
})
it('an unsettled child at the native deadline stays unknown and cannot mutate a returned result', async () => {
  vi.useFakeTimers(); const f = fixture(); const send = f.debuggerClient.sendCommand.getMockImplementation()!; let finish!: (v: Record<string, unknown>) => void
  f.debuggerClient.sendCommand.mockImplementation((...args) => args[0] === 'Runtime.getHeapUsage' && args[2] ? new Promise(resolve => { finish = resolve }) : send(...args))
  const read = f.inspector.inspectWorkers({ target }); await vi.advanceTimersByTimeAsync(2100); const result = await read, original = JSON.stringify(result)
  expect(result.status).toBe('unknown'); expect(result.root?.usage).toEqual(rootUsage); finish(childUsage); await vi.advanceTimersByTimeAsync(0); expect(JSON.stringify(result)).toBe(original)
})
it('reports unconfirmed detach as unknown while retaining the measurements', async () => {
  vi.useFakeTimers(); const f = fixture(); f.debuggerClient.detach.mockImplementation(() => {})
  const result = await run(f); expect(result).toMatchObject({ status: 'unknown', cleanup: { detached: 'unconfirmed' } }); expect(result.isolates).toHaveLength(1)
})
it('uses actual CLI parameters, original metrics port and portable service codec for worker reads', async () => {
  vi.useFakeTimers(); const f = fixture(), metrics = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, memory: f.inspector })
  const service = new AgentMuxRpcService({ coreClients: () => [], metrics })
  const invocation = await parseAgentMuxCliInvocation(['system', 'metrics', 'memory', 'workers', 'inspect', '--window-id', '1', '--web-contents-id', '2', '--generation', '3', '--pid', '4', '--creation-time', '1000'])
  const method = invocation.command.method
  expect(method).toBe('system.metrics.memory.workers.inspect')
  if (method !== 'system.metrics.memory.workers.inspect') throw Error('CLI did not select the original Worker memory method')
  const request = rpcControlRequest(method, invocation.params); expect(request).toMatchObject({ operation: 'metrics.memory.workers.inspect', target })
  const pending = service.call(method, invocation.params as never); await vi.advanceTimersByTimeAsync(250); const raw = await pending
  const parsed = parseRpcControlResult(method, raw, invocation.params); expect(parsed).toHaveProperty('observation.isolates.0.usage.backingStorageSize', childUsage.backingStorageSize)
  metrics.dispose(); await service.dispose()
})
it('strictly rejects wrong target, fabricated totals and malformed alias/coverage claims', async () => {
  vi.useFakeTimers(); const good = await run(fixture([first, { sessionId: 'same', targetId: 'other', isolateId: first.isolateId }]))
  expect(() => parseRendererWorkerMemoryResult({ ...good, totalBytes: 1 }, { target })).toThrow()
  expect(() => parseRendererWorkerMemoryResult({ ...good, target: { ...target, pid: 20 } }, { target })).toThrow()
  const forged = structuredClone(good); forged.relations[1]!.isolateId = 'not-observed'; expect(() => parseRendererWorkerMemoryResult(forged)).toThrow()
  const coverage = structuredClone(good); coverage.discovery.pending = 1; expect(() => parseRendererWorkerMemoryResult(coverage)).toThrow()
})
