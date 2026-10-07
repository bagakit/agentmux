import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(options: { trigger?: 'startup' | 'mote-startup' | 'input'; reminder?: boolean; continuation?: boolean; handshake?: boolean; ready?: boolean } = {}) {
  const h = await rpcOwnerFixture(['recipient'], undefined, () => ({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-original' } }))
  const inner = h.client as any, provider = h.client.providers.get('codex')
  const status = inner.kernel.status.bind(inner.kernel), input = inner.kernel.input
  let ready = options.ready !== false, handshakeBytes = 0
  inner.kernel.status = vi.fn(async (id: string) => ({ ...await status(id),
    acceptedInputBytes: (await status(id)).acceptedInputBytes + handshakeBytes,
    state: id === 'run-recipient' ? { type: 'exited', code: 0, signal: null } : { type: 'running' } }))
  inner.kernel.start = vi.fn(async () => ({ ...h.run('recovered-run'), acceptedInputBytes: 0 }))
  inner.kernel.input = vi.fn(async (id: string, operation: any) => {
    const result = await input(id, { ...operation, expectedByte: operation.expectedByte - handshakeBytes })
    return { ...result, appliedByteRange: { startByte: result.appliedByteRange.startByte + handshakeBytes, endByte: result.appliedByteRange.endByte + handshakeBytes },
      run: { ...result.run, acceptedInputBytes: result.run.acceptedInputBytes + handshakeBytes } }
  })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'binding'.padEnd(43, 'D'),
    endpoint: { url: 'http://127.0.0.1:0', token: 'endpoint'.padEnd(43, 'C') }, bindRun: async () => {}, close: async () => {} })
  inner.probeAgent = async () => ({ providerId: 'codex', executable: 'codex', installed: true, capabilities: provider.catalog.capabilities })
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxStoredAgentSession) => {
    if (!options.handshake) return session
    handshakeBytes = 5
    return await inner.registry.update('recipient', session.run, (current: AgentMuxStoredAgentSession) => ({ ...current,
      terminalHandshake: { operationId: 'original-handshake', run: session.run, inputByteRange: { startByte: 0, endByte: 5 }, acknowledged: true } }))
  }
  vi.spyOn(provider, 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
  vi.spyOn(provider, 'readPromptExecutionEvidence').mockImplementation(async () => ready ? { state: 'idle', id: 'native-idle', sourceId: 'native-file-original' } : null)
  vi.spyOn(provider, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
  await inner.registry.update('recipient', { runId: 'run-recipient' }, (session: AgentMuxStoredAgentSession) => ({ ...session,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 1) } }))
  const original = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'original-continuity', trigger: options.trigger ?? 'startup',
    policy: { reminderMode: options.reminder === false ? 'off' as const : 'default-plus-custom' as const, reminderAppend: 'Retain the original constraints.',
      continuationEnabled: options.continuation !== false, continuationPrompt: 'Continue the original task exactly.' } }
  const result = await h.client.ensureAgentContinuity(original)
  expect(result.kind).toBe('resumed')
  const operation = () => h.client.agentSession('recipient').continuityOperations!['original-continuity']!
  const wake = async () => { inner.continuityInputs.track(inner.registry.get('recipient')); await Promise.resolve() }
  return { ...h, inner, provider, original, operation, wake, setReady: (value: boolean) => { ready = value },
    delivery: () => operation().recoveryDelivery!, input: inner.kernel.input,
    settle: async () => { await expect.poll(() => operation().recoveryDelivery?.phase).toBe('accepted') } }
}

async function anotherOwner(h: Awaited<ReturnType<typeof fixture>>) {
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path), providers: [{ ...h.provider }] }), inner = client as any
  await inner.registry.load('local'); inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.status = h.inner.kernel.status; inner.kernel.input = h.inner.kernel.input; inner.kernel.identity = h.inner.kernel.identity
  const provider = client.providers.get('codex')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
  vi.spyOn(provider, 'readPromptExecutionEvidence').mockResolvedValue({ state: 'idle', id: 'original-idle', sourceId: 'original-source' })
  vi.spyOn(provider, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
  return { client, inner, provider }
}

describe('original continuity combined input consumer', () => {
  it.each(['startup', 'mote-startup'] as const)('delivers frozen selected parts once through the real original prompt owner (%s)', async trigger => {
    const h = await fixture({ trigger })
    try {
      await h.settle()
      const delivery = h.delivery(), record = await h.client.inspectAgentPromptSubmission(delivery.key)
      expect(delivery.context).toMatchObject({ agentSessionId: 'recipient', previousRun: { runId: 'run-recipient' }, newRun: { runId: 'recovered-run' },
        nativeTarget: { sessionId: 'native-original' }, interruptedWorking: true, runEvidence: { kind: 'run-ended' }, previousInput: { scope: 'typed-prompt', outcome: 'none' } })
      expect(h.input).toHaveBeenCalledTimes(1)
      expect(record?.admission).toMatchObject({ acknowledged: true, inputKey: delivery.key,
        intent: { message: { userContent: 'Continue the original task exactly.', systemContext: delivery.reminder.text } } })
      expect(delivery.reminder.text).toContain('Provider native Session: codex/native-original')
      expect(delivery.reminder.text).toContain('Retain the original constraints.')
      for (const part of [delivery.reminder, delivery.continuation]) expect(part).toMatchObject({ selected: true, status: 'accepted', receiptRef: delivery.key })
      expect(delivery.receipt).toMatchObject({ key: delivery.key, status: 'terminal-confirmed' })
      await h.client.ensureAgentContinuity({ ...h.original, policy: { reminderMode: 'off', continuationEnabled: false } })
      await h.wake()
      expect(h.input).toHaveBeenCalledTimes(1)
      expect(h.delivery().reminder.text).toBe(delivery.reminder.text)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each([[true, false], [false, true], [false, false]] as const)('honors independent selected parts (reminder=%s continuation=%s)', async (reminder, continuation) => {
    const h = await fixture({ reminder, continuation })
    try {
      if (!reminder && !continuation) { expect(h.operation().recoveryDelivery).toBeUndefined(); expect(h.input).not.toHaveBeenCalled(); return }
      await h.settle()
      expect(h.delivery().reminder.selected).toBe(reminder); expect(h.delivery().continuation.selected).toBe(continuation)
      const message = (await h.client.inspectAgentPromptSubmission(h.delivery().key))!.admission!.intent!.message!
      expect(message.systemContext).toBe(reminder ? h.delivery().reminder.text : undefined)
      expect(message.userContent).toBe(continuation ? 'Continue the original task exactly.' : undefined)
      expect(h.input).toHaveBeenCalledTimes(1)
    } finally { await h.close() }
  })

  it('keeps input-trigger restoration free of automatic recovery inputs', async () => {
    const h = await fixture({ trigger: 'input' })
    try { expect(h.operation().recoveryInputs).toEqual({ reminder: '', continuation: '' }); expect(h.operation().recoveryDelivery).toBeUndefined(); expect(h.input).not.toHaveBeenCalled() }
    finally { await h.close() }
  })

  it('credits only the actual same-Run handshake and contiguous protocol ACK before dispatch', async () => {
    const h = await fixture({ handshake: true, ready: false })
    try {
      await expect.poll(() => h.delivery().phase).toBe('waiting')
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'terminal-protocol', data: '\x1b[0n' })
      expect(h.delivery().protocolInput).toMatchObject({ operationId: h.input.mock.calls[0]![1].operationId, startByte: 5, endByte: 9 })
      h.setReady(true); await h.wake(); await h.settle()
      expect(h.input).toHaveBeenCalledTimes(2)
      expect(h.delivery().initialInputByte).toBe(0)
    } finally { await h.close() }
  })

  it('does not absorb intervening human bytes into the protocol baseline', async () => {
    const h = await fixture({ handshake: true, ready: false })
    try {
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'user', data: 'new user intent' })
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'terminal-protocol', data: '\x1b[0n' })
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().phase).toBe('superseded')
      expect(h.delivery().protocolInput).toBeUndefined(); expect(h.input).toHaveBeenCalledTimes(2)
      expect(h.delivery().reminder.text.length).toBeGreaterThan(0)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps a genuinely newer user prompt ahead of the parked automatic packet', async () => {
    const h = await fixture({ ready: false })
    try {
      await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, afterSubmissionId: null,
        operationId: 'new-user-original-input', prompt: 'New human task.' })
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().phase).toBe('superseded')
      expect(h.input).toHaveBeenCalledTimes(1)
      expect((await h.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, submissionId: 'new-user-original-input' }))?.admission?.acknowledged).toBe(true)
    } finally { await h.close() }
  })

  it('never resends an unknown original input after a lost ACK, rejoin or newer healthy observation', async () => {
    const h = await fixture({ ready: false })
    try {
      const submitted = vi.spyOn(h.client, 'submitAgentPrompt')
      const input = h.inner.kernel.input
      h.inner.kernel.input = vi.fn(async (...args: any[]) => { await input(...args); throw new Error('lost original ACK') })
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().phase).toBe('unknown')
      const frozen = h.delivery(), key = frozen.key
      await h.client.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, operationId: 'new-healthy-observation', trigger: 'startup' })
      expect(h.client.agentSession('recipient').continuity!.operationId).toBe('new-healthy-observation')
      await h.wake(); await h.wake()
      expect(h.inner.kernel.input).toHaveBeenCalledTimes(1)
      expect(submitted).toHaveBeenCalledTimes(1)
      expect(h.delivery().key).toEqual(key); expect(h.delivery().phase).toBe('unknown')
      expect((await h.client.inspectAgentPromptSubmission(key))?.admission?.acknowledged).not.toBe(true)
    } finally { await h.close() }
  })

  it('restores the exact frozen original phase after disposing the actual client and store owner', async () => {
    const h = await fixture({ ready: false })
    let next: AgentMuxClient | undefined
    try {
      const frozen = structuredClone(h.delivery())
      await h.client.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, operationId: 'healthy-shadow', trigger: 'startup' })
      await h.client.dispose()
      const store = new AgentMuxFileAgentSessionStore(h.store.path)
      next = new AgentMuxClient({ store })
      const inner = next as any
      await inner.registry.load('local'); inner.connected = true
      inner.kernel.isConnected = () => true; inner.kernel.status = h.inner.kernel.status; inner.kernel.input = h.inner.kernel.input; inner.kernel.identity = h.inner.kernel.identity
      const provider = next.providers.get('codex')
      vi.spyOn(provider, 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
      vi.spyOn(provider, 'readPromptExecutionEvidence').mockResolvedValue({ state: 'idle', id: 'original-idle', sourceId: 'original-source' })
      vi.spyOn(provider, 'verifyPromptExecutionTransport').mockResolvedValue(true)
      vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
      // Same production restore entry invoked after Runtime/Store observation on connect.
      inner.continuityInputs.restore(inner.registry.list())
      await expect.poll(() => next!.agentSession('recipient').continuityOperations!['original-continuity']!.recoveryDelivery?.phase).toBe('accepted')
      expect(h.input).toHaveBeenCalledTimes(1)
      const recovered = next.agentSession('recipient').continuityOperations!['original-continuity']!.recoveryDelivery!
      expect(recovered.key).toEqual(frozen.key); expect(recovered.reminder.text).toBe(frozen.reminder.text)
      expect(next.agentSession('recipient').continuity!.operationId).toBe('healthy-shadow')
      expect((await next.inspectAgentPromptSubmission(frozen.key))?.admission?.acknowledged).toBe(true)
    } finally { await next?.dispose(); await h.close() }
  })

  it('does not dispatch twice when a stale second owner returns after an unconfirmed call', async () => {
    const h = await fixture({ ready: false }), second = await anotherOwner(h)
    let release!: () => void
    try {
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      const entered = Promise.withResolvers<void>(), gate = new Promise<void>(resolve => { release = resolve })
      vi.mocked(second.provider.verifyPromptExecutionTransport!).mockImplementation(async () => { entered.resolve(); await gate; return true })
      const secondSubmit = vi.spyOn(second.client, 'submitAgentPrompt')
      second.inner.continuityInputs.restore(second.inner.registry.list())
      await entered.promise
      // A possibly executing call without an ACK cannot be handed to another observer.
      const firstSubmit = vi.spyOn(h.client, 'submitAgentPrompt').mockRejectedValue(new Error('dispatch response unconfirmed'))
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().phase).toBe('unknown')
      release()
      await expect.poll(() => second.inner.continuityInputs.tails.size).toBe(0)
      expect(firstSubmit).toHaveBeenCalledTimes(1); expect(secondSubmit).not.toHaveBeenCalled()
      expect(h.input).not.toHaveBeenCalled()
      expect((await h.store.readMetadata('recipient'))!.continuityOperations!['original-continuity']!.recoveryDelivery!.phase).toBe('unknown')
    } finally { release?.(); await second.client.dispose(); await h.close() }
  })

  it('cannot use an actual different-body ACK on the same key to accept frozen parts', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, afterSubmissionId: null,
        operationId: h.delivery().key.submissionId, prompt: 'Another original body under a conflicting key.' })
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().phase).toBe('unknown')
      expect(h.delivery().reason).toContain('conflicting content')
      expect(h.delivery().reminder.status).toBe('unknown'); expect(h.delivery().reminder.receiptRef).toBeUndefined()
      expect(h.delivery().continuation.receiptRef).toBeUndefined()
      expect(h.input).toHaveBeenCalledTimes(1)
    } finally { await h.close() }
  })

  it('keeps an unknown initial boundary visible and preserves ordinary terminal input', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      await h.inner.registry.update('recipient', { runId: 'recovered-run' }, (current: AgentMuxStoredAgentSession) => {
        const next = structuredClone(current)
        delete next.continuityOperations!['original-continuity']!.recoveryDelivery!.initialInputByte
        return next
      })
      const events: string[] = [], unsubscribe = h.client.onEvent(event => { if (event.type === 'agent-error') events.push(event.code) })
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().reason).toContain('boundary is unknown')
      expect(h.delivery().phase).toBe('waiting'); expect(h.input).not.toHaveBeenCalled()
      expect(events).toContain('CONTINUITY_INPUT_UNCONFIRMED')
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'user', data: 'ordinary input remains usable' })
      expect(h.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled(); unsubscribe()
    } finally { await h.close() }
  })

  it('does not wait for an unresponsive native observer when the client is disposed', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      const entered = Promise.withResolvers<void>(), observation = Promise.withResolvers<any>()
      const submitted = vi.spyOn(h.client, 'submitAgentPrompt')
      vi.mocked(h.provider.readPromptExecutionEvidence!).mockImplementation(async () => { entered.resolve(); return await observation.promise })
      await h.wake(); await entered.promise
      await h.client.dispose()
      observation.resolve({ state: 'idle', id: 'late-idle', sourceId: 'original-source' })
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      expect(submitted).not.toHaveBeenCalled()
      expect(h.delivery().phase).toBe('waiting'); expect(h.input).not.toHaveBeenCalled()
      expect((await h.store.readMetadata('recipient'))!.continuityOperations!['original-continuity']!.recoveryDelivery!.key).toEqual(h.delivery().key)
    } finally { await h.close() }
  })

  it('does not send recovery input to a changed native conversation', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      await h.inner.registry.update('recipient', { runId: 'recovered-run' }, (current: AgentMuxStoredAgentSession) => ({ ...current,
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'different-native-target' } }))
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().phase).toBe('superseded')
      expect(h.input).not.toHaveBeenCalled(); expect(h.delivery().context.nativeTarget.sessionId).toBe('native-original')
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('requires actual native idle evidence while preserving working-Run ordinary input', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      vi.mocked(h.provider.readPromptExecutionEvidence!).mockResolvedValue({ state: 'working', sourceId: 'native-original', id: 'still-native-working' })
      await h.wake()
      await expect.poll(() => h.inner.continuityInputs.tails.size).toBe(0)
      expect(h.delivery().phase).toBe('waiting'); expect(h.input).not.toHaveBeenCalled()
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'user', data: 'ordinary working turn input' })
      expect(h.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
})
