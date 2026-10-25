import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { createClaudeProvider } from '../src/providers/claude.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'
import { fixturePath } from './helpers/fixture-values.js'

type Internals = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
  endedRuns: Map<string, undefined>
  promptSubmission: { observeReadiness(...args: unknown[]): void }
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}
const clients: AgentMuxClient[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); vi.restoreAllMocks() })

async function fixture() {
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'original-agent', providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: fixturePath('provider-hook'), run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native' }
  }
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store, providers: [createClaudeProvider(defineAgentProvider)] })
  clients.push(client)
  const inner = client as unknown as Internals
  await inner.registry.load('local')
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.status = async () => ({ runId: session.run.runId, nativeService: null, lifecycleOperationId: null,
    program: 'claude', args: [], workspacePath: session.workspacePath, pid: 123, state: { type: 'running' },
    cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
  const input = vi.fn()
  inner.kernel.input = input
  vi.spyOn(inner.promptSubmission, 'observeReadiness').mockImplementation(() => {})
  const events: AgentMuxClientEvent[] = []
  client.onEvent(event => events.push(event))
  const hook = (receiptId: string, eventName: string, sequence: number, turnId: string,
    extra: Record<string, unknown> = {}): NativeHookEnvelope => ({
    receiptId, eventName, agentSessionId: session.agentSessionId, providerId: session.providerId, runId: session.run.runId,
    payload: { hook_event_name: eventName, session_id: 'original-native', sourceId: 'original-observer', sequence,
      turnId, ...(eventName === 'turn.complete' ? { reason: 'error', isAborted: false } : {}), ...extra }
  })
  const accept = (envelope: NativeHookEnvelope) => inner.acceptHookEvent(envelope, AbortSignal.timeout(5_000))
  return { client, inner, session, store, events, input, hook, accept }
}

describe('Core Hook outcome history ownership', () => {
  it('retains a late original turn failure without replacing newer current activity', async () => {
    const f = await fixture()
    await f.accept(f.hook('old-start', 'turn.start', 1, 'old-turn'))
    await f.accept(f.hook('new-start', 'turn.start', 3, 'new-turn'))
    const before = await f.store.readMetadata(f.session.agentSessionId)
    const failure = f.hook('old-failure', 'turn.complete', 2, 'old-turn')
    await f.accept(failure)
    await f.accept(failure)
    const saved = await f.store.readMetadata(f.session.agentSessionId)
    expect(saved?.semanticStatus).toEqual(before?.semanticStatus)
    expect(saved?.recoveryActivity).toMatchObject({ state: 'active', nativeTurnId: 'new-turn', sequence: 3 })
    expect(saved?.hookReceipt?.id).toBe('new-start')
    expect(saved?.run).toEqual(f.session.run)
    expect(saved?.nativeHandle).toEqual(f.session.nativeHandle)
    const history = await f.client.sessionTimeline(f.session.agentSessionId)
    const outcomes = history.items.filter(item => item.turnOutcome)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.turnOutcome).toMatchObject({ status: 'failed', failure: { nativeTurnId: 'old-turn', code: 'AGENT_PROVIDER_ERROR' } })
    expect(f.events.filter(event => event.type === 'agent-timeline' && event.evidence?.hookReceiptId === 'old-failure')).toHaveLength(1)
    expect(f.input).not.toHaveBeenCalled()
  })

  it('keeps ended Run receipts as unconfirmed diagnostics without reopening permissions', async () => {
    const f = await fixture()
    await f.accept(f.hook('start', 'turn.start', 1, 'original-turn'))
    const before = await f.store.readMetadata(f.session.agentSessionId)
    f.inner.endedRuns.set(f.session.run.runId, undefined)
    const failure = f.hook('ended-failure', 'turn.complete', 2, 'original-turn')
    await f.accept(failure)
    await f.accept(failure)
    await f.accept(f.hook('ended-permission', 'PermissionRequest', 3, 'original-turn', { tool_name: 'Bash', tool_input: { command: 'pwd' } }))
    expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(before)
    const history = await f.client.sessionTimeline(f.session.agentSessionId)
    const diagnostics = history.items.filter(item => item.conversationDiagnostic?.code === 'AGENT_HOOK_OUTCOME_UNCONFIRMED')
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics.every(item => !item.turnOutcome && item.contentEligibility === 'unconfirmed')).toBe(true)
    expect(diagnostics.some(item => JSON.parse(item.content!).payload.turnId === 'original-turn')).toBe(true)
    expect(f.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_HOOK_OUTCOME_UNCONFIRMED' &&
      event.evidence?.hookReceiptId === 'ended-failure')).toBe(true)
    expect(f.input).not.toHaveBeenCalled()
  })

  it('does not attribute foreign subjects or mismatched bindings to the original turn', async () => {
    const f = await fixture()
    await f.accept(f.hook('start', 'turn.start', 1, 'original-turn'))
    await f.accept(f.hook('foreign', 'turn.complete', 2, 'foreign-turn', { session_id: 'foreign-native' }))
    await f.accept({ ...f.hook('wrong-agent', 'turn.complete', 3, 'original-turn'), agentSessionId: 'foreign-agent' })
    await f.accept({ ...f.hook('wrong-provider', 'turn.complete', 3, 'original-turn'), providerId: 'codex' })
    await f.accept({ ...f.hook('wrong-run', 'turn.complete', 3, 'original-turn'), runId: 'foreign-run' })
    const history = await f.client.sessionTimeline(f.session.agentSessionId)
    expect(history.items.filter(item => item.turnOutcome)).toHaveLength(0)
    expect((await f.store.readMetadata(f.session.agentSessionId))?.nativeHandle).toEqual(f.session.nativeHandle)
    expect(f.input).not.toHaveBeenCalled()
  })
})
