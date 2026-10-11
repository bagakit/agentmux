import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { RendererMemoryInspector } from '../src/main/renderer-memory.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import { rpcControlRequest, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import { parseRendererMemoryResult } from '../../../packages/core/src/renderer-memory.js'

const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
const usage = { usedSize: 1024, totalSize: 4096, embedderHeapUsedSize: 100, backingStorageSize: 32768 }
function fixture() {
  let current: typeof target | null = { ...target }
  const state = { attached: false, devtools: false, destroyed: false }
  const debuggerClient = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => state.attached),
    attach: vi.fn(() => { state.attached = true }),
    detach: vi.fn(() => { state.attached = false; debuggerClient.emit('detach') }),
    sendCommand: vi.fn(async (_method: string): Promise<any> => ({ ...usage }))
  })
  const contents = Object.assign(new EventEmitter(), { debugger: debuggerClient,
    isDestroyed: () => state.destroyed, isDevToolsOpened: () => state.devtools })
  const inspector = new RendererMemoryInspector(contents as unknown as WebContents, () => current)
  return { inspector, state, debuggerClient, contents, setCurrent: (next: typeof current) => { current = next } }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('reads original bytes once, never enables runtime or GC, and releases its own debugger', async () => {
  const f = fixture(), result = await f.inspector.inspect({ target })
  expect(result).toMatchObject({ status: 'completed', target, usage, units: 'bytes', scope: 'renderer-v8-isolate',
    sourceVerified: { before: true, after: true }, cleanup: { detached: 'confirmed' }, issues: [] })
  expect(f.debuggerClient.sendCommand.mock.calls).toEqual([['Runtime.getHeapUsage']])
  expect(f.debuggerClient.detach).toHaveBeenCalledExactlyOnceWith()
  expect(f.contents.eventNames()).toEqual([])
  expect(f.debuggerClient.eventNames()).toEqual([])
})
it('keeps absent experimental fields unknown while preserving actual zero', async () => {
  const f = fixture()
  f.debuggerClient.sendCommand.mockResolvedValue({ usedSize: 0, totalSize: 2048, backingStorageSize: 0 })
  expect(await f.inspector.inspect({ target })).toMatchObject({ status: 'completed', usage: {
    usedSize: 0, totalSize: 2048, embedderHeapUsedSize: null, backingStorageSize: 0 } })
})
it.each(['pid', 'creationTime', 'windowId', 'webContentsId', 'generation'] as const)('refuses the wrong initial %s without touching the debugger', async field => {
  const f = fixture()
  await expect(f.inspector.inspect({ target: { ...target, [field]: target[field] + 1 } })).rejects.toMatchObject({ code: 'CONTROL_OWNER_LOST' })
  expect(f.debuggerClient.attach).not.toHaveBeenCalled()
  expect(f.debuggerClient.detach).not.toHaveBeenCalled()
})
it.each(['pid', 'creationTime', 'windowId', 'webContentsId', 'generation'] as const)('preserves the old result identity if %s changes during the read', async field => {
  const f = fixture()
  f.debuggerClient.sendCommand.mockImplementation(async () => { f.setCurrent({ ...target, [field]: target[field] + 1 }); return usage })
  expect(await f.inspector.inspect({ target })).toMatchObject({ status: 'unknown', target,
    sourceVerified: { before: true, after: false }, issues: [{ code: 'CONTROL_OWNER_LOST' }], cleanup: { detached: 'confirmed' } })
})
it.each(['devtools', 'debugger'])('keeps a pre-existing %s owner and refuses only this query', async owner => {
  const f = fixture(); f.state.attached = owner === 'debugger'; f.state.devtools = owner === 'devtools'
  await expect(f.inspector.inspect({ target })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.debuggerClient.attach).not.toHaveBeenCalled(); expect(f.debuggerClient.detach).not.toHaveBeenCalled()
  expect(f.debuggerClient.sendCommand).not.toHaveBeenCalled()
  expect(f.state.attached).toBe(owner === 'debugger'); expect(f.state.devtools).toBe(owner === 'devtools')
})
it('does not detach a later foreign owner and never applies a late reply', async () => {
  const f = fixture(); let resolve!: (v: unknown) => void
  f.debuggerClient.sendCommand.mockImplementation(() => new Promise(yes => { resolve = yes }))
  const pending = f.inspector.inspect({ target })
  f.debuggerClient.emit('detach'); f.state.attached = true
  const result = await pending, original = JSON.stringify(result)
  expect(result).toMatchObject({ status: 'unknown', usage: null, cleanup: { detached: 'owner-lost' } })
  resolve(usage); await Promise.resolve(); await Promise.resolve()
  expect(JSON.stringify(result)).toBe(original)
  expect(f.debuggerClient.detach).not.toHaveBeenCalled(); expect(f.state.attached).toBe(true)
})
it.each(['cancel', 'timeout', 'dispose'] as const)('bounds %s to this reader and ignores its late reply', async action => {
  vi.useFakeTimers()
  const f = fixture(), signal = new AbortController(); let resolve!: (v: unknown) => void
  f.debuggerClient.sendCommand.mockImplementation(() => new Promise(yes => { resolve = yes }))
  const pending = f.inspector.inspect({ target }, signal.signal)
  if (action === 'cancel') signal.abort()
  if (action === 'dispose') f.inspector.dispose()
  if (action === 'timeout') await vi.advanceTimersByTimeAsync(2000)
  const result = await pending, original = JSON.stringify(result)
  expect(result).toMatchObject({ status: 'unknown', usage: null, cleanup: { detached: 'confirmed' } })
  expect(result.issues[0]?.code).toBe(action === 'timeout' ? 'CONTROL_TIMEOUT' : action === 'dispose' ? 'CONTROL_OWNER_LOST' : 'CONTROL_CANCELLED')
  f.state.attached = true; resolve(usage); await vi.advanceTimersByTimeAsync(0)
  expect(JSON.stringify(result)).toBe(original)
  expect(f.debuggerClient.detach).toHaveBeenCalledOnce(); expect(f.state.attached).toBe(true)
  expect(f.contents.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
})
it('reports malformed native data as failure with cleanup, and detach uncertainty as unknown', async () => {
  const f = fixture(); f.debuggerClient.sendCommand.mockResolvedValue({ usedSize: -1, totalSize: 2048 })
  expect(await f.inspector.inspect({ target })).toMatchObject({ status: 'failed', usage: null,
    issues: [{ stage: 'decode', code: 'CONTROL_PROTOCOL_ERROR' }], cleanup: { detached: 'confirmed' } })
  f.debuggerClient.sendCommand.mockResolvedValue(usage)
  f.debuggerClient.detach.mockImplementation(() => { throw new Error('detach failed') })
  const result = await f.inspector.inspect({ target })
  expect(result).toMatchObject({ status: 'unknown', usage, cleanup: { detached: 'unconfirmed' } })
  expect(() => parseRendererMemoryResult({ ...result, status: 'completed' })).toThrow()
})
it('routes discovered CLI input through original metrics service and strict target-bound result validation', async () => {
  const f = fixture(), metrics = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, memory: f.inspector })
  const service = new AgentMuxRpcService({ coreClients: () => [], metrics })
  const invocation = await parseAgentMuxCliInvocation(['system', 'metrics', 'memory', 'inspect', '--window-id', '1', '--web-contents-id', '2', '--generation', '3', '--pid', '4', '--creation-time', '1000'])
  expect(invocation.command.method).toBe('system.metrics.memory.inspect')
  expect(rpcControlRequest('system.metrics.memory.inspect', invocation.params)).toMatchObject({ operation: 'metrics.memory.inspect', target })
  const result = await service.call('system.metrics.memory.inspect', invocation.params as never)
  expect(result).toMatchObject({ observation: { status: 'completed', target, usage } })
  expect(parseRpcControlResult('system.metrics.memory.inspect', result, invocation.params)).toEqual(result)
  expect(() => parseRpcControlResult('system.metrics.memory.inspect', result, { target: { ...target, pid: 99 } })).toThrow()
  metrics.dispose()
  await expect(metrics.inspectMemory!({ target })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(new AgentMuxRpcService({ coreClients: () => [] }).call('system.metrics.memory.inspect', { target })).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' })
})
