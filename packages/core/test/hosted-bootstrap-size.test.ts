import { randomBytes } from 'node:crypto'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { AgentMuxClient } from '../src/client.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRun } from '../src/types.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxHostedAgentSessionSummary } from '../src/hosted-session-summary.js'
import type { AgentMuxHostedBootstrap, AgentMuxHostedClient, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import { hostedTestFence as fence, hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { hostedAgentSessionSummary } from '../src/hosted-session-summary.js'
import { agentPromptCondition, agentPromptNotApplied } from '../src/agent-prompt-condition.js'

function session(id: string, prompt: string): AgentMuxAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: 'workspace',
    run: { runId: 'run-' + id }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    promptCompletionAdmission: { submissionId: 'submission-' + id, operationId: 'transport-' + id,
      transport: 'native', native: { plan: { kind: 'native-rpc', protocolId: 'native', sourceId: 'source', actorId: 'actor', threadId: 'thread', operation: 'start-or-steer' }, outcome: 'unknown' },
      intent: { run: { runId: 'run-' + id }, ownerInstanceId: 'owner', prompt, execution: 'immediate',
        plan: { kind: 'native-rpc', protocolId: 'native', sourceId: 'source', actorId: 'actor', threadId: 'thread', operation: 'start-or-steer' },
        message: { userContent: prompt, authorHuman: true } } } }
}
function fixture(sessions: AgentMuxAgentSession[]) {
  const listeners = new Set<(event: AgentMuxClientEvent) => void>()
  const runFor = (value: AgentMuxAgentSession): AgentMuxRun => ({ nativeService: null, ...value.run, kind: 'agent', providerId: value.providerId,
    executorId: value.executorId, agentSessionId: value.agentSessionId, workspacePath: value.workspacePath,
    pid: 123, state: 'running', cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0 })
  const core = {
    connectRuntime: vi.fn(async () => {}),
    onEvent: (listener: (event: AgentMuxClientEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    runtimeIdentity: () => ({ hostId: 'local', instanceId: 'native', buildIdentity: 'fixture', protocolVersion: 1, processId: 123 }),
    catalog: () => [], agentMessageQueuePath: () => 'messages', readAgentSessions: async () => sessions,
    readAgentSession: vi.fn(async (id: string) => sessions.find(value => value.agentSessionId === id) ?? null),
    metadata: { pendingIds: () => [] },
    listRuns: vi.fn(async () => sessions.map(runFor)),
    runtimeProjection: vi.fn(async () => ({ hostId: 'local', subjects: sessions.map(value => ({ kind: 'agent', subjectId: value.agentSessionId,
      hostId: value.hostId, workspacePath: value.workspacePath, providerId: value.providerId, executorId: value.executorId,
      agentSession: value, run: runFor(value) })) }))
  } as unknown as AgentMuxClient
  const service = new AgentMuxHostedRuntimeService(core, null, () => hostedTestOwner(core))
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => await service.call(method, structuredClone(params), options) as never,
    subscribe: async (method, params, handlers) => {
      const subscription = await service.subscribe(method, structuredClone(params), event => handlers.onEvent(structuredClone(event)))
      handlers.onInitial(subscription.initial as never); await subscription.start?.()
      return { dispose: () => subscription.dispose() }
    }
  }
  return { core, service, port, emit: (event: AgentMuxClientEvent) => { for (const listener of listeners) listener(event) } }
}

describe('consumer-negotiated Hosted Session projection', () => {
  it.each(['native', 'pty'] as const)('keeps exact %s refusal and predecessor facts in the shared Core classifier without prompt bodies', transport => {
    const full = session('session-original', 'Original full prompt')
    if (transport === 'native') {
      full.promptCompletionAdmission!.notApplied = true
      if (full.promptCompletionAdmission!.transport === 'native') full.promptCompletionAdmission!.native.outcome = 'not-applied'
    } else {
      const intent = full.promptCompletionAdmission!.intent!
      full.promptCompletionAdmission = { operationId: 'transport-session-original', submissionId: 'submission-session-original',
        startByte: 0, endByte: 10, notApplied: true, intent: { ...intent, plan: { kind: 'single-phase', data: 'Original full prompt\r' } } }
    }
    const summary = hostedAgentSessionSummary(full)
    expect(agentPromptCondition(summary)).toEqual(agentPromptCondition(full))
    expect(agentPromptNotApplied(summary)).toEqual({ submissionId: 'submission-session-original', run: full.run })
    expect(agentPromptNotApplied(summary)).toEqual(agentPromptNotApplied(full))
    expect(summary.promptCompletionAdmission!.intent).toBeUndefined()
    summary.promptCompletionAdmission!.acknowledged = true
    expect(agentPromptNotApplied(summary)).toBeUndefined()
    delete summary.promptCompletionAdmission!.acknowledged
    delete summary.promptCompletionAdmission!.intentSummary
    expect(agentPromptNotApplied(summary)).toBeUndefined()
  })

  it('shrinks the encoded bootstrap of 2000 distinct 50KB prompts by at least eighty percent', async () => {
    const sessions = Array.from({ length: 2000 }, (_, index) => session('session-' + index, randomBytes(25 * 1024).toString('hex')))
    expect(new Set(sessions.map(value => value.promptCompletionAdmission!.intent!.prompt)).size).toBe(2000)
    const f = fixture(sessions)
    try {
      // The call result is measured in its actual JSON wire form. This large full baseline
      // exceeds a single public frame; no successful full transport is claimed here.
      const full = await f.service.call('runtime.bootstrap', { consumerId: 'full-consumer', fence }) as AgentMuxHostedBootstrap
      const summary = await f.service.call('runtime.bootstrap', { consumerId: 'summary-consumer', fence, sessions: 'summary' }) as AgentMuxHostedBootstrap<'summary'>
      const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
      const fullBytes = bytes(full), summaryBytes = bytes(summary)
      expect(summaryBytes / fullBytes, `bootstrap bytes: full=${fullBytes}, summary=${summaryBytes}`).toBeLessThanOrEqual(.2)
      expect(summary.sessions).toHaveLength(2000)
      expect(summary.sessions[123]!.promptCompletionAdmission).toMatchObject({ submissionId: 'submission-session-123', operationId: 'transport-session-123',
        native: { outcome: 'unknown' }, intentSummary: { promptBytes: 50 * 1024, execution: 'immediate' } })
      expect(summary.sessions.every(value => value.promptCompletionAdmission!.intent === undefined)).toBe(true)
      expect(full.sessions[123]!.promptCompletionAdmission!.intent!.prompt).toBe(sessions[123]!.promptCompletionAdmission!.intent!.prompt)
      console.log(JSON.stringify({ sessions: 2000, promptBytes: 50 * 1024, fullBytes, summaryBytes, reduction: 1 - summaryBytes / fullBytes }))
    } finally { await f.service.dispose() }
  }, 30_000)

  it('keeps full consumers full and summary caches small across real bootstrap, events, receipts and exact reads', async () => {
    const original = session('session-original', 'Original full prompt'), f = fixture([original])
    let statusSession = original
    Object.assign(f.core, { statusAgent: vi.fn(async () => ({ session: statusSession })) })
    const full = await connectHostedAgentMux({ rpc: f.port, consumerId: 'full-consumer' })
    const summary = await connectHostedAgentMux({ rpc: f.port, consumerId: 'summary-consumer', sessions: 'summary' })
    expectTypeOf<ReturnType<typeof summary.agentSession>>().toEqualTypeOf<AgentMuxHostedAgentSessionSummary>()
    expectTypeOf<Awaited<ReturnType<AgentMuxHostedClient<'summary'>['readAgentSession']>>>().toEqualTypeOf<AgentMuxAgentSession | null>()
    try {
      await vi.waitFor(() => expect(f.core.listRuns).toHaveBeenCalledOnce())
      expect(f.core.runtimeProjection).toHaveBeenCalledOnce()
      expect(full.agentSession(original.agentSessionId).promptCompletionAdmission!.intent!.prompt).toBe('Original full prompt')
      expect(summary.agentSession(original.agentSessionId).promptCompletionAdmission!.intent).toBeUndefined()
      const fullEvents: AgentMuxClientEvent[] = [], summaryEvents: AgentMuxClientEvent[] = []
      full.onEvent(event => { if (event.type === 'agent-session') fullEvents.push(event) })
      summary.onEvent(event => { if (event.type === 'agent-session') summaryEvents.push(event) })
      await summary.statusAgent(original.agentSessionId); await summary.statusAgent(original.agentSessionId)
      expect(summaryEvents, 'unchanged full read receipts do not feed the summary observer back into its next read').toEqual([])
      const changed = session(original.agentSessionId, 'Changed full prompt')
      statusSession = changed
      f.emit({ type: 'agent-session', session: changed })
      await vi.waitFor(() => expect(summaryEvents).toHaveLength(1))
      expect(fullEvents).toHaveLength(1)
      expect(full.agentSession(original.agentSessionId).promptCompletionAdmission!.intent!.prompt).toBe('Changed full prompt')
      expect(summary.agentSession(original.agentSessionId).promptCompletionAdmission!.intent).toBeUndefined()
      expect(summary.agentSession(original.agentSessionId).promptCompletionAdmission!.intentSummary!.promptBytes).toBe(Buffer.byteLength('Changed full prompt'))
      await summary.statusAgent(original.agentSessionId); await summary.statusAgent(original.agentSessionId)
      expect(summaryEvents, 'reads compare the same negotiated projection before publishing').toHaveLength(1)
      expect((await summary.readAgentSession(original.agentSessionId))!.promptCompletionAdmission!.intent!.prompt).toBe('Original full prompt')
      expect(f.core.readAgentSession).toHaveBeenCalledExactlyOnceWith(original.agentSessionId)
      expect(summary.agentSession(original.agentSessionId).promptCompletionAdmission!.intent).toBeUndefined()
      expect(summaryEvents).toHaveLength(1)
    } finally { await full.dispose(); await summary.dispose(); await f.service.dispose() }
  })
})
