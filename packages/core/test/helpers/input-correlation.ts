import { fixturePath } from './fixture-values.js'
import { vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import type { AgentMuxHostedRpcPort } from '../../src/hosted-client-contract.js'
import type { AgentMuxRunInputOperation } from '../../src/types.js'
import { hostedTestOwner, hostedTestFence } from './hosted-runtime-port.js'
export const correlationParent = (source: 'user' | 'protocol' | 'paste' = 'user', sequence = 1) => ({
  observerId: '11111111-1111-4111-8111-111111111111', source, sequence })
export const flushInput = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
export function inputDeferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
/** Actual SDK, Hosted service/client and value codec; only native I/O and transport ports are controlled. */
export async function inputCorrelationCore() {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'private-agent', providerId: 'codex', executorId: 'private',
    hostId: 'local', workspacePath: fixturePath("private/fixture"), run: { runId: 'original' }, retiredRuns: [],
    hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token', createdAt: 1, updatedAt: 1 })
  const core = new AgentMuxClient({ store }), inner = core as any
  await inner.registry.load('local'); inner.connected = true
  const gates = { connect: null as ReturnType<typeof inputDeferred> | null, status: null as ReturnType<typeof inputDeferred> | null,
    native: null as ReturnType<typeof inputDeferred> | null }
  let acceptedInputBytes = 0, daemon = 'controlled-daemon'
  const originalError = new Error('controlled original native failure')
  const run = () => ({ nativeService: null, runId: 'original', lifecycleOperationId: null, program: fixturePath("private/worker"), args: [],
    workspacePath: fixturePath("private/fixture"), pid: 421, state: { type: 'running' as const }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes })
  const input = vi.fn(async (_runId: string, operation: AgentMuxRunInputOperation) => {
    if (gates.native) await gates.native.promise
    if (operation.data === 'failure') throw originalError
    if (operation.expectedByte !== acceptedInputBytes) throw new Error('original input cursor changed')
    const startByte = acceptedInputBytes
    acceptedInputBytes += typeof operation.data === 'string' ? Buffer.byteLength(operation.data) : operation.data.byteLength
    return { run: run(), appliedByteRange: { startByte, endByte: acceptedInputBytes } }
  })
  Object.assign(inner.kernel, { isConnected: () => true,
    identity: () => ({ daemonInstanceId: daemon, protocolVersion: 22, buildIdentity: 'controlled-build' }),
    status: async () => { if (gates.status) await gates.status.promise; return run() }, list: async () => { if (gates.status) await gates.status.promise; return [run()] }, input })
  vi.spyOn(core, 'connect').mockResolvedValue()
  vi.spyOn(core, 'connectRuntime').mockImplementation(async () => { if (gates.connect) await gates.connect.promise })
  const service = new AgentMuxHostedRuntimeService(core, null, () => hostedTestOwner(core))
  const calls: Array<{ method: string; params: unknown }> = []
  const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
  const port = {
    call: async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
      calls.push({ method, params: json(params) }); return json(await service.call(method, json(params), options))
    },
    subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: unknown): void; signal?: AbortSignal }) => {
      const stream = await service.subscribe(method, params, event => handlers.onEvent(json(event)), handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(json(stream.initial)); await stream.start?.(); return { dispose: async () => await stream.dispose() }
    }
  } as unknown as AgentMuxHostedRpcPort
  const hosted = await connectHostedAgentMux({ rpc: port })
  return { core, hosted, service, store, calls, gates, input, originalError, run, changeDaemon: (id: string) => { daemon = id },
    rawInvoke: (method: string, args: unknown[]) => service.call('runtime.invoke', { fence: hostedTestFence, consumerId: 'raw-diagnostic-consumer', invocation: { method, args } }),
    dispose: async () => { gates.connect?.resolve(); gates.status?.resolve(); gates.native?.resolve(); await hosted.dispose(); await service.dispose(); await core.dispose() } }
}
