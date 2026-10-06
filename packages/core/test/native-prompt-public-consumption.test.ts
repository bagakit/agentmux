import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { defineAgentProvider, type AgentProviderRegistry } from '../src/agent-provider.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { agentTurnCompletionIdentity } from '../src/agent-session-identity.js'

const nativePlan = { kind: 'native-rpc' as const, protocolId: 'fixture-native-contract', actorId: 'exact-actor', sourceId: 'exact-source', threadId: 'exact-thread', operation: 'start-or-steer' as const }

function rawTransport(h: Awaited<ReturnType<typeof rpcOwnerFixture>>) {
  let cursor = 0
  const writes: string[] = []
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-runtime', protocolVersion: 1, buildIdentity: 'fixture' })
  h.inner.kernel.status = async (id: string) => ({ ...h.run(id), acceptedInputBytes: cursor })
  h.inner.kernel.input = async (id: string, input: { expectedByte: number; data: string }) => {
    expect(input.expectedByte).toBe(cursor)
    writes.push(input.data); const startByte = cursor; cursor += Buffer.byteLength(input.data)
    return { run: { ...h.run(id), acceptedInputBytes: cursor }, appliedByteRange: { startByte, endByte: cursor } }
  }
  return writes
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

// A declared deterministic Provider protocol port, with real public CLI/RPC,
// authentication, message journal, Core coordinator and durable Store. The separate
// Native/TUI fixture qualifies vendor RPC; no coordinator/consumer is mocked here.
it.each(['admitted', 'not-applied', 'lost-reply'] as const)('actual CLI/RPC consume one Native admission: %s', async outcome => {
  const h = await rpcOwnerFixture(), endpoint = join(h.root, 'native-control.sock')
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-runtime', protocolVersion: 1, buildIdentity: 'fixture' })
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  const tty = vi.fn(() => { throw new Error('Native messages must not write PTY bytes') })
  h.inner.kernel.input = tty
  const terminalPlan = vi.spyOn(provider, 'planPromptInput').mockImplementation(() => { throw new Error('Native message cannot create a terminal plan') })
  let lost = false
  const dispatch = vi.fn(async (_prompt: string, operationId: string) => {
    const current = (await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')!
    expect(current.promptCompletionAdmission).toMatchObject({ transport: 'native', submissionId: operationId,
      operationId, native: { outcome: 'claimed', plan: { operation: 'start-or-steer' } }, intent: { message: { authorAgentSessionId: 'caller' } } })
    expect(current.promptCompletionAdmission).not.toHaveProperty('startByte')
    expect(current.promptCompletionAdmission).not.toHaveProperty('endByte')
    if (outcome === 'lost-reply' && !lost) { lost = true; throw new AgentMuxError('Fixture lost the original reply after dispatch.', 'AGENT_NATIVE_INPUT_UNCONFIRMED', '{"phase":"native-rpc","reason":"connection-closed"}') }
    return outcome === 'not-applied' ? { outcome: 'not-applied' as const, errorCode: -32600 } : { outcome: 'admitted' as const, turnId: 'exact-turn' }
  })
  const prepare = vi.spyOn(provider, 'prepareNativePromptInput').mockResolvedValue({
    plan: nativePlan,
    assertCurrent: async () => {}, dispatch, close: async () => {}
  })
  const server = new AgentMuxControlServer({ socketPath: endpoint, coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint }, credentials: h.credentials })
  const text = 'Original bytes 原文', operationId = 'native-public-' + outcome
  const params = { sourceChannel: 'cli' as const, target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text,
    execution: 'immediate' as const, operationId }
  try {
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + endpoint, 'agent', 'send', '--to-session', 'recipient', '--text', text,
      '--execution', 'immediate', '--operation-id', operationId], objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability }))
    if (outcome === 'admitted') expect(cli.code, cli.stderr).toBe(0)
    else expect(cli.code).not.toBe(0)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]![0]).toBe('[Message from Agent caller]\n' + text)
    expect(tty).not.toHaveBeenCalled(); expect(terminalPlan).not.toHaveBeenCalled()
    const journal = await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).listAfter(0)
    expect(journal).toHaveLength(1)
    expect(journal[0]!.envelope.body).toBe(text)
    expect(journal[0]!.delivery.state).toBe(outcome === 'admitted' ? 'delivered' : 'queued')
    const stored = (await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')!
    expect(stored.promptCompletionAdmission?.native?.outcome).toBe(outcome === 'lost-reply' ? 'unknown' : outcome)
    if (outcome === 'admitted') await expect(rpc.call('agent.send', params)).resolves.toMatchObject({ messageId: journal[0]!.envelope.messageId })
    else await expect(rpc.call('agent.send', params)).rejects.toMatchObject({ code: outcome === 'not-applied' ? 'AGENT_PROMPT_INPUT_NOT_APPLIED' : 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(dispatch).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce()
    await expect(rpc.call('agent.send', { ...params, text: 'changed' })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
    // Reopening the real durable Session Store retains the original Native outcome.
    expect((await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')?.promptCompletionAdmission).toEqual(stored.promptCompletionAdmission)
    if (outcome === 'lost-reply') {
      await expect(rpc.call('agent.send', { ...params, operationId: 'later-after-unknown' })).resolves.toMatchObject({ delivery: { state: 'delivered' } })
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect((await h.store.readPromptAdmission('recipient', stored.run, journal[0]!.envelope.messageId))?.admission).toEqual(stored.promptCompletionAdmission)
      await expect(rpc.call('agent.send', params)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      expect(dispatch).toHaveBeenCalledTimes(2)
    }
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
}, 20_000)

it.each(['before-claim', 'after-claim'] as const)('rejects late typed pending/source facts %s and leaves Raw usable', async phase => {
  for (const fact of ['pending', 'source'] as const) {
    const h = await rpcOwnerFixture(), writes = rawTransport(h)
    const original = (await h.store.load()).find(s => s.agentSessionId === 'recipient')!
    await h.store.compareAndSwap(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'exact-thread' } })
    await h.inner.registry.load('local')
    const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
    let reads = 0
    const dispatch = vi.fn(async () => ({ outcome: 'admitted' as const, turnId: 'exact-turn' }))
    vi.spyOn(provider, 'prepareNativePromptInput').mockResolvedValue({ plan: nativePlan, dispatch, close: async () => {},
      assertCurrent: async () => {
        if (++reads !== (phase === 'before-claim' ? 1 : 2)) return
        const stored = (await h.store.load()).find(s => s.agentSessionId === 'recipient')!
        await h.store.compareAndSwap(stored, { ...stored, updatedAt: stored.updatedAt + 1,
          ...(fact === 'pending' ? { pendingInteraction: { request: { kind: 'permission' as const, id: 'late-native-permission',
            agentSessionId: 'recipient', title: 'Display text grants no permission', options: [{ id: 'deny', label: 'Display label', kind: 'reject-once' as const }],
            evidence: { source: 'native-hook' as const, observedAt: reshapeFixtureEpoch(0, 0, 2), run: stored.run, hookReceiptId: 'late-native-receipt' } } } }
            : { observedNativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'different-thread' }, nativeSourceObservation: { state: 'changed' as const, run: stored.run, observedAt: reshapeFixtureEpoch(0, 0, 2), reason: 'fixture-exact-source-change' } }) })
      } })
    try {
      const error = await h.client.submitAgentPrompt({ agentSessionId: 'recipient', ...agentPromptCondition(h.client.agentSession('recipient')),
        operationId: 'late-' + phase + '-' + fact, prompt: 'Retained original', execution: 'immediate', authorHuman: true }).then(() => undefined, e => e)
      expect(error).toMatchObject({ code: phase === 'after-claim' ? 'AGENT_NATIVE_INPUT_UNCONFIRMED' : fact === 'pending' ? 'AGENT_INTERACTION_PENDING' : 'AGENT_PROMPT_SOURCE_CHANGED' })
      expect(dispatch).not.toHaveBeenCalled(); expect(writes).toEqual([])
      const stored = (await h.store.load()).find(s => s.agentSessionId === 'recipient')!
      expect(stored.promptCompletionAdmission?.native?.outcome).toBe(phase === 'after-claim' ? 'not-applied' : undefined)
      expect(stored.run.runId).toBe('run-recipient'); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: stored.run, data: 'raw-kept', source: 'user' })
      expect(writes).toEqual(['raw-kept']); expect(dispatch).not.toHaveBeenCalled()
    } finally { await h.close(); vi.restoreAllMocks() }
  }
})

it('cancelling the Native reply waiter keeps its admitted claim unknown and does not recall/replay it', async () => {
  const h = await rpcOwnerFixture(), writes = rawTransport(h), controller = new AbortController()
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const dispatch = vi.fn(async (_prompt: string, _id: string, signal?: AbortSignal) => {
    entered()
    await new Promise<void>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }) })
    return { outcome: 'admitted' as const, turnId: 'exact-turn' }
  })
  vi.spyOn(provider, 'prepareNativePromptInput').mockResolvedValue({ plan: nativePlan, dispatch, close: async () => {}, assertCurrent: async () => {} })
  const input = { agentSessionId: 'recipient', ...agentPromptCondition(h.client.agentSession('recipient')), operationId: 'cancel-waiter',
    prompt: 'Original Native input', execution: 'immediate' as const, authorHuman: true }
  try {
    const waiting = h.client.submitAgentPrompt({ ...input, signal: controller.signal }).then(() => undefined, e => e)
    await started
    await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: input.expectedRun, data: 'raw-during-native-wait', source: 'user' })
    controller.abort(new Error('Cancel reply wait only'))
    expect(await waiting).toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const record = (await h.store.load()).find(s => s.agentSessionId === 'recipient')!
    expect(record.promptCompletionAdmission).toMatchObject({ transport: 'native', native: { outcome: 'unknown' }, notApplied: false })
    await expect(h.client.submitAgentPrompt(input)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(dispatch).toHaveBeenCalledOnce(); expect(writes).toEqual(['raw-during-native-wait']); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it.each(['manual', 'completion', 'future', 'after-native-steer'] as const)('keeps the declared default contract in the actual Core owner: %s', async mode => {
  const h = await rpcOwnerFixture(), writes = rawTransport(h)
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  // A declared generic terminal protocol port coexists with Native immediate. The
  // Core owner, condition/idle/future validation and real durable claim are unchanged.
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const prepare = vi.spyOn(provider, 'prepareNativePromptInput').mockResolvedValue({ plan: nativePlan,
    dispatch: async () => ({ outcome: 'admitted', turnId: 'exact-turn' }), assertCurrent: async () => {}, close: async () => {} })
  try {
    if (mode === 'after-native-steer') await h.client.submitAgentPrompt({ agentSessionId: 'recipient', ...agentPromptCondition(h.client.agentSession('recipient')),
      prompt: 'Native busy input', execution: 'immediate', authorHuman: true, operationId: 'prior-steer' })
    const stored = (await h.store.load()).find(s => s.agentSessionId === 'recipient')!
    await h.store.compareAndSwap(stored, { ...stored, semanticStatus: { state: 'done', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 100), stateEnteredAt: reshapeFixtureEpoch(0, 0, 100) }, updatedAt: reshapeFixtureEpoch(0, 0, 100) })
    await h.inner.registry.load('local')
    if (mode === 'future') await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'recipient', intentId: 'exact-future', operationId: 'save-future', prompt: 'Default original', active: true })
    const current = h.client.agentSession('recipient')
    await h.client.submitAgentPrompt({ agentSessionId: 'recipient', ...agentPromptCondition(current), prompt: 'Default original', operationId: 'default-' + mode,
      ...(mode === 'completion' ? { expectedInputByte: 0, expectedCompletionId: agentTurnCompletionIdentity(current) }
        : mode === 'future' ? { expectedInputByte: 0, expectedFutureIntent: { intentId: 'exact-future', occurrenceAt: reshapeFixtureEpoch(0, 0, 1000) } } : { authorHuman: true }) })
    expect(prepare).toHaveBeenCalledTimes(mode === 'after-native-steer' ? 1 : 0)
    expect(writes).toEqual(['Default original\r'])
    expect(h.client.agentSession('recipient').promptCompletionAdmission).toMatchObject({ acknowledged: true, intent: { execution: 'default', plan: { kind: 'single-phase' } } })
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('keeps an old unknown PTY-steer admission without preparing or replaying it as Native', async () => {
  const h = await rpcOwnerFixture(), writes = rawTransport(h)
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  const prepare = vi.spyOn(provider, 'prepareNativePromptInput').mockRejectedValue(new Error('An old unknown operation cannot prepare a new writer'))
  try {
    const stored = (await h.store.load()).find(s => s.agentSessionId === 'recipient')!, prompt = 'Old original', operationId = 'old-unknown-tty-steer'
    await h.store.compareAndSwap(stored, { ...stored, promptCompletionAdmission: { submissionId: operationId, operationId: 'old-payload',
      startByte: 0, endByte: Buffer.byteLength(prompt + '\r'), acknowledged: false,
      intent: { run: stored.run, ownerInstanceId: 'old-owner', prompt, execution: 'immediate',
        plan: { kind: 'render-then-submit', payload: prompt, renderedText: prompt, submit: '\r' },
        message: { userContent: prompt, authorHuman: true, sourceChannel: 'api' } } } })
    await h.inner.registry.load('local')
    const before = h.client.agentSession('recipient').promptCompletionAdmission
    const error = await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: stored.run, afterSubmissionId: null,
      operationId, prompt, execution: 'immediate', authorHuman: true }).then(() => undefined, e => e)
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(error.controlFailure).toBeUndefined(); expect(prepare).not.toHaveBeenCalled(); expect(writes).toEqual([])
    expect((await h.store.load()).find(s => s.agentSessionId === 'recipient')!.promptCompletionAdmission).toEqual(before)
  } finally { await h.close() }
})

it('a Native environment contribution does not grant an undeclared immediate intent', async () => {
  const h = await rpcOwnerFixture(), writes = rawTransport(h)
  const registry = Reflect.get(h.client, 'providers') as AgentProviderRegistry, template = registry.get('codex')
  const { providerFork: _fork, promptExecution: _immediate, ...capabilities } = template.catalog.capabilities
  const prepare = vi.fn(async () => ({ plan: nativePlan, assertCurrent: async () => {}, dispatch: async () => ({ outcome: 'admitted' as const, turnId: 'exact-turn' }), close: async () => {} }))
  registry.register(defineAgentProvider({ catalog: { ...template.catalog, id: 'no-immediate', capabilities, hookStrategy: { kind: 'none' } }, hook: template.hook,
    buildArgs: (_prompt, args) => [...args], prepareNativePromptInput: prepare }))
  try {
    const stored = (await h.store.load()).find(s => s.agentSessionId === 'recipient')!
    await h.store.compareAndSwap(stored, { ...stored, providerId: 'no-immediate', executorId: 'no-immediate' }); await h.inner.registry.load('local')
    await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', ...agentPromptCondition(h.client.agentSession('recipient')),
      operationId: 'undeclared-immediate', prompt: 'Retained original', execution: 'immediate', authorHuman: true })).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED' })
    expect(prepare).not.toHaveBeenCalled(); expect(writes).toEqual([])
  } finally { await h.close() }
})
