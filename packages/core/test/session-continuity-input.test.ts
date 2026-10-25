import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient as SourceClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore as SourceStore } from '../src/agent-session-store.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxError as SourceError } from '../src/errors.js'
import { composeAgentPrompt } from '../src/agent-outbound-message.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { createHash } from 'node:crypto'
import { DEFAULT_AGENT_CONTINUITY_REMINDER, type AgentMuxContinuityOperation } from '../src/agent-session-recovery/continuity-contract.js'

const owner = process.env.AGENTMUX_TEST_GUIDANCE_CORE ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_GUIDANCE_CORE)
  : { AgentMuxClient: SourceClient, AgentMuxFileAgentSessionStore: SourceStore, AgentMuxError: SourceError }
const { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxError } = owner as {
  AgentMuxClient: typeof SourceClient; AgentMuxFileAgentSessionStore: typeof SourceStore; AgentMuxError: typeof SourceError }
type AgentMuxClient = SourceClient

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(options: { deferManagedInput?: boolean; managedDelivery?: boolean; providerId?: 'codex' | 'claude' | 'gemini'; nativeObservation?: 'changed' | 'unknown' | 'ambiguous'; loseInputAck?: boolean; newUserBeforeAutomatic?: boolean; renderObservationUnavailable?: boolean; trigger?: 'startup' | 'mote-startup' | 'input'; reminder?: boolean; continuation?: boolean; handshake?: boolean; ready?: boolean } = {}) {
  const providerId = options.providerId ?? 'codex'
  const h = await rpcOwnerFixture(['recipient'], { AgentMuxClient, AgentMuxFileAgentSessionStore }, () => ({ providerId, executorId: providerId, nativeHandle: { kind: 'provider', providerId, sessionId: 'native-original' } }))
  const inner = h.client as any, originalProvider = h.client.providers.get(providerId)
  // This suite exercises the retained post-launch terminal owner. Native argv
  // carriers are separately verified before any terminal side effect.
  const provider = { ...originalProvider, catalog: { ...originalProvider.catalog, promptDelivery: options.managedDelivery ? 'positional-argv' as const : 'post-launch-only' as const },
    prepareManagedLaunch: async (plan: any, _operationId: string, context: { prompt?: string }) => options.managedDelivery
      ? { plan: { ...plan, args: plan.args.filter((value: string) => value !== context.prompt && value !== '--') }, promptDelivery: 'post-launch' as const } : { plan } }
  h.client.providers.replace(provider)
  const status = inner.kernel.status.bind(inner.kernel), input = inner.kernel.input
  let ready = options.ready !== false, handshakeBytes = 0, loseInputAck = options.loseInputAck === true
  inner.kernel.status = vi.fn(async (id: string) => ({ ...await status(id),
    acceptedInputBytes: (await status(id)).acceptedInputBytes + handshakeBytes,
    state: id === 'run-recipient' ? { type: 'exited', code: 0, signal: null } : { type: 'running' } }))
  inner.kernel.start = vi.fn(async () => ({ ...h.run('recovered-run'), acceptedInputBytes: 0 }))
  inner.kernel.input = vi.fn(async (id: string, operation: any) => {
    const result = await input(id, { ...operation, expectedByte: operation.expectedByte - handshakeBytes })
    if (loseInputAck) { loseInputAck = false; throw new Error('Original input ACK lost after applying its exact bytes') }
    return { ...result, appliedByteRange: { startByte: result.appliedByteRange.startByte + handshakeBytes, endByte: result.appliedByteRange.endByte + handshakeBytes },
      run: { ...result.run, acceptedInputBytes: result.run.acceptedInputBytes + handshakeBytes } }
  })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'binding'.padEnd(43, 'D'),
    endpoint: { url: 'http://127.0.0.1:0', token: 'endpoint'.padEnd(43, 'C') }, bindRun: async () => {}, close: async () => {} })
  const managedDispatch = options.deferManagedInput ? vi.spyOn(inner, 'deliverPostLaunchPrompt').mockResolvedValue(false) : undefined
  inner.probePreparedAgent = async () => ({ providerId, executable: providerId, installed: true, capabilities: provider.catalog.capabilities })
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxStoredAgentSession) => {
    if (options.nativeObservation) await inner.registry.update('recipient', session.run, (current: AgentMuxStoredAgentSession) => {
      const observedAt = Math.max(current.updatedAt + 1, Date.now())
      return { ...current, updatedAt: observedAt,
        ...(options.nativeObservation === 'changed' ? { observedNativeHandle: { kind: 'provider', providerId, sessionId: 'confirmed-foreign-native' } } : {}),
        nativeSourceObservation: { state: options.nativeObservation!, run: session.run, observedAt, reason: 'private-exact-source-observation' } }
    })
    if (options.newUserBeforeAutomatic) await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: session.run, afterSubmissionId: null,
      operationId: 'new-human-before-automatic', prompt: 'New original human task.' })
    if (!options.handshake) return session
    handshakeBytes = 5
    return await inner.registry.update('recipient', session.run, (current: AgentMuxStoredAgentSession) => ({ ...current,
      terminalHandshake: { operationId: 'original-handshake', run: session.run, inputByteRange: { startByte: 0, endByte: 5 }, acknowledged: true } }))
  }
  if (providerId === 'codex') {
    vi.spyOn(provider, 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
    vi.spyOn(provider as any, 'readPromptExecutionEvidence').mockImplementation(async () => ready ? { state: 'idle', id: 'native-idle', sourceId: 'native-file-original' } : null)
    vi.spyOn(provider as any, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  }
  const screen = vi.spyOn(inner.screenEvidence, 'wait')
  if (options.renderObservationUnavailable) screen.mockRejectedValue(new AgentMuxError('Private screen observation unavailable', 'AGENT_PROMPT_RENDER_TIMEOUT'))
  else screen.mockResolvedValue(1)
  await inner.registry.update('recipient', { runId: 'run-recipient' }, (session: AgentMuxStoredAgentSession) => {
    const observedAt = Math.max(session.updatedAt + 1, Date.now())
    return { ...session, updatedAt: observedAt, semanticStatus: { state: 'working', source: 'native-hook', observedAt } }
  })
  const original = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'original-continuity', trigger: options.managedDelivery ? 'input' as const : options.trigger ?? 'startup',
    ...(options.managedDelivery ? { input: { submissionId: 'managed-original-input', prompt: 'The original managed resume task.' } } : {}),
    policy: { reminderMode: options.reminder === false ? 'off' as const : 'default-plus-custom' as const, reminderAppend: 'Retain the original constraints.',
      continuationEnabled: options.continuation !== false, continuationPrompt: 'Continue the original task exactly.' } }
  const result = await h.client.ensureAgentContinuity(original)
  expect(result.kind).toBe('resumed')
  const operation = () => h.client.agentSession('recipient').continuityOperations!['original-continuity']!
  // Explicitly retained pre-marker packet: this is stored history, not a new
  // automatic recovery policy generating editable reminder/continuation content.
  // Preserve its original operation/key/body/parts and let today's owner consume it.
  if (original.trigger !== 'input' && (options.reminder !== false || options.continuation !== false)) {
    await inner.registry.update('recipient', { runId: 'recovered-run' }, (current: AgentMuxStoredAgentSession) => {
      const next = structuredClone(current), old = next.continuityOperations!['original-continuity']!
      const sha = (text: string) => createHash('sha256').update(text).digest('base64url')
      const key = { kind: 'prompt' as const, agentSessionId: old.agentSessionId, expectedRun: { ...old.newRun! },
        submissionId: 'continuity-' + sha(JSON.stringify([old.agentSessionId, old.operationId, old.newRun])) }
      const savedReminder = options.reminder === false ? '' : DEFAULT_AGENT_CONTINUITY_REMINDER + '\n\nRetain the original constraints.'
      const reminder = savedReminder ? `Session recovery context:\nAgent Session: recipient\nPrevious Run: run-recipient\nRecovery operation: original-continuity\nProvider native Session: ${providerId}/native-original\nInterrupted activity: working.\nRecovery evidence: run-ended\nPrevious typed input: none. Unknown earlier input is not replayed.\n\n${savedReminder}` : ''
      const continuation = options.continuation === false ? '' : 'Continue the original task exactly.'
      const part = (text: string) => ({ selected: Boolean(text), status: text ? 'waiting' as const : 'not-selected' as const, text, digest: sha(text) })
      const retained: AgentMuxContinuityOperation = { ...old, interruptedWorking: true, recoveryInputs: { reminder: savedReminder, continuation },
        recoveryDelivery: { context: { agentSessionId: old.agentSessionId, previousRun: { ...old.previousRun }, newRun: { ...old.newRun! },
          nativeTarget: structuredClone(old.nativeTarget!), interruptedWorking: true, runEvidence: structuredClone(old.evidence), previousInput: { scope: 'typed-prompt', outcome: 'none' } },
          key, initialInputByte: 0, phase: 'waiting', reason: 'retained-historical-input', observedAt: Date.now(), reminder: part(reminder), continuation: part(continuation) } }
      delete retained.interruption // This packet predates native interruption observations.
      next.continuityOperations![old.operationId] = retained
      if (next.continuity?.operationId === old.operationId) next.continuity = structuredClone(retained)
      return next
    })
    inner.recovery.continuityInputs.restore(inner.registry.list())
  }
  const wake = async () => { inner.recovery.continuityInputs.track(inner.registry.get('recipient')); await Promise.resolve() }
  return { ...h, inner, provider, original, operation, wake, managedDispatch, setReady: (value: boolean) => { ready = value },
    delivery: () => operation().recoveryDelivery!, input: inner.kernel.input,
    settle: async () => { await expect.poll(() => operation().recoveryDelivery?.phase).toBe('accepted') } }
}

async function anotherOwner(h: Awaited<ReturnType<typeof fixture>>) {
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path), providers: [{ ...h.provider }] }), inner = client as any
  await inner.registry.load('local'); inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.status = h.inner.kernel.status; inner.kernel.input = h.inner.kernel.input; inner.kernel.identity = h.inner.kernel.identity
  const provider = client.providers.get('codex')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
  vi.spyOn(provider as any, 'readPromptExecutionEvidence').mockResolvedValue({ state: 'idle', id: 'original-idle', sourceId: 'original-source' })
  vi.spyOn(provider as any, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
  return { client, inner, provider }
}

describe('retained historical continuity combined input consumer', () => {
  it.each(['claude', 'gemini'] as const)('retains the public first-prompt owner without optional native probes (%s)', async providerId => {
    const h = await fixture({ providerId })
    try {
      expect(h.provider.readPromptExecutionEvidence).toBeUndefined()
      expect(h.provider.verifyPromptExecutionTransport).toBeUndefined()
      await h.settle()
      const delivery = h.delivery(), record = await h.client.inspectAgentPromptSubmission(delivery.key)
      const prompt = composeAgentPrompt(delivery.continuation.text, delivery.reminder.text).text
      const originalPlan = h.provider.planPromptInput(prompt)
      expect(originalPlan.kind).toBe(providerId === 'claude' ? 'render-then-submit' : 'single-phase')
      expect(record?.admission).toMatchObject({ inputKey: delivery.key, acknowledged: true,
        intent: { prompt, plan: originalPlan, execution: 'default', admissionIntent: { kind: 'exact-condition', condition: { expectedRun: delivery.key.expectedRun, afterSubmissionId: null } },
          message: { userContent: delivery.continuation.text, systemContext: delivery.reminder.text } } })
      expect(record?.admission?.intent?.message?.authorHuman).toBeUndefined()
      expect(delivery.receipt).toMatchObject({ key: delivery.key, status: 'terminal-confirmed' })
      for (const part of [delivery.reminder, delivery.continuation]) expect(part).toMatchObject({ status: 'accepted', receiptRef: delivery.key })
      const actualBytes = h.input.mock.calls.map((call: any[]) => call[1].data)
      expect(actualBytes).toEqual(originalPlan.kind === 'single-phase' ? [originalPlan.data] : [originalPlan.payload, originalPlan.submit])
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps the original Claude rendering service window while its supported input completes', async () => {
    const h = await fixture({ providerId: 'claude', renderObservationUnavailable: true })
    try {
      await h.settle()
      const original = await h.client.inspectAgentPromptSubmission(h.delivery().key)
      expect(original?.terminalPromptSubmission).toMatchObject({ payload: { acknowledged: true }, submit: { acknowledged: true } })
      expect(h.client.agentSession('recipient').terminalPromptDelivery?.reason).toBe('prompt-render-timeout')
      expect(h.input).toHaveBeenCalledTimes(2); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(['claude', 'gemini'] as const)('does not replay an unknown input through the generic public owner (%s)', async providerId => {
    const h = await fixture({ providerId, loseInputAck: true })
    try {
      await expect.poll(() => h.delivery().phase).toBe('unknown')
      const frozen = structuredClone(h.delivery()), original = await h.client.inspectAgentPromptSubmission(frozen.key)
      expect(original?.admission?.acknowledged).not.toBe(true)
      const submitted = vi.spyOn(h.client, 'submitAgentPrompt')
      await h.wake(); await h.wake()
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      expect(submitted).not.toHaveBeenCalled(); expect(h.input).toHaveBeenCalledTimes(1)
      expect(h.delivery().key).toEqual(frozen.key)
    } finally { await h.close() }
  })

  it.each(['claude', 'gemini'] as const)('keeps a real new human prompt ahead of generic automatic recovery (%s)', async providerId => {
    const h = await fixture({ providerId, newUserBeforeAutomatic: true })
    try {
      await expect.poll(() => h.delivery().phase).toBe('superseded')
      expect(await h.client.inspectAgentPromptSubmission(h.delivery().key)).toBeNull()
      const human = await h.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, submissionId: 'new-human-before-automatic' })
      expect(human?.admission).toMatchObject({ acknowledged: true, intent: { message: { userContent: 'New original human task.' } } })
      expect(h.input).toHaveBeenCalledTimes(providerId === 'claude' ? 2 : 1)
    } finally { await h.close() }
  })

  it.each(['claude', 'gemini'] as const)('rejects a confirmed foreign process source while retaining the original native handle (%s)', async providerId => {
    const h = await fixture({ providerId, nativeObservation: 'changed' })
    try {
      expect(h.client.agentSession('recipient')).toMatchObject({ nativeSourceObservation: { state: 'changed' } })
      await expect.poll(() => h.delivery().phase).toBe('superseded')
      expect(h.client.agentSession('recipient')).toMatchObject({ nativeHandle: { sessionId: 'native-original' },
        observedNativeHandle: { sessionId: 'confirmed-foreign-native' }, nativeSourceObservation: { state: 'changed', run: { runId: 'recovered-run' } } })
      expect(await h.client.inspectAgentPromptSubmission(h.delivery().key)).toBeNull(); expect(h.input).not.toHaveBeenCalled()
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'user', data: 'ordinary input remains available' })
      expect(h.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(['unknown', 'ambiguous'] as const)('keeps an explicitly %s source observation from revoking the original first-prompt contract', async nativeObservation => {
    const h = await fixture({ providerId: 'claude', nativeObservation })
    try {
      expect(h.client.agentSession('recipient')).toMatchObject({ nativeSourceObservation: { state: nativeObservation } })
      await h.settle()
      expect(h.delivery().receipt?.status).toBe('terminal-confirmed')
      expect(h.input).toHaveBeenCalledTimes(2)
      expect(h.client.agentSession('recipient').nativeSourceObservation?.state).toBe(nativeObservation)
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'user', data: 'ordinary input remains available' })
      expect(h.input).toHaveBeenCalledTimes(3); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

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
      const frozen = structuredClone(h.delivery()), key = frozen.key
      const observed = await h.client.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, operationId: 'new-healthy-observation', trigger: 'startup' })
      expect(observed).toMatchObject({ kind: 'reattachable', evidence: { kind: 'run-running' }, continuity: { operationId: 'original-continuity' } })
      expect(h.client.agentSession('recipient').continuity!.operationId).toBe('original-continuity')
      expect(h.client.agentSession('recipient').continuityOperations!['new-healthy-observation']).toBeUndefined()
      await h.wake(); await h.wake()
      expect(h.inner.kernel.input).toHaveBeenCalledTimes(1)
      expect(submitted).toHaveBeenCalledTimes(1)
      expect(h.delivery().key).toEqual(key); expect(h.delivery().phase).toBe('unknown')
      const record = await h.client.inspectAgentPromptSubmission(key)
      expect(record?.admission?.acknowledged).not.toBe(true)
      expect(record?.admission?.intent?.prompt).toBe(composeAgentPrompt(frozen.continuation.text, frozen.reminder.text).text)
      expect(h.delivery().reminder.text).toBe(frozen.reminder.text); expect(h.delivery().continuation.text).toBe(frozen.continuation.text)
      expect((await h.client.readAgentSessions())[0]).toMatchObject({ run: key.expectedRun, continuity: { operationId: 'original-continuity' } })
    } finally { await h.close() }
  })

  it('restores the exact frozen original phase after disposing the actual client and store owner', async () => {
    const h = await fixture({ ready: false })
    let next: AgentMuxClient | undefined
    try {
      const frozen = structuredClone(h.delivery())
      const observed = await h.client.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, operationId: 'healthy-shadow', trigger: 'startup' })
      expect(observed).toMatchObject({ kind: 'reattachable', evidence: { kind: 'run-running' }, continuity: { operationId: 'original-continuity' } })
      await h.client.dispose()
      const store = new AgentMuxFileAgentSessionStore(h.store.path)
      next = new AgentMuxClient({ store })
      const inner = next as any
      await inner.registry.load('local'); inner.connected = true
      inner.kernel.isConnected = () => true; inner.kernel.status = h.inner.kernel.status; inner.kernel.input = h.inner.kernel.input; inner.kernel.identity = h.inner.kernel.identity
      const provider = next.providers.get('codex')
      vi.spyOn(provider, 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
      vi.spyOn(provider as any, 'readPromptExecutionEvidence').mockResolvedValue({ state: 'idle', id: 'original-idle', sourceId: 'original-source' })
      vi.spyOn(provider as any, 'verifyPromptExecutionTransport').mockResolvedValue(true)
      vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
      // Same production restore entry invoked after Runtime/Store observation on connect.
      inner.recovery.continuityInputs.restore(inner.registry.list())
      await expect.poll(() => next!.agentSession('recipient').continuityOperations!['original-continuity']!.recoveryDelivery?.phase).toBe('accepted')
      expect(h.input).toHaveBeenCalledTimes(1)
      const recovered = next.agentSession('recipient').continuityOperations!['original-continuity']!.recoveryDelivery!
      expect(recovered.key).toEqual(frozen.key); expect(recovered.reminder.text).toBe(frozen.reminder.text); expect(recovered.continuation.text).toBe(frozen.continuation.text)
      expect(next.agentSession('recipient').continuity!.operationId).toBe('original-continuity')
      expect(next.agentSession('recipient').continuityOperations!['healthy-shadow']).toBeUndefined()
      const record = await next.inspectAgentPromptSubmission(frozen.key)
      expect(record?.admission?.acknowledged).toBe(true)
      expect(record?.admission?.intent?.prompt).toBe(composeAgentPrompt(frozen.continuation.text, frozen.reminder.text).text)
      expect((await next.readAgentSessions())[0]).toMatchObject({ run: frozen.key.expectedRun, continuity: { operationId: 'original-continuity' } })
    } finally { await next?.dispose(); await h.close() }
  })

  it('does not dispatch twice when a stale second owner returns after an unconfirmed call', async () => {
    const h = await fixture({ ready: false }), second = await anotherOwner(h)
    let release!: () => void
    try {
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      const entered = Promise.withResolvers<void>(), gate = new Promise<void>(resolve => { release = resolve })
      vi.mocked(second.provider.verifyPromptExecutionTransport!).mockImplementation(async () => { entered.resolve(); await gate; return true })
      const secondSubmit = vi.spyOn(second.client, 'submitAgentPrompt')
      second.inner.recovery.continuityInputs.restore(second.inner.registry.list())
      await entered.promise
      // A possibly executing call without an ACK cannot be handed to another observer.
      const firstSubmit = vi.spyOn(h.client, 'submitAgentPrompt').mockRejectedValue(new Error('dispatch response unconfirmed'))
      h.setReady(true); await h.wake()
      await expect.poll(() => h.delivery().phase).toBe('unknown')
      release()
      await expect.poll(() => second.inner.recovery.continuityInputs.tails.size).toBe(0)
      expect(firstSubmit).toHaveBeenCalledTimes(1); expect(secondSubmit).not.toHaveBeenCalled()
      expect(h.input).not.toHaveBeenCalled()
      expect((await h.store.readMetadata('recipient'))!.continuityOperations!['original-continuity']!.recoveryDelivery!.phase).toBe('unknown')
    } finally { release?.(); await second.client.dispose(); await h.close() }
  })

  it('cannot use an actual different-body ACK on the same key to accept frozen parts', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
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
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
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
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      const entered = Promise.withResolvers<void>(), observation = Promise.withResolvers<any>()
      const submitted = vi.spyOn(h.client, 'submitAgentPrompt')
      vi.mocked(h.provider.readPromptExecutionEvidence!).mockImplementation(async () => { entered.resolve(); return await observation.promise })
      await h.wake(); await entered.promise
      await h.client.dispose()
      observation.resolve({ state: 'idle', id: 'late-idle', sourceId: 'original-source' })
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      expect(submitted).not.toHaveBeenCalled()
      expect(h.delivery().phase).toBe('waiting'); expect(h.input).not.toHaveBeenCalled()
      expect((await h.store.readMetadata('recipient'))!.continuityOperations!['original-continuity']!.recoveryDelivery!.key).toEqual(h.delivery().key)
    } finally { await h.close() }
  })

  it('does not send recovery input to a changed native conversation', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
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
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      vi.mocked(h.provider.readPromptExecutionEvidence!).mockResolvedValue({ state: 'working', sourceId: 'native-original', id: 'still-native-working' })
      await h.wake()
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      expect(h.delivery().phase).toBe('waiting'); expect(h.input).not.toHaveBeenCalled()
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'user', data: 'ordinary working turn input' })
      expect(h.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('preserves a declared negative native transport result without revoking ordinary input', async () => {
    const h = await fixture({ ready: false })
    try {
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      vi.mocked(h.provider.verifyPromptExecutionTransport!).mockResolvedValue(false)
      h.setReady(true); await h.wake()
      await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
      expect(h.delivery().phase).toBe('waiting'); expect(h.input).not.toHaveBeenCalled()
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'recovered-run' }, source: 'user', data: 'ordinary input remains available' })
      expect(h.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
})

it('freezes a managed post-launch carrier before Start and confirms its original receipt rather than the old argv capability', async () => {
  const h = await fixture({ managedDelivery: true })
  try {
    const operation = h.operation(), launch = operation.launchInput!
    expect(launch).toMatchObject({ delivery: 'post-launch', state: 'terminal-confirmed',
      input: { submissionId: 'managed-original-input', prompt: 'The original managed resume task.' },
      key: { expectedRun: { runId: 'recovered-run' }, submissionId: 'managed-original-input' } })
    expect(h.inner.kernel.start).toHaveBeenCalledOnce()
    expect(h.inner.kernel.start.mock.calls[0]![0].args).not.toContain(launch.prompt)
    const receipt = await h.client.inspectAgentPromptSubmission(launch.key!)
    expect(receipt?.admission).toMatchObject({ inputKey: launch.key, acknowledged: true, intent: { prompt: launch.prompt, message: launch.message } })
    expect(receipt?.admission?.transport).not.toBe('native')
    expect(h.input).toHaveBeenCalledOnce()
    expect((await h.store.readMetadata('recipient'))!.continuityOperations?.[operation.operationId]?.launchInput).toEqual(launch)
    await h.client.ensureAgentContinuity(h.original)
    expect(h.inner.kernel.start).toHaveBeenCalledOnce(); expect(h.input).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it('preserves prepared input with no claim and never turns an old unknown plan without a receipt into a new dispatch', async () => {
  const h = await fixture({ managedDelivery: true, deferManagedInput: true })
  try {
    const launch = h.operation().launchInput!
    expect(launch.state).toBe('prepared')
    expect(await h.client.inspectAgentPromptSubmission(launch.key!)).toBeNull()
    expect(h.input).not.toHaveBeenCalled()
    await h.inner.registry.update('recipient', { runId: 'recovered-run' }, (value: AgentMuxStoredAgentSession) => {
      const operation = value.continuityOperations!['original-continuity']!
      const retained = { ...operation, launchInput: { ...operation.launchInput!, state: 'unknown' as const } }
      return { ...value, continuity: retained, continuityOperations: { ...value.continuityOperations, [retained.operationId]: retained } }
    })
    const attempts = h.managedDispatch!.mock.calls.length
    await h.client.ensureAgentContinuity(h.original)
    expect(h.managedDispatch).toHaveBeenCalledTimes(attempts)
    expect(h.operation().launchInput?.state).toBe('unknown')
    expect(await h.client.inspectAgentPromptSubmission(launch.key!)).toBeNull()
    expect(h.input).not.toHaveBeenCalled(); expect(h.inner.kernel.start).toHaveBeenCalledOnce()
  } finally { await h.close() }
})
