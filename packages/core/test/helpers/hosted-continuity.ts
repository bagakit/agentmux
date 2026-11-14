import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../../src/agent-session-recovery/continuity-contract.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import { AgentMuxRpcService } from '../../src/public-rpc-service.js'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentMuxAgentSessionRegistry } from '../../src/agent-session-registry.js'
import type { AgentMuxHostedForwardRpc, AgentMuxHostedRpcPort } from '../../src/hosted-client-contract.js'
import type { AgentMuxHostedSessionProjection } from '../../src/hosted-session-summary.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'

export function continuitySession(id = 'continuity-original', operations = 12): AgentMuxStoredAgentSession {
  const run = { runId: 'run-' + id }
  const ledger = Object.fromEntries(Array.from({ length: operations }, (_, index) => {
    const operationId = id + '-operation-' + index
    return [operationId, { operationId, agentSessionId: id, trigger: 'manual' as const,
      policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: run, admittedAt: index + 1, observedAt: index + 2, rechecks: 0,
      kind: index === operations - 1 ? 'pending' as const : 'reattachable' as const, reason: 'controlled-original',
      evidence: { kind: 'run-running' as const, observedAt: index + 2 },
      recoveryInputs: { reminder: 'Controlled original reminder '.repeat(64), continuation: 'Controlled original continuation '.repeat(32) } }]
  }))
  return { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'controlled', hostId: 'local', workspacePath: 'controlled',
    run, retiredRuns: [], createdAt: 1, updatedAt: 2, hookBindingId: 'controlled-binding-' + id, hookToken: 'controlled-token-' + id,
    continuity: ledger[id + '-operation-' + (operations - 1)]!, continuityOperations: ledger,
    promptCompletionAdmission: { submissionId: id + '-submission', operationId: id + '-submission', transport: 'native',
      native: { plan: { kind: 'native-rpc', protocolId: 'controlled', sourceId: 'source', actorId: 'actor', threadId: 'thread', operation: 'start-or-steer' }, outcome: 'unknown' },
      intent: { run, ownerInstanceId: 'original-owner', prompt: 'Controlled original prompt', execution: 'immediate',
        plan: { kind: 'native-rpc', protocolId: 'controlled', sourceId: 'source', actorId: 'actor', threadId: 'thread', operation: 'start-or-steer' },
        message: { userContent: 'Controlled original prompt', authorHuman: true } } } }
}

/** Only transport and the unavailable Runtime are controlled; Core, SQLite Store,
 * Hosted codec/dispatch/SDK and the public inspection service remain production owners. */
export async function hostedContinuityFixture(sessions = [continuitySession()]) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-hosted-continuity-'))
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const core = new AgentMuxClient({ store, providers: [] })
  const inner = core as unknown as { registry: AgentMuxAgentSessionRegistry; publishSession(session: AgentMuxStoredAgentSession): void }
  try {
    for (const session of sessions) await inner.registry.put(session)
    vi.spyOn(core, 'connectRuntime').mockResolvedValue()
    vi.spyOn(core, 'listRuns').mockResolvedValue([])
    vi.spyOn(core, 'runtimeProjection').mockResolvedValue({ hostId: 'local', subjects: [] })
    vi.spyOn(core, 'statusAgent').mockRejectedValue(new AgentMuxError('Controlled fixture has no Runtime observation', 'CONTROL_UNAVAILABLE'))
    const ensure = vi.spyOn(core, 'ensureAgentContinuity')
    const owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2 as const,
      processId: 123, availability: 'connected' as const, ctxmux: null }
    const service = new AgentMuxHostedRuntimeService(core, store.path, () => owner)
    const rpc = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: core }], hostedRuntime: () => service,
      spatialState: new AgentMuxSpatialStateStore(join(directory, 'spatial.json')) })
    const calls: string[] = []
    const port: AgentMuxHostedRpcPort = {
      call: async (method, params, context) => { calls.push(method === 'runtime.invoke' ? 'runtime.invoke:' + (params as { invocation: { method: string } }).invocation.method : method); return await service.call(method, structuredClone(params), context) as never },
      subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: unknown): void }) => {
        calls.push(method)
        const read = await service.subscribe(method, structuredClone(params), event => handlers.onEvent(structuredClone(event)))
        handlers.onInitial(structuredClone(read.initial)); await read.start?.()
        return { dispose: () => read.dispose() }
      }
    }
    const forwardCalls: Array<{ method: string; params: unknown; context: unknown }> = []
    const forwardRpc: AgentMuxHostedForwardRpc = async (method, params, context) => {
      forwardCalls.push({ method, params: structuredClone(params), context })
      return await rpc.call(method, structuredClone(params), context)
    }
    const clients: Array<{ dispose(): Promise<void> }> = []
    return { core, store, inner, service, rpc, port, calls, owner, ensure, forwardCalls,
      connect: async <P extends AgentMuxHostedSessionProjection>(projection: P) => {
        const client = await connectHostedAgentMux({ rpc: port, sessions: projection, forwardRpc }); clients.push(client); return client
      },
      update: async (session: AgentMuxStoredAgentSession) => { await inner.registry.put(session, session.run); inner.publishSession(session) },
      dispose: async () => { for (const client of clients) await client.dispose(); await rpc.dispose(); await service.dispose(); await core.dispose(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) { await core.dispose(); await rm(directory, { recursive: true, force: true }); throw error }
}
