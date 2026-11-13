import { afterEach, expect, it, vi } from 'vitest'
import { parseAgentInputSubmissionReceipt } from '../src/agent-input-receipt-codec.js'
import type { AgentHookBinding } from '../src/hook-server.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

/**
 * A Mote's first question used to be typed into Claude's "trust this folder?" prompt and pick
 * "No, exit". Claude reports its native conversation start through Hooks, so a queued input now
 * waits for the first Hook of its current Run. When the start cannot be observed (no declared
 * start event, no live Hook binding) nothing is held back and the original terminal path applies.
 */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

type Inner = { hookBindings: Map<string, AgentHookBinding>; registry: { refresh(id: string, run: { runId: string }): Promise<unknown> }; publishSession(session: AgentMuxStoredAgentSession): void }

async function fixture(providerId: 'claude' | 'codex') {
  const h = await rpcOwnerFixture(['caller', 'recipient'], undefined, () => ({ providerId, executorId: providerId }))
  const inner = h.client as unknown as Inner
  inner.hookBindings.set('run-recipient', { bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) },
    bindRun: async () => {}, close: async () => {} } as unknown as AgentHookBinding)
  ;(inner as unknown as { hookBindingActivatedAt: Map<string, number> }).hookBindingActivatedAt.set('run-recipient', Date.now())
  const submit = (operationId: string) => h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
    operationId, prompt: 'Human first question', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  // Write a native fact as Core's Hook owner does, then publish it through the same Session event.
  const startNative = async (patch: (at: number) => Partial<AgentMuxStoredAgentSession>) => {
    const current = (await h.store.readMetadata('recipient'))!, at = current.updatedAt + 1
    await h.store.compareAndSwapMetadata(current, { ...current, ...patch(at), updatedAt: at })
    await inner.registry.refresh('recipient', current.run)
    inner.publishSession((inner.registry as unknown as { get(id: string): AgentMuxStoredAgentSession }).get('recipient'))
  }
  const inputs = () => (h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length + h.rawInput.mock.calls.length
  return { ...h, inner, submit, startNative, inputs }
}

it('holds a first input until the Run reports its native start, then sends it once', async () => {
  const f = await fixture('claude')
  try {
    const receipt = await f.submit('first-question')
    expect(receipt).toMatchObject({ status: 'waiting' })
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient',
      expectedRun: { runId: 'run-recipient' }, submissionId: 'first-question' } }))?.control.waiting).toMatchObject({ phase: 'session', reason: 'native-session-starting' }))
    expect(f.inputs()).toBe(0)
    // The first authenticated Hook of this Run proves the native conversation started.
    await f.startNative(at => ({ hookReceipt: { id: 'session-start-receipt', providerId: 'claude', agentSessionId: 'recipient', run: { runId: 'run-recipient' },
      eventName: 'SessionStart', observedAt: at } }))
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 10_000 })
  } finally { await f.close() }
})

it('does not hold input for a Provider without a declared native start event', async () => {
  const f = await fixture('codex')
  try {
    await f.submit('codex-question')
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 10_000 })
  } finally { await f.close() }
})

it('does not hold input when the Run has no live Hook binding, because its start cannot be observed', async () => {
  const f = await fixture('claude')
  f.inner.hookBindings.clear()
  try {
    await f.submit('unobservable-start')
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 10_000 })
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

it('releases a held input once the start window passes without any Hook, keeping the healthy Run usable', async () => {
  const f = await fixture('claude')
  const inner = f.inner as unknown as { hookBindingActivatedAt: Map<string, number> }
  try {
    inner.hookBindingActivatedAt.set('run-recipient', Date.now())
    await f.submit('no-hook-ever')
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'no-hook-ever' }
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    expect(f.inputs()).toBe(0)
    // The Run has been bound longer than the window: its start is unknown, so the input is not held.
    inner.hookBindingActivatedAt.set('run-recipient', Date.now() - 121_000)
    await f.startNative(at => ({ updatedAt: at }))
    await vi.waitFor(() => expect(f.inputs()).toBeGreaterThan(0), { timeout: 10_000 })
  } finally { await f.close() }
})
