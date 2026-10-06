import { fixtureEpoch as reshapeFixtureEpoch } from './fixture-values.js'
import { fixturePath } from './fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxClient as SourceClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore as SourceStore } from '../../src/agent-session-store.js'
const ownerEntry = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
  ? await import(process.env.AGENTMUX_TEST_RPC_CORE_ENTRY) : null
const AgentMuxClient: typeof SourceClient = ownerEntry ? ownerEntry.AgentMuxClient : SourceClient
// One actual package owner: mixing src Store errors with dist Client classes
// bypasses that package's same-owner stale CAS retry and invalidates the probe.
const AgentMuxFileAgentSessionStore: typeof SourceStore = ownerEntry ? ownerEntry.AgentMuxFileAgentSessionStore : SourceStore
import { issueAgentCapability, hashAgentCapability } from '../../src/agent-capability.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'
import type { CtxmuxAdapterObservationEvent, CtxmuxAdapterRun } from '../../src/ctxmux-run-adapter.js'

/** Real Core registry, authorization and journal; Runtime byte I/O is a deterministic port. */
export async function rpcOwnerFixture(ids = ['caller', 'recipient'], ownerModule?: {
  AgentMuxClient: typeof SourceClient; AgentMuxFileAgentSessionStore: typeof SourceStore
}) {
  const Client = ownerModule?.AgentMuxClient ?? AgentMuxClient
  const Store = ownerModule?.AgentMuxFileAgentSessionStore ?? AgentMuxFileAgentSessionStore
  const root = await mkdtemp(fixturePath("tmp/amx-rpc-owner-")), store = new Store(join(root, 'sessions.json'))
  const capability = issueAgentCapability()
  for (const [key] of Object.entries(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  for (const agentSessionId of ids) {
    const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: root, run: { runId: 'run-' + agentSessionId }, retiredRuns: [],
      hookBindingId: 'fixture-hook', hookToken: 'fixture-token', capabilityHash: hashAgentCapability(capability), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1) }
    await store.compareAndSwap(null, record)
  }
  const client = new Client({ store })
  const inner = client as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown> }
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  const cursors = new Map<string, number>()
  const writes = new Map<string, { data: string; startByte: number; endByte: number }>()
  const run = (runId: string): CtxmuxAdapterRun => ({ runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: root,
    pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 3, firstAvailableByte: 0, acceptedInputBytes: cursors.get(runId) ?? 0, nativeService: null })
  inner.kernel.status = vi.fn(async (id: string) => run(id))
  inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-runtime', protocolVersion: 1, buildIdentity: 'fixture' })
  inner.kernel.input = vi.fn(async (id: string, input: { operationId: string; expectedByte: number; data: string }) => {
    const key = JSON.stringify([id, input.operationId]), previous = writes.get(key)
    if (previous) {
      if (input.data !== previous.data || input.expectedByte !== previous.startByte) throw new Error('Fixture operation differs from its original byte claim')
      return { run: run(id), appliedByteRange: { startByte: previous.startByte, endByte: previous.endByte } }
    }
    const startByte = cursors.get(id) ?? 0
    if (input.expectedByte !== startByte) throw new Error('Fixture input cursor differs from its original ordered byte claim')
    const endByte = startByte + Buffer.byteLength(input.data)
    writes.set(key, { data: input.data, startByte, endByte }); cursors.set(id, endByte)
    return { run: run(id), appliedByteRange: { startByte, endByte } }
  })
  const observers = new Set<(event: CtxmuxAdapterObservationEvent) => void>(), closes = vi.fn()
  inner.kernel.observeOutput = vi.fn(async (id: string, _after: number, listener: (event: CtxmuxAdapterObservationEvent) => void) => {
    observers.add(listener)
    return { run: run(id), gap: null, terminal: { type: 'not-requested' as const }, resizeRevision: 7, replay: [
      { type: 'data', runId: id, startByte: 0, endByte: 1, data: '', dataBytes: Uint8Array.from([0xe4]) },
      { type: 'data', runId: id, startByte: 0, endByte: 2, data: '', dataBytes: Uint8Array.from([0xe4, 0xb8]) }
    ], close: async () => { observers.delete(listener); closes() } }
  })
  inner.kernel.attach = vi.fn(); inner.kernel.detach = vi.fn(); inner.kernel.stop = vi.fn()
  return { root, store, client, inner, run, observers, closes, capability,
    coreClients: () => [{ hostId: 'local', client }],
    credentials: { agentSessionId: ids[0]!, capability },
    close: async () => { await client.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) } }
}
