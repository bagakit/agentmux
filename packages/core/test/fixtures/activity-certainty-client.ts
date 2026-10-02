import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentProviderId, NativeHookEnvelope } from '../../src/types.js'

/** Real durable/public Client boundary; the isolated Run transport never contacts a Runtime. */
export async function activityCertaintyClient(id: string, providerId: AgentProviderId = 'codex', options: {
  workspacePath?: string; semanticStatus?: AgentMuxStoredAgentSession['semanticStatus']
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-activity-certainty-'))
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'agent-sessions.json'))
  const runId = `certainty-run-${id}`
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId, executorId: providerId,
    hostId: 'local', workspacePath: options.workspacePath ?? directory, run: { runId }, retiredRuns: [],
    hookBindingId: `certainty-binding-${id}`, hookToken: 'isolated-proof-token', createdAt: 1,
    updatedAt: options.semanticStatus?.observedAt ?? 1,
    ...(options.semanticStatus ? { semanticStatus: options.semanticStatus } : {}) })
  const client = new AgentMuxClient({ store })
  const inner = client as unknown as { connected: boolean; registry: AgentMuxAgentSessionRegistry;
    kernel: { isConnected(): boolean; status(runId: string): Promise<CtxmuxAdapterRun> };
    acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void> }
  await inner.registry.load('local')
  const requests: string[] = []
  const run: CtxmuxAdapterRun = { nativeService: null, runId, lifecycleOperationId: null,
    program: providerId, args: [], workspacePath: options.workspacePath ?? directory, pid: null, state: { type: 'running' },
    cols: 80, rows: 24, latestOutputBytes: 17, firstAvailableByte: 0, acceptedInputBytes: 11 }
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.status = async requested => { requests.push(requested); return run }
  const hook = (eventName: string, receiptId: string, payload: Record<string, unknown> = {}, hookRunId = runId) =>
    inner.acceptHookEvent({ agentSessionId: id, providerId, runId: hookRunId, receiptId,
      eventName, payload: { hook_event_name: eventName, ...payload } }, AbortSignal.timeout(5_000))
  return { directory, store, client, run, requests, hook, sessions: () => loadAgentSessions(store),
    close: async () => { await client.dispose(); await rm(directory, { recursive: true, force: true }) } }
}
