import { afterEach, expect, it, vi } from 'vitest'
import { parseAgentInputSubmissionReceipt } from '../src/agent-input-receipt-codec.js'
import type { AgentHookBinding } from '../src/hook-server.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

/** Original automatic input stays saved until a positive conversation/input fact exists.
 * A missing observer or elapsed observation budget cannot grant TTY input authorization. */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

type Inner = { hookBindings: Map<string, AgentHookBinding>; kernel: Record<string, unknown>; registry: { refresh(id: string, run: { runId: string }): Promise<unknown> }; publishSession(session: AgentMuxStoredAgentSession): void }

async function fixture(providerId: 'claude' | 'codex', nativeTransport = false) {
  const h = await rpcOwnerFixture(['caller', 'recipient'], undefined, () => ({ providerId, executorId: providerId }))
  const inner = h.client as unknown as Inner
  // Exercise the supported legacy terminal form independently of the native transport form.
  const provider = h.client.providers.get(providerId), originalPrepare = provider.prepareNativeInput
  if (!nativeTransport) delete provider.prepareNativeInput
  const close = async () => { if (originalPrepare) provider.prepareNativeInput = originalPrepare; else delete provider.prepareNativeInput; await h.close() }
  inner.hookBindings.set('run-recipient', { bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) },
    bindRun: async () => {}, close: async () => {} } as unknown as AgentHookBinding)
  const submit = (operationId: string) => h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
    operationId, prompt: 'Human first question', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  // Write a native fact as Core's Hook owner does, then publish it through the same Session event.
  const startNative = async (patch: (at: number) => Partial<AgentMuxStoredAgentSession>) => {
    const current = (await h.store.readMetadata('recipient'))!, at = current.updatedAt + 1
    await h.store.compareAndSwapMetadata(current, { ...current, ...patch(at), updatedAt: at })
    await inner.registry.refresh('recipient', current.run)
    inner.publishSession((inner.registry as unknown as { get(id: string): AgentMuxStoredAgentSession }).get('recipient'))
  }
  const inputs = () => (h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length + h.rawInput.mock.calls.length
  return { ...h, close, inner, submit, startNative, inputs }
}

it('holds a first input until an exact main native conversation witness, then sends it once', async () => {
  const f = await fixture('claude')
  try {
    const receipt = await f.submit('first-question')
    expect(receipt).toMatchObject({ status: 'waiting' })
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient',
      expectedRun: { runId: 'run-recipient' }, submissionId: 'first-question' } }))?.control.waiting).toMatchObject({ phase: 'session', reason: 'native-session-starting' }))
    // An unrelated Session publication settles the waiter's observed target first, as status updates do in the product.
    await f.startNative(at => ({ updatedAt: at }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(f.inputs()).toBe(0)
    // A bare first receipt is not a native conversation witness.
    await f.startNative(at => ({ hookReceipt: { id: 'session-start-receipt', providerId: 'claude', agentSessionId: 'recipient', run: { runId: 'run-recipient' },
      eventName: 'SessionStart', observedAt: at } }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(f.inputs()).toBe(0)
    await f.startNative(at => ({ nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-started' }, nativeBinding: { source: 'native-hook', run: { runId: 'run-recipient' }, observedAt: at } }))
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 5_000 })
  } finally { await f.close() }
})

it('does not treat an unknown native source observation as the end of setup', async () => {
  const f = await fixture('claude')
  try {
    await f.submit('observed-first')
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient',
      expectedRun: { runId: 'run-recipient' }, submissionId: 'observed-first' } }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    await f.startNative(at => ({ updatedAt: at }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(f.inputs()).toBe(0)
    await f.startNative(at => ({ nativeSourceObservation: { state: 'unknown', run: { runId: 'run-recipient' }, observedAt: at, reason: 'current-main-unconfirmed' } }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(f.inputs()).toBe(0)
  } finally { await f.close() }
})

it('holds input for a resume whose native target the user selected before any Hook', async () => {
  const f = await fixture('claude')
  try {
    await f.startNative(at => ({ nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'claude-native-chosen' }, nativeBinding: { source: 'user-selected', run: { runId: 'run-recipient' }, observedAt: at } }))
    await f.submit('selected-target')
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient',
      expectedRun: { runId: 'run-recipient' }, submissionId: 'selected-target' } }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    expect(f.inputs()).toBe(0)
  } finally { await f.close() }
})

it('does not hold input for a Provider without a declared native start event', async () => {
  const f = await fixture('codex')
  try {
    await f.submit('codex-question')
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 10_000 })
  } finally { await f.close() }
})

it('retains a new lifecycle Run without a native start protocol instead of assuming its terminal is ready', async () => {
  const f = await fixture('codex')
  f.inner.hookBindings.clear()
  try {
    await f.startNative(at => ({ creation: { createOperationId: 'original-create', createdRun: { runId: 'run-recipient' }, initialPrompt: 'not-requested' }, updatedAt: at }))
    await f.submit('new-run-no-native-start-protocol')
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'new-run-no-native-start-protocol' } }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    expect(f.inputs()).toBe(0)
  } finally { await f.close() }
})

it('retains automatic input when the Hook binding is missing, preserving manual terminal input', async () => {
  const f = await fixture('claude')
  f.inner.hookBindings.clear()
  try {
    await f.submit('unobservable-start')
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'unobservable-start' } }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    expect(f.inputs()).toBe(0)
    await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'explicit-tty', prompt: 'User chose this terminal', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 5_000 })
  } finally { await f.close() }
})

it('does not hold input once a resumed native binding was confirmed by this Run, but does for a pre-start resume target', async () => {
  const f = await fixture('claude')
  try {
    await f.startNative(at => ({ nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'claude-native-original' }, nativeBinding: { source: 'semantic-resume-target', run: { runId: 'run-recipient' }, observedAt: at } }))
    await f.submit('resume-target-only')
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient',
      expectedRun: { runId: 'run-recipient' }, submissionId: 'resume-target-only' } }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    expect(f.inputs()).toBe(0)
    await f.startNative(at => ({ nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'claude-native-original' }, nativeBinding: { source: 'native-hook', run: { runId: 'run-recipient' }, observedAt: at } }))
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 10_000 })
  } finally { await f.close() }
})

it('round-trips the waiting reason through the public receipt codec, and refuses one carrying a failure', async () => {
  const f = await fixture('claude')
  try {
    await f.submit('codec-question')
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'codec-question' }
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    const receipt = JSON.parse(JSON.stringify(await f.client.inspectAgentInput({ key })))
    expect(parseAgentInputSubmissionReceipt(receipt).control.waiting).toEqual({ phase: 'session', reason: 'native-session-starting', wake: 'session-restored' })
    receipt.control.waiting.failure = { code: 'X', message: 'x', disposition: 'not_applied' }
    expect(() => parseAgentInputSubmissionReceipt(receipt)).toThrow()
  } finally { await f.close() }
})

it('keeps the original automatic input after 120 seconds without inventing native readiness', async () => {
  const f = await fixture('claude')
  try {
    await f.submit('no-hook-ever')
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'no-hook-ever' }
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 240_000)
    try {
      await f.startNative(at => ({ updatedAt: at }))
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(f.inputs()).toBe(0)
      expect((await f.client.inspectAgentInput({ key }))?.key).toEqual(key)
    } finally { clock.mockRestore() }
  } finally { await f.close() }
})

it('lets the exact native input owner qualify its healthy transport without auxiliary Hooks', async () => {
  const f = await fixture('claude', true)
  const provider = f.client.providers.get('claude'), originalPrepare = provider.prepareNativeInput
  const send = vi.fn(async () => ({ outcome: 'admitted' as const, turnId: 'native-turn' }))
  const prepare = vi.fn(async (_context, selected) => ({
    plan: { kind: 'native-rpc' as const, protocolId: 'fixture-native', sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]),
      actorId: 'fixture-actor', threadId: selected.nativeSessionId, operation: 'start-or-steer' as const },
    assertCurrent: async () => {}, send, dispose: async () => {},
  }))
  provider.prepareNativeInput = prepare
  f.inner.hookBindings.clear()
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 1234 }))
  try {
    await f.startNative(at => ({ nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native' },
      nativeBinding: { source: 'user-selected', run: { runId: 'run-recipient' }, observedAt: at },
      nativeSourceObservation: { state: 'unknown', run: { runId: 'run-recipient' }, observedAt: at, reason: 'optional-observer-unavailable' } }))
    await f.submit('healthy-native-no-hook')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ processId: 1234 }), { providerId: 'claude', nativeSessionId: 'original-native' })
    expect(f.inputs()).toBe(0)
  } finally { if (originalPrepare) provider.prepareNativeInput = originalPrepare; else delete provider.prepareNativeInput; await f.close() }
})
