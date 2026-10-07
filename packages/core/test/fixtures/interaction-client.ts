import { fixtureEpoch as _newTailFixtureEpoch } from "../../../../test/fixture-values.mjs"
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../src/agent-session-store.js'
import type { AgentMuxInteractionRequest, AgentMuxInteractionResponse, AgentMuxStoredAgentSession } from '../../src/types.js'
export const RUN_ID = 'lifecycle-run'
export const AGENT_SESSION_ID = 'lifecycle-agent'

export function storedSession(pending?: AgentMuxInteractionRequest, providerId: 'codex' | 'claude' = 'codex'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId,
    executorId: providerId,
    hostId: 'local',
    workspacePath: join(tmpdir(), 'interaction-owner'),
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-lifecycle',
    hookToken: 'token-lifecycle',

    createdAt: _newTailFixtureEpoch(0, 0, 100),
    updatedAt: _newTailFixtureEpoch(0, 0, 100),
    ...(pending ? { pendingInteraction: { request: pending } } : {})
  } as AgentMuxStoredAgentSession
}

/** 一个 native-hook 的 permission request，绑在本 Session 的当前 Run 上。 */
export function permission(id: string): Extract<AgentMuxInteractionRequest, { kind: 'permission' }> {
  return {
    kind: 'permission',
    id,
    agentSessionId: AGENT_SESSION_ID,
    title: 'Allow Edit?',
    nativeToolCallId: `lifecycle-call-${id}`,
    toolName: 'exec_command', toolInput: '{"cmd":"printf lifecycle"}',
    options: [
      { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
      { id: 'reject-once', label: 'Reject', kind: 'reject-once' }
    ],
    evidence: { source: 'native-hook', observedAt: _newTailFixtureEpoch(0, 0, 1), run: { runId: RUN_ID }, hookReceiptId: id }
  }
}

function runProjection(acceptedInputBytes: number | null) {
  return {
    nativeService: null,
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
    args: [] as string[],
    cwd: join(tmpdir(), 'interaction-owner'),
    env: {},
    workspacePath: join(tmpdir(), 'interaction-owner'),
    pid: 999,
    state: { type: 'running' as const },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

type Internals = {
  kernel: Record<string, unknown>
  registry: { load(hostId: string): Promise<void> }
}

export async function connectedClient(pending?: AgentMuxInteractionRequest, providerId: 'codex' | 'claude' = 'codex', nativeSessionId?: string): Promise<{
  client: AgentMuxClient
  writes: string[]
  store: AgentMuxMemoryAgentSessionStore
  state: Internals
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  const original = storedSession(pending, providerId)
  if (nativeSessionId) original.nativeHandle = { kind: 'provider', providerId, sessionId: nativeSessionId }
  await store.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store })
  const state = client as unknown as Internals
  await state.registry.load('local')

  let cursor = 0
  const writes: string[] = []
  state.kernel.isConnected = () => true
  state.kernel.identity = () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' })
  state.kernel.status = async () => runProjection(cursor)
  state.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
    writes.push(operation.data)
    cursor = operation.expectedByte + Buffer.byteLength(operation.data)
    return { run: runProjection(cursor), appliedByteRange: { startByte: operation.expectedByte, endByte: cursor } }
  }
  ;(client as unknown as { connected: boolean }).connected = true
  return { client, writes, store, state }
}

/** Real Core Hook completion owner, synthetic authenticated envelope in this unit fixture. */
export async function completeNativeRequest(client: AgentMuxClient): Promise<void> {
  const request = client.agentSession(AGENT_SESSION_ID).pendingInteraction!.request
  await (client as unknown as { acceptHookEvent(envelope: import('../../src/types.js').NativeHookEnvelope, signal: AbortSignal): Promise<void> }).acceptHookEvent({
    receiptId: 'lifecycle-completed-' + request.id, agentSessionId: AGENT_SESSION_ID,
    providerId: client.agentSession(AGENT_SESSION_ID).providerId, runId: RUN_ID,
    payload: { session_id: client.agentSession(AGENT_SESSION_ID).nativeHandle?.sessionId, hook_event_name: 'PostToolUse', tool_name: request.kind === 'question' ? 'request_user_input' : 'exec_command',
      tool_call_id: request.nativeToolCallId }
  }, new AbortController().signal)
}


/** Existing lifecycle fixtures compose the same exact request contract as a real caller. */
export function withInteractionOperation<T extends { agentSessionId: string; expectedRun: { runId: string }; response: AgentMuxInteractionResponse }>(client: { agentSession(id: string): { pendingInteraction?: { request: AgentMuxInteractionRequest; additionalRequests?: AgentMuxInteractionRequest[] } } }, input: T): T & import('../../src/types.js').AgentMuxInteractionOperationIntent {
  let pending: ReturnType<typeof client.agentSession>['pendingInteraction']
  try { pending = client.agentSession(input.agentSessionId).pendingInteraction } catch { /* Cold callers retain their explicit fixture request. */ }
  const original = [pending?.request, ...(pending?.additionalRequests ?? [])].find(request => request?.id === input.response.requestId) ?? pending?.request
  const expectedRequest = original ? { ...original, id: input.response.requestId,
    evidence: { ...original.evidence, ...(original.evidence.source === 'native-hook' ? { hookReceiptId: input.response.requestId } : {}) },
    ...(original.kind === 'permission' && original.permissionHook && original.id !== input.response.requestId ? { permissionHook: { ...original.permissionHook, receiptId: input.response.requestId } } : {}) } : permission(input.response.requestId)
  return { ...input, operationId: `response-${input.response.requestId}`, expectedRequest }
}
