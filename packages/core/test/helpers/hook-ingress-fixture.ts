import { fixturePath } from './fixture-values.js'
import { vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../../src/agent-session-registry.js'
import { AgentHookServer } from '../../src/hook-server.js'
import type { CtxmuxAdapterRun } from '../../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../../src/types.js'

/** Controlled native observations; actual semantic Core and authenticated Hook server remain real. */
export function hookSession(id: string, runId = id): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: fixturePath("private"),
    run: { runId }, retiredRuns: [], hookBindingId: id.slice(0, 1).repeat(43), hookToken: id.slice(-1).repeat(43), createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: `native-${id}` } }
}
export function hookRun(session: AgentMuxStoredAgentSession, running = true): CtxmuxAdapterRun {
  return { nativeService: null, runId: session.run.runId, lifecycleOperationId: null, program: 'codex', args: [],
    workspacePath: session.workspacePath, pid: 123, state: running ? { type: 'running' } : { type: 'exited', code: 0, signal: null },
    cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
}
export type HookFixtureInternals = {
  connected: boolean; registry: AgentMuxAgentSessionRegistry; hookServer: AgentHookServer
  hookBindings: Map<string, unknown>; hookRestorations: Map<string, Promise<void>>
  kernel: { isConnected(): boolean; identity(): unknown; status(id: string): Promise<CtxmuxAdapterRun>; list(): Promise<CtxmuxAdapterRun[]> }
  backfillEndedRuns(runs: readonly CtxmuxAdapterRun[]): void
  acceptKernelEvent(event: import('../../src/ctxmux-run-adapter.js').CtxmuxAdapterEvent): void
  persistActivityBoundary(): Promise<void>
  ensureNativeStatusObservation(): Promise<void>
  tryRestoreHookIngress(runs: readonly CtxmuxAdapterRun[]): Promise<void>
}
export async function hookClientFixture(records: AgentMuxStoredAgentSession[]) {
  const store = new AgentMuxMemoryAgentSessionStore()
  for (const record of records) await store.compareAndSwap(null, record)
  const client = new AgentMuxClient({ store })

  const inner = client as unknown as HookFixtureInternals
  inner.hookServer = new AgentHookServer(() => {}, 0)
  await inner.registry.load('local')
  inner.connected = true; inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-daemon', buildIdentity: 'private', protocolVersion: 18 })
  let runs = records.map(record => hookRun(record))
  inner.kernel.list = async () => runs
  inner.kernel.status = async id => { const value = runs.find(value => value.runId === id); if (!value) throw new Error('private Run unavailable'); return value }
  vi.spyOn(inner, 'ensureNativeStatusObservation').mockResolvedValue()
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  return { client, inner, store, events, replaceRuns: (value: CtxmuxAdapterRun[]) => { runs = value } }
}

