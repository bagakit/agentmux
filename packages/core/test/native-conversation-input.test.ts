import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentProvider, AgentProviderPreparedNativeInput } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxRpcService as SourceRpcService } from '../src/public-rpc-service.js'
const AgentMuxRpcService: typeof SourceRpcService = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
  ? (await import(new URL('../dist/public-rpc-service.js', import.meta.url).href)).AgentMuxRpcService : SourceRpcService
import { agentTurnCompletionIdentity, cloneSession } from '../src/agent-session-identity.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js';
import { parseRpcAgentSession } from "../src/agent-session-codec.js";
import { parsePromptSubmissionRecord } from '../src/prompt-submission-record.js'
import { agentPromptCondition, validateAgentPromptAdmissionIntent, validateAgentPromptInputBinding, type AgentPromptInputKey } from '../src/agent-prompt-condition.js'
import { parseAgentInputMailboxPage } from '../src/agent-input-mailbox-codec.js'
import { AgentMuxError } from '../src/errors.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const target = { providerId: 'codex', nativeSessionId: 'selected-original-thread' }
const actor = { protocolId: 'fixture-native-protocol', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
const key = (submissionId: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId })
const input = (operationId: string) => ({ agentSessionId: 'recipient', operationId, expectedRun: { runId: 'run-recipient' },
  admissionIntent: { kind: 'native-conversation' as const, source: target }, execution: 'immediate' as const, prompt: 'Original selected-source input', authorHuman: true })
async function owner(outcome: 'admitted' | 'unknown' | 'not-applied' = 'admitted', ids = ['recipient'], interactionQueue = false) {
  const h = await rpcOwnerFixture(ids); closes.push(h.close)
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(original, { ...original, nativeActor: actor }); await h.inner.registry.load('local')
  h.inner.kernel.status = vi.fn(async (runId: string) => ({ ...h.run(runId), pid: 1234 }))
  const inner = h.client as unknown as { providers: { get(id: string): AgentProvider } }
  const send = vi.fn<AgentProviderPreparedNativeInput['send']>(async (_prompt, plan) => {
    const token = JSON.parse(Buffer.from(plan.clientCorrelation!.split('.')[1]!, 'base64url').toString('utf8'))
    const persisted = await new AgentMuxFileAgentSessionStore(h.store.path).readPromptAdmission('recipient', { runId: 'run-recipient' }, token.key.submissionId ?? token.key.messageId)
    expect(persisted?.admission?.intent?.plan).toEqual(plan)
    expect(persisted?.admission?.inputKey).toEqual(token.key)
    expect(plan.clientCorrelation).toMatch(/^amux-input-v1\./u); expect(token.nonce).toHaveLength(32)
    if (outcome === 'unknown') throw new Error('The native request ACK was lost after send')
    if (outcome === 'not-applied') return { outcome, errorCode: -32600 }
    return { outcome, ...(plan.operation === 'queue-idle' ? { queuedSubmissionId: 'original-native-queue-item' } : { turnId: 'original-native-turn' }) }
  })
  const prepare = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (context, selected) => {
    expect(context.nativeActor).toEqual(actor); expect(context.processId).toBe(1234)
    if (selected.providerId !== target.providerId || selected.nativeSessionId !== target.nativeSessionId) throw new AgentMuxError('Exact source is not loaded by this original actor', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
    return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), actorId: actor.actorId,
      threadId: selected.nativeSessionId, ...(interactionQueue ? { interactionQueue: true as const } : {}), ...(selected.idleOnly ? { operation: 'queue-idle' } : selected.expectedTurnId ? { operation: 'steer', expectedTurnId: selected.expectedTurnId } : { operation: 'start-or-steer' }) }, assertCurrent: vi.fn(async () => {}), send, dispose: vi.fn() }
  })
  const provider = inner.providers.get('codex')
  const originalPrepare = provider.prepareNativeInput, originalPlan = provider.planPromptInput
  // Some cases remove the port entirely; restore the shared contribution before the next owner is built.
  closes.push(async () => {
    if (originalPrepare) provider.prepareNativeInput = originalPrepare
    else delete provider.prepareNativeInput
    provider.planPromptInput = originalPlan
  })
  provider.prepareNativeInput = prepare
  // Deterministic Provider byte port for coordinator tests; the native binary E2E uses its real TUI renderer.
  provider.planPromptInput = prompt => ({ kind: 'single-phase', data: prompt + '\r' })
  return { ...h, send, prepare }
}

async function retainOriginalRequest(h: Awaited<ReturnType<typeof owner>>) {
  const original = (await h.store.readMetadata('recipient'))!
  // Missing native call identity is intentionally retained; an unrelated input must not settle it.
  const pendingInteraction: NonNullable<AgentMuxStoredAgentSession['pendingInteraction']> = { request: {
    kind: 'permission', id: 'unconfirmed-original-request', agentSessionId: 'recipient', title: 'Original request',
    toolName: 'tool', toolInput: '{}', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: 1, run: original.run, hookReceiptId: 'original-hook' }
  } }
  await h.store.compareAndSwapMetadata(original, { ...original,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId }, pendingInteraction })
  await h.inner.registry.load('local')
  return pendingInteraction
}

async function waitingForOriginalRequest(h: Awaited<ReturnType<typeof owner>>, submissionId: string) {
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key(submissionId) }))?.control.waiting).toMatchObject({
    wake: 'explicit-rejoin', failure: { code: 'AGENT_INTERACTION_PENDING' }
  })
  expect(await h.client.inspectAgentPromptSubmission(key(submissionId))).toBeNull()
}

it.each(['native-conversation', 'session-conversation'] as const)('preserves the pending request while a fresh %s queue input becomes unknown, frees its lane and never replays', async kind => {
  const h = await owner('unknown', ['recipient'], true), pending = await retainOriginalRequest(h)
  const request = (id: string) => ({ ...input(id), admissionIntent: kind === 'native-conversation'
    ? input(id).admissionIntent : { kind: 'session-conversation' as const } })
  await h.client.submitAgentPrompt(request('pending-native-first'))
  const first = await settledNative(h, key('pending-native-first'), 'unknown')
  expect(first?.admission).toMatchObject({ acknowledged: false, transport: 'native',
    native: { outcome: 'unknown', plan: { interactionQueue: true, operation: 'start-or-steer' } } })
  expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(pending)
  // A new operation cannot be starved behind an uncertain old native dispatch.
  await h.client.submitAgentPrompt(request('pending-native-second'))
  await settledNative(h, key('pending-native-second'), 'unknown')
  expect(h.send).toHaveBeenCalledTimes(2)
  expect(h.send.mock.calls[0]![1].clientCorrelation).not.toBe(h.send.mock.calls[1]![1].clientCorrelation)
  expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(pending)
  expect(await h.client.submitAgentPrompt(request('pending-native-first'))).toMatchObject({ status: 'unknown' })
  expect(await h.client.inspectAgentPromptSubmission(key('pending-native-first'))).toEqual(first)
  expect(h.send).toHaveBeenCalledTimes(2)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.rawInput).not.toHaveBeenCalled()
  // The healthy original terminal remains independently writable after that lane is released.
  await h.client.writeTerminalBytes(key('unused').expectedRun, 'x')
  expect(h.rawInput).toHaveBeenCalledWith('run-recipient', 'x')
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a native method and published capability alone cannot bypass the original request without a prepared queue qualifier', async () => {
  const h = await owner(), pending = await retainOriginalRequest(h)
  const provider = (h.client as unknown as { providers: { get(id: string): AgentProvider } }).providers.get('codex')
  const originalCapability = provider.catalog.capabilities.nativeConversationInput
  closes.push(async () => {
    if (originalCapability) provider.catalog.capabilities.nativeConversationInput = originalCapability
    else delete provider.catalog.capabilities.nativeConversationInput
  })
  provider.catalog.capabilities.nativeConversationInput = { managedRuns: true, interactionQueue: true }
  await h.client.submitAgentPrompt(input('pending-no-qualifier'))
  await waitingForOriginalRequest(h, 'pending-no-qualifier')
  expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.send).not.toHaveBeenCalled()
  expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(pending)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['manual-actor', 'non-human', 'exact-turn'] as const)('the queue qualifier cannot convert %s input into fresh manual permission-independent input', async mode => {
  const h = await owner('admitted', ['recipient'], true), pending = await retainOriginalRequest(h)
  const request = { ...input('pending-ineligible-' + mode),
    ...(mode === 'manual-actor' ? { admissionIntent: { kind: 'manual-actor' as const } } : {}),
    ...(mode === 'non-human' ? { authorHuman: false } : {}),
    ...(mode === 'exact-turn' ? { admissionIntent: { ...input('unused').admissionIntent, expectedTurnId: 'original-turn' } } : {}) }
  await h.client.submitAgentPrompt(request)
  await waitingForOriginalRequest(h, request.operationId)
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(pending)
  if (mode === 'manual-actor') {
    expect(h.prepare).not.toHaveBeenCalled()
    // Reusing the old input key with another transport is a conflict, not a new Send.
    await expect(h.client.submitAgentPrompt(input(request.operationId))).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(h.send).not.toHaveBeenCalled()
  }
})

it('refuses an unsupported private idle-only restriction on controlled input instead of dropping it', async () => {
  const h = await owner('admitted', ['recipient'], true), pending = await retainOriginalRequest(h)
  await expect(h.client.submitAgentPrompt(input('pending-controlled-idle-only'), { nativeIdleOnly: true }))
    .rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(await h.client.inspectAgentPromptSubmission(key('pending-controlled-idle-only'))).toBeNull()
  expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(pending)
})

it.each([false, true])('keeps exact default input pending with a prepared queue qualifier and idle-only=%s', async nativeIdleOnly => {
  const h = await owner('admitted', ['recipient'], true), pending = await retainOriginalRequest(h)
  await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId: 'pending-exact-idle-' + nativeIdleOnly,
    expectedRun: key('unused').expectedRun, afterSubmissionId: null, prompt: 'Original automatic/default input', authorHuman: true },
    nativeIdleOnly ? { nativeIdleOnly: true } : undefined)).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(pending)
})

it('strictly decodes published interaction and idle queue capabilities without accepting invented fields or truthy values', async () => {
  const h = await owner(), provider = (h.client as unknown as { providers: { get(id: string): AgentProvider } }).providers.get('codex')
  const result = (nativeConversationInput: unknown) => ({ hostId: 'local', executorId: 'codex', providerId: 'codex',
    capabilities: { ...provider.catalog.capabilities, nativeConversationInput }, availability: 'available', sessions: [], issues: [] })
  const decode = (nativeConversationInput: unknown) => parseRpcNativeResult('agent.native.ls', result(nativeConversationInput), { hostId: 'local', executorId: 'codex' })
  for (const idleQueue of [false, true]) expect(decode({ managedRuns: true, interactionQueue: true, idleQueue })).toEqual(result({ managedRuns: true, interactionQueue: true, idleQueue }))
  expect(decode({ managedRuns: true })).toEqual(result({ managedRuns: true }))
  for (const invalid of [{ managedRuns: true, interactionQueue: false }, { managedRuns: true, interactionQueue: 1 },
    { managedRuns: true, idleQueue: 'false' }, { managedRuns: true, idleQueue: null },
    { managedRuns: true, interactionQueue: true, inferred: true }]) expect(() => decode(invalid)).toThrow()
})

it('preserves a durable native plan queue qualifier and strictly rejects false or unknown qualifier data', async () => {
  const h = await owner('unknown', ['recipient'], true)
  await h.client.submitAgentPrompt(input('strict-queue-plan'))
  const original = (await settledNative(h, key('strict-queue-plan'), 'unknown'))!
  expect(parsePromptSubmissionRecord(original)).toEqual(original)
  const reopened = new AgentMuxFileAgentSessionStore(h.store.path)
  expect(await reopened.readPromptAdmission('recipient', key('strict-queue-plan').expectedRun, 'strict-queue-plan')).toEqual(original)
  const decode = (change: Record<string, unknown>) => {
    const value = structuredClone(original)
    Object.assign((value.admission!.intent!.plan as unknown as Record<string, unknown>), change)
    const admission = value.admission!
    if (admission.transport === 'native') Object.assign(admission.native.plan, change)
    return () => parsePromptSubmissionRecord(value)
  }
  expect(decode({ interactionQueue: false })).toThrow()
  expect(decode({ interactionQueue: 'true' })).toThrow()
  expect(decode({ implicitPermissionAnswer: true })).toThrow()
  expect(h.send).toHaveBeenCalledTimes(1)
})

it('keeps the actual Claude reference notification on its turn-end path when ordinary native input has no idle-only queue', async () => {
  const h = await rpcOwnerFixture(['sender', 'recipient'], undefined, () => ({ providerId: 'claude', executorId: 'claude' }))
  closes.push(h.close)
  const provider = (h.client as unknown as { providers: { get(id: string): AgentProvider } }).providers.get('claude')
  expect(provider.prepareNativeInput).toBeDefined()
  expect(provider.catalog.capabilities.nativeConversationInput).toMatchObject({ interactionQueue: true, idleQueue: false })
  await h.client.submitAgentMessage({ agentSessionId: 'recipient', caller: h.credentials,
    envelope: { schema: 'agentmux.a2a.v1', messageId: 'claude-reference-notice', operationId: 'claude-reference-send', createdAt: 1,
      sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      senderSessionId: 'sender', senderRunId: 'run-sender', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
      threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: 'Original reference body' } })
  expect((await h.client.readMessage({ messageId: 'claude-reference-notice', caller: h.credentials }))?.notification)
    .toEqual({ state: 'pending', automatic: 'turn-end' })
  expect(await h.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: 'claude-reference-notice' })).toBeNull()
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.rawInput).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

async function settledNative(h: Awaited<ReturnType<typeof owner>>, inputKey: AgentPromptInputKey, outcome: 'admitted' | 'unknown' | 'not-applied') {
  await expect.poll(async () => {
    const claim = (await h.client.inspectAgentPromptSubmission(inputKey))?.admission
    return claim?.transport === 'native' ? claim.native.outcome : undefined
  }).toBe(outcome)
  return await h.client.inspectAgentPromptSubmission(inputKey)
}

async function unavailableInput(h: Awaited<ReturnType<typeof owner>>, submissionId: string) {
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key(submissionId) }))?.control.waiting).toMatchObject({
    phase: 'input-environment', wake: 'explicit-rejoin', failure: { code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' }
  })
  expect(await h.client.inspectAgentPromptSubmission(key(submissionId))).toBeNull()
}

it('freezes exact native input key and correlation in the original durable claim before dispatch; receipt-only retries never send', async () => {
  const h = await owner()
  await h.client.submitAgentPrompt(input('first-native'))
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('first-native') }))?.status).toBe('admitted')
  const first = await h.client.inspectAgentInput({ key: key('first-native') })
  expect(first).toMatchObject({ key: key('first-native'), status: 'admitted', admission: { admission: { transport: 'native', native: { outcome: 'admitted', turnId: 'original-native-turn' } } } })
  await h.client.submitAgentPrompt(input('first-native')); expect(h.send).toHaveBeenCalledTimes(1)
  await h.client.submitAgentPrompt(input('second-native')); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('second-native') }))?.status).toBe('admitted'); expect(h.send).toHaveBeenCalledTimes(2)
  const old = await h.client.inspectAgentPromptSubmission(key('first-native')), latest = await h.client.inspectAgentPromptSubmission(key('second-native'))
  expect(old?.admission?.intent?.plan).toMatchObject({ clientCorrelation: h.send.mock.calls[0]![1].clientCorrelation })
  expect(old?.admission?.intent?.plan).not.toEqual(latest?.admission?.intent?.plan)
  const mailbox = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' }); expect(mailbox.items).toHaveLength(2)
  expect(parseAgentInputMailboxPage(mailbox, { agentSessionId: 'recipient' })).toEqual(mailbox)
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps unknown native outcome, original token and source after reopen and never upgrades or automatically replays it', async () => {
  const h = await owner('unknown')
  await h.client.submitAgentPrompt(input('unknown-native'))
  const first = await settledNative(h, key('unknown-native'), 'unknown')
  expect(first?.admission).toMatchObject({ transport: 'native', acknowledged: false, native: { outcome: 'unknown' } })
  expect(await h.client.submitAgentPrompt(input('unknown-native'))).toMatchObject({ status: 'unknown' })
  expect(h.send).toHaveBeenCalledTimes(1)
  const reopened = new AgentMuxFileAgentSessionStore(h.store.path)
  expect(await reopened.readPromptAdmission('recipient', key('unknown-native').expectedRun, 'unknown-native')).toEqual(first)
  await h.client.submitAgentPrompt(input('independent-native')); await settledNative(h, key('independent-native'), 'unknown'); expect(h.send).toHaveBeenCalledTimes(2)
  expect(await h.client.inspectAgentPromptSubmission(key('unknown-native'))).toEqual(first)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('retains rejected exact-turn native receipt without PTY fallback and refuses another source on the same key', async () => {
  const h = await owner('not-applied')
  const request = { ...input('exact-native'), admissionIntent: { ...input('exact-native').admissionIntent, expectedTurnId: 'stale-original-turn' } }
  await h.client.submitAgentPrompt(request); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('exact-native') }))?.status).toBe('not-applied')
  expect(await h.client.inspectAgentInput({ key: key('exact-native') })).toMatchObject({ status: 'not-applied', admission: { admission: { native: { plan: { expectedTurnId: 'stale-original-turn' }, outcome: 'not-applied', errorCode: -32600 } } } })
  expect(await h.client.submitAgentPrompt(request)).toMatchObject({ status: 'not-applied' }); expect(h.send).toHaveBeenCalledTimes(1)
  await expect(h.client.submitAgentPrompt({ ...request, admissionIntent: { ...request.admissionIntent, source: { ...target, nativeSessionId: 'another-source' } } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('rejects an unavailable selected native source without claiming input or taking away independent ordinary TTY input', async () => {
  const h = await owner()
  const wrong = { ...input('wrong-source'), admissionIntent: { kind: 'native-conversation' as const, source: { ...target, nativeSessionId: 'foreign-thread' } } }
  expect(await h.client.submitAgentPrompt(wrong)).toMatchObject({ status: 'waiting' })
  await unavailableInput(h, 'wrong-source')
  expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.send).not.toHaveBeenCalled()
  const ordinary = { ...input('ordinary-terminal'), admissionIntent: { kind: 'manual-actor' as const } }
  await h.client.submitAgentPrompt(ordinary); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('ordinary-terminal') }))?.status).toBe('terminal-confirmed')
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps original old Runs without a native port usable and never exposes private launch credentials', async () => {
  const h = await owner()
  const stored = (await h.store.readMetadata('recipient'))!
  expect(cloneSession(stored)).not.toHaveProperty('nativeActor'); expect(() => parseRpcAgentSession(stored)).toThrow()
  const { nativeActor: _actor, ...oldRun } = stored
  await h.store.compareAndSwap(stored, oldRun); await h.inner.registry.load('local')
  h.prepare.mockRejectedValue(new AgentMuxError('Provider found no original native channel', 'AGENT_NATIVE_INPUT_UNAVAILABLE'))
  expect(await h.client.submitAgentPrompt(input('old-no-port'))).toMatchObject({ status: 'waiting' })
  await unavailableInput(h, 'old-no-port')
  expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.send).not.toHaveBeenCalled()
  await h.client.submitAgentPrompt({ ...input('old-terminal'), admissionIntent: { kind: 'manual-actor' as const } }); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('old-terminal') }))?.status).toBe('terminal-confirmed')
  expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('public RPC uses the exact explicit native intent and original message journal; source changes cannot borrow an existing receipt', async () => {
  const h = await owner(), rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const packet = { operationId: 'native-message-control', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original explicit message', execution: 'immediate' as const,
    admissionIntent: { ...input('unused').admissionIntent, expectedRun: key('unused').expectedRun } }
  const first: any = await rpc.call('agent.send', packet, { principal: { kind: 'user', id: 'user' } })
  expect(first.inputReceipt).toMatchObject({ key: { kind: 'message', messageId: first.messageId } })
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: first.inputReceipt.key }))?.status).toBe('admitted')
  expect(first.messageId).not.toBe(packet.operationId); expect(h.send).toHaveBeenCalledTimes(1)
  const again: any = await rpc.call('agent.send', packet, { principal: { kind: 'user', id: 'user' } })
  expect(again.inputReceipt?.status ?? again.delivery.state).toBe('admitted'); expect(h.send).toHaveBeenCalledTimes(1)
  await expect(rpc.call('agent.send', { ...packet, admissionIntent: { ...packet.admissionIntent, source: { ...target, nativeSessionId: 'other-native-source' } } }, { principal: { kind: 'user', id: 'user' } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('strict original intent codecs retain opaque targets and reject mixed caller conditions or unknown target fields', () => {
  const intent = { ...input('unused').admissionIntent, expectedRun: key('unused').expectedRun, expectedTurnId: 'opaque:turn/kept' }
  expect(validateAgentPromptAdmissionIntent(intent)).toEqual(intent)
  expect(validateAgentPromptInputBinding({ expectedRun: intent.expectedRun, admissionIntent: { kind: intent.kind, source: intent.source, expectedTurnId: intent.expectedTurnId } })).toMatchObject({ admissionIntent: { source: target } })
  for (const bad of [{ ...intent, afterSubmissionId: null }, { ...intent, source: { ...intent.source, actorId: 'caller-supplied-actor' } }, { ...intent, source: { ...target, nativeSessionId: '' } }]) expect(() => validateAgentPromptAdmissionIntent(bad)).toThrow()
})


it('default user message freezes its original condition and chooses the confirmed durable native conversation', async () => {
  const h = await owner()
  const before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const context = { principal: { kind: 'user' as const, id: 'local' } }
  const packet = { operationId: 'default-semantic-message', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Default semantic message' }
  const result: any = await rpc.call('agent.send', packet, context)
  const messageKey = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: key('unused').expectedRun, messageId: result.messageId }
  const claim = await settledNative(h, messageKey, 'admitted')
  expect(claim?.admission).toMatchObject({ inputKey: messageKey, transport: 'native', intent: {
    execution: 'default', admissionIntent: { kind: 'exact-condition', condition: { expectedRun: messageKey.expectedRun, afterSubmissionId: null } },
    message: { userContent: expect.stringContaining('Default semantic message') }
  } })
  expect(claim?.admission?.intent?.message).not.toHaveProperty('authorAgentSessionId')
  expect(await (Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue).readByOperationId(packet.operationId)).toMatchObject({ envelope: {
    sender: { kind: 'human' }, senderSessionId: null, senderRunId: null, body: packet.text
  } })
  expect(h.prepare).toHaveBeenCalledWith(expect.anything(), target)
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await rpc.call('agent.send', packet, context); expect(h.send).toHaveBeenCalledTimes(1)
  const manual: any = await rpc.call('agent.send', { ...packet, operationId: 'explicit-terminal-message', execution: 'immediate' }, context)
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: manual.inputReceipt.key }))?.status).toBe('terminal-confirmed')
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.prepare).toHaveBeenCalledTimes(1)
  expect((await (Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue).readByOperationId('explicit-terminal-message'))?.admissionIntent?.kind).toBe('manual-actor')
})

it('default authenticated A2A saves the original Inbox body by reference without claiming or disclosing it as native input', async () => {
  const h = await owner('admitted', ['caller', 'recipient']), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const packet = { operationId: 'default-peer-reference', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original peer body stays in Inbox' }
  const receipt: any = await rpc.call('agent.send', packet, { caller: h.credentials })
  expect(receipt).toMatchObject({ deliveryMode: 'reference', delivery: { state: 'queued' }, notification: { state: 'pending' } })
  const queue = Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue
  expect(await queue.readByOperationId(packet.operationId)).toMatchObject({ deliveryMode: 'reference', envelope: {
    messageId: receipt.messageId, senderSessionId: 'caller', recipientSessionId: 'recipient', body: packet.text
  } })
  expect(await h.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient', expectedRun: before.run, messageId: receipt.messageId })).toBeNull()
  const repeated: any = await rpc.call('agent.send', packet, { caller: h.credentials })
  expect(repeated.messageId).toBe(receipt.messageId); expect(repeated.notification.state).toBe('pending')
  expect(h.prepare).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await expect(rpc.call('agent.send', { ...packet, execution: 'immediate' }, { caller: h.credentials }))
    .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await queue.readByOperationId(packet.operationId)).toMatchObject({
    deliveryMode: 'reference', envelope: { messageId: receipt.messageId, body: packet.text }
  })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['no-source', 'source-unknown', 'source-ambiguous', 'changed-source', 'observed-other-source'] as const)('keeps default user terminal capability when its native target is unqualified: %s', async missing => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  const next: AgentMuxStoredAgentSession = { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } }
  if (missing === 'no-source') delete next.nativeHandle
  if (missing === 'source-unknown' || missing === 'source-ambiguous') next.nativeSourceObservation = { state: missing === 'source-unknown' ? 'unknown' : 'ambiguous', run: next.run, observedAt: fixtureEpoch(0, 0, 1), reason: 'original-source-unconfirmed' }
  if (missing === 'observed-other-source') next.observedNativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'observed-other' }
  if (missing === 'changed-source') { next.nativeSourceObservation = { state: 'changed', run: next.run, observedAt: fixtureEpoch(0, 0, 1), reason: 'original-source-changed' }; next.observedNativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'other-source' } }
  await h.store.compareAndSwap(before, next); await h.inner.registry.load('local')
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  await rpc.call('agent.send', { operationId: 'unqualified-' + missing, target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original terminal message' }, { principal: { kind: 'user', id: 'local' } })
  expect(h.send).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); expect(h.inner.kernel.input).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'ambiguous', 'changed'] as const)('routes a user-selected target through its exact native transport while frontend selection is %s', async state => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  const observation = { state, run: before.run, observedAt: before.updatedAt, reason: 'frontend-selection-unconfirmed' }
  await h.store.compareAndSwap(before, { ...before,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt },
    nativeSourceObservation: observation,
    ...(state === 'changed' ? { observedNativeHandle: { kind: 'provider' as const, providerId: target.providerId, sessionId: 'other-frontend-thread' } } : {}) })
  await h.inner.registry.load('local')
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const packet = { operationId: 'selected-message-' + state, target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original selected target message' }
  const result: any = await rpc.call('agent.send', packet, { principal: { kind: 'user', id: 'local' } })
  const messageKey = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: before.run, messageId: result.messageId }
  expect((await settledNative(h, messageKey, 'admitted'))?.admission).toMatchObject({ transport: 'native', native: { plan: { threadId: target.nativeSessionId } } })
  expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ nativeHandle: expect.objectContaining({ sessionId: target.nativeSessionId }) }), target)
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect((await h.store.readMetadata('recipient'))?.nativeSourceObservation).toEqual(observation)
})

it.each(['missing-port', 'failed-verification'] as const)('never substitutes terminal input for an unavailable user-selected target: %s', async unavailable => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt },
    nativeSourceObservation: { state: 'unknown', run: before.run, observedAt: before.updatedAt, reason: 'frontend-selection-unconfirmed' } })
  await h.inner.registry.load('local')
  const provider = Reflect.get(h.client, 'providers').get('codex') as AgentProvider
  if (unavailable === 'missing-port') delete provider.prepareNativeInput
  else h.prepare.mockRejectedValue(new AgentMuxError('Exact selected target transport is unavailable', 'AGENT_NATIVE_INPUT_UNAVAILABLE'))
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients }), context = { principal: { kind: 'user' as const, id: 'local' } }
  const packet = { operationId: 'selected-unavailable-' + unavailable, messageId: 'selected-unavailable-message-' + unavailable,
    target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Retain the selected target' }
  await expect(rpc.call('agent.send', packet, context)).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect(await h.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient', expectedRun: before.run, messageId: packet.messageId })).toBeNull()
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  const manual: any = await rpc.call('agent.send', { ...packet, operationId: 'selected-manual-' + unavailable,
    messageId: 'selected-manual-message-' + unavailable, execution: 'immediate' }, context)
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: manual.inputReceipt.key }))?.status).toBe('terminal-confirmed')
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1); expect(h.prepare).toHaveBeenCalledTimes(unavailable === 'missing-port' ? 0 : 1)
})

it.each(['completion', 'future'] as const)('directs an automatic %s prompt to the user-selected target and retains its original admission', async kind => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt },
    nativeSourceObservation: { state: 'ambiguous', run: before.run, observedAt: before.updatedAt, reason: 'frontend-selection-unconfirmed' },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: before.updatedAt } })
  await h.inner.registry.load('local')
  const selected = h.client.agentSession('recipient'), prompt = 'Original automatic selected prompt'
  const completionId = agentTurnCompletionIdentity(selected)!
  const future = { intentId: 'selected-schedule', occurrenceAt: fixtureEpoch(0, 2) }
  if (kind === 'future') await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'recipient', intentId: future.intentId,
    operationId: 'save-selected-schedule', prompt, active: true })
  const request = { agentSessionId: 'recipient', operationId: 'selected-automatic-' + kind, ...agentPromptCondition(selected),
    prompt, expectedInputByte: 0, ...(kind === 'future' ? { expectedFutureIntent: future } : { expectedCompletionId: completionId }) }
  await h.client.submitAgentPrompt(request)
  const record = await settledNative(h, key(request.operationId), 'admitted')
  expect(record?.admission).toMatchObject({ transport: 'native', native: { plan: { operation: 'queue-idle', threadId: target.nativeSessionId } },
    ...(kind === 'future' ? { futureIntent: future } : { completionId }) })
  expect(h.prepare).toHaveBeenCalledWith(expect.anything(), { ...target, idleOnly: true })
  await h.client.submitAgentPrompt(request)
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  if (kind === 'future') expect(await h.client.readAgentFuturePromptIntent('recipient', future.intentId)).toMatchObject({
    lastOccurrenceAt: future.occurrenceAt, lastOperationId: request.operationId })
  const repeated = { ...request, ...agentPromptCondition(h.client.agentSession('recipient')), operationId: request.operationId + '-duplicate' }
  await expect(h.client.submitAgentPrompt(repeated)).rejects.toMatchObject(kind === 'future'
    ? { code: 'AGENT_PROMPT_PREPARATION_FAILED', detail: expect.stringContaining('"code":"AGENT_FUTURE_INTENT_CHANGED"'),
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }
    : { code: 'AGENT_COMPLETION_CHANGED' })
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it.each([false, true])('directs a default typed prompt to the user-selected target and preserves its private idle restriction: %s', async nativeIdleOnly => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt },
    nativeSourceObservation: { state: 'ambiguous', run: before.run, observedAt: before.updatedAt, reason: 'frontend-selection-unconfirmed' } })
  await h.inner.registry.load('local')
  // The recovery input owner submits this public typed shape after its own
  // original operation, Provider evidence and input-byte qualifications.
  const request = { agentSessionId: 'recipient', operationId: 'selected-default-typed', expectedRun: before.run,
    afterSubmissionId: null, prompt: 'Original typed selected prompt', signal: new AbortController().signal }
  const control = nativeIdleOnly ? { nativeIdleOnly: true as const } : undefined
  await h.client.submitAgentPrompt(request, control)
  expect((await settledNative(h, key(request.operationId), 'admitted'))?.admission).toMatchObject({
    inputKey: key(request.operationId), transport: 'native', native: { plan: {
      threadId: target.nativeSessionId, operation: nativeIdleOnly ? 'queue-idle' : 'start-or-steer' } } })
  await h.client.submitAgentPrompt(request, control)
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('rechecks the original automatic input byte after preparing the user-selected target', async () => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt },
    nativeSourceObservation: { state: 'ambiguous', run: before.run, observedAt: before.updatedAt, reason: 'frontend-selection-unconfirmed' },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: before.updatedAt } })
  await h.inner.registry.load('local')
  const selected = h.client.agentSession('recipient'), prepare = h.prepare.getMockImplementation()!
  h.prepare.mockImplementation(async (...args) => {
    const prepared = await prepare(...args)
    h.inner.kernel.status = vi.fn(async (runId: string) => ({ ...h.run(runId), pid: 1234, acceptedInputBytes: 1 }))
    return prepared
  })
  const request = { agentSessionId: 'recipient', operationId: 'selected-automatic-final-byte', ...agentPromptCondition(selected),
    prompt: 'Original automatic selected prompt', expectedInputByte: 0, expectedCompletionId: agentTurnCompletionIdentity(selected)! }
  await expect(h.client.submitAgentPrompt(request)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED' })
  expect((await h.client.inspectAgentPromptSubmission(key(request.operationId)))?.admission).toMatchObject({
    transport: 'native', notApplied: true, native: { outcome: 'not-applied', plan: { operation: 'queue-idle' } } })
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['completion', 'input-byte'] as const)('does not let a selected target bypass the original automatic %s fence', async changed => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt },
    nativeSourceObservation: { state: 'ambiguous', run: before.run, observedAt: before.updatedAt, reason: 'frontend-selection-unconfirmed' },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: before.updatedAt } })
  await h.inner.registry.load('local')
  const selected = h.client.agentSession('recipient')
  await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId: 'selected-automatic-fence-' + changed,
    ...agentPromptCondition(selected), prompt: 'Original automatic selected prompt', expectedInputByte: changed === 'input-byte' ? 1 : 0,
    expectedCompletionId: changed === 'completion' ? 'other-completion' : agentTurnCompletionIdentity(selected)! })).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['source', 'actor', 'predecessor'] as const)('rechecks the original default user message %s after native preparation and sends nothing on a changed target', async changed => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  const originalPrepare = h.prepare.getMockImplementation()!
  h.prepare.mockImplementation(async (...args) => {
    const prepared = await originalPrepare(...args), original = (await h.store.readMetadata('recipient'))!
    const next = structuredClone(original)
    if (changed === 'source') next.nativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'later-source' }
    if (changed === 'actor') next.nativeActor = { ...actor, actorId: 'later-actor' }
    if (changed === 'predecessor') next.promptCompletionAdmission = { submissionId: 'other-input', operationId: 'other-input', inputKey: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: before.run, submissionId: 'other-input' }, startByte: 0, endByte: 1, outputCursorBytes: 0, acknowledged: true, intent: { run: before.run, ownerInstanceId: 'fixture-runtime', prompt: 'x', plan: { kind: 'single-phase', data: 'x' }, execution: 'default', admissionIntent: { kind: 'exact-condition', condition: { expectedRun: before.run, afterSubmissionId: null } }, message: { userContent: 'x' } } }
    await h.store.compareAndSwap(original, next)
    return prepared
  })
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const request = { operationId: 'changed-' + changed, target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original default message' }
  await expect(rpc.call('agent.send', request, { principal: { kind: 'user', id: 'local' } })).rejects.toBeDefined()
  expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(await h.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient', expectedRun: before.run, messageId: 'message-' + createHash('sha256').update(request.operationId).digest('hex') })).toBeNull()
})


it.each(['unknown', 'not-applied'] as const)('keeps the default message original %s native receipt without retry or terminal substitution', async outcome => {
  const h = await owner(outcome), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const packet = { operationId: 'default-outcome-' + outcome, messageId: 'default-outcome-message', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original uncertain message' }
  const context = { principal: { kind: 'user' as const, id: 'local' } }
  await expect(rpc.call('agent.send', packet, context)).rejects.toBeDefined()
  const messageKey = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: before.run, messageId: packet.messageId }
  const original = await h.client.inspectAgentPromptSubmission(messageKey)
  expect(original?.admission).toMatchObject({ transport: 'native', native: { outcome } })
  await expect(rpc.call('agent.send', packet, context)).rejects.toBeDefined()
  expect(await h.client.inspectAgentPromptSubmission(messageKey)).toEqual(original)
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('rejoins the original default PTY claim when a native source appears later instead of upgrading its transport', async () => {
  const h = await owner(), rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const originalInput = h.inner.kernel.input as ReturnType<typeof vi.fn>
  originalInput.mockRejectedValueOnce(new Error('Original Runtime input receipt unavailable'))
  const packet = { operationId: 'original-byte-operation', messageId: 'original-byte-message', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original byte claim' }
  const context = { principal: { kind: 'user' as const, id: 'local' } }
  const failure = await rpc.call('agent.send', packet, context).then(() => null, (error: unknown) => error)
  expect(failure).toMatchObject({ message: 'Original Runtime input receipt unavailable' })
  expect(originalInput).toHaveBeenCalledTimes(1)
  const before = (await h.store.readMetadata('recipient'))!
  expect(before.promptCompletionAdmission?.transport).not.toBe('native')
  expect(before.promptCompletionAdmission?.intent?.plan.kind).toBe('single-phase')
  await h.store.compareAndSwap(before, { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  await rpc.call('agent.send', packet, context)
  const current = (await h.store.readMetadata('recipient'))!
  expect(current.promptCompletionAdmission?.acknowledged).toBe(true)
  expect(current.promptCompletionAdmission?.intent?.plan).toEqual(before.promptCompletionAdmission?.intent?.plan)
  expect(h.send).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled()
})


it('keeps failed default native preparation unapplied without terminal substitution and preserves a new explicit terminal intent', async () => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  h.prepare.mockRejectedValue(new AgentMuxError('Original native source temporarily unavailable', 'AGENT_NATIVE_INPUT_UNAVAILABLE'))
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients }), context = { principal: { kind: 'user' as const, id: 'local' } }
  const packet = { operationId: 'native-prepare-operation', messageId: 'native-prepare-message', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original read-only preparation' }
  await expect(rpc.call('agent.send', packet, context)).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect(await h.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient', expectedRun: before.run, messageId: packet.messageId })).toBeNull()
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  await rpc.call('agent.send', { ...packet, operationId: 'manual-after-native-prepare', messageId: 'manual-after-native-prepare-message', execution: 'immediate' }, context)
  expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.send).not.toHaveBeenCalled()
  expect((await (Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue).readByOperationId('manual-after-native-prepare'))?.admissionIntent?.kind).toBe('manual-actor')
})


it('compiled default agent send uses the same original native claim and retries the same CLI source without another effect', async () => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const server = new ObjectCliProbe(request => rpc.call(request.method as 'agent.send', request.params as never, { principal: { kind: 'user', id: 'local' } }))
  await server.start(); closes.push(() => server.stop())
  const args = ['--endpoint', 'unix://' + server.socketPath, 'agent', 'send', '--to-session', 'recipient', '--operation-id', 'compiled-default-operation', '--message-id', 'compiled-default-message', '--text', 'Original compiled default message']
  const env = objectCliEnvironment(server.root)
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runCompiledObjectCli(args, env)
    expect(result.code, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout).result
    expect(receipt.messageId).toBe('compiled-default-message'); expect(receipt.delivery.state).toBe('delivered')
  }
  expect(server.requests).toHaveLength(2)
  for (const request of server.requests) { expect(request.params.sourceChannel).toBe('cli'); expect(request.params).not.toHaveProperty('admissionIntent'); expect(request.params).not.toHaveProperty('execution') }
  const claim = await h.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient', expectedRun: before.run, messageId: 'compiled-default-message' })
  expect(claim?.admission).toMatchObject({ transport: 'native', native: { outcome: 'admitted' }, intent: { admissionIntent: { kind: 'exact-condition', condition: { afterSubmissionId: null } } } })
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const help = await runCompiledObjectCli(['agent', 'send', '--help'], env)
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('--execution default|immediate')
  expect(help.stdout).toContain('notification.automatic')
})


it('keeps an unavailable default semantic request unapplied while explicit manual input on the same healthy Run stays usable', async () => {
  const h = await owner(), original = (await h.store.readMetadata('recipient'))!
  const { nativeActor: _actor, ...withoutActor } = original
  await h.store.compareAndSwap(original, { ...withoutActor, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.nativeSessionId } })
  await h.inner.registry.load('local')
  h.prepare.mockRejectedValue(new AgentMuxError('Original Provider channel does not support this operation', 'AGENT_NATIVE_INPUT_UNAVAILABLE'))
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const packet = { operationId: 'unavailable-semantic', messageId: 'unavailable-semantic-message', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original semantic input' }
  await expect(rpc.call('agent.send', packet, { principal: { kind: 'user', id: 'local' } })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect(await h.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient', expectedRun: original.run, messageId: packet.messageId })).toBeNull()
  expect(await (Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue).readByOperationId(packet.operationId)).toMatchObject({
    envelope: { messageId: packet.messageId, body: packet.text }, delivery: { state: 'queued' }
  })
  expect(h.prepare).toHaveBeenCalledWith(expect.not.objectContaining({ nativeActor: expect.anything() }), target)
  expect(h.send).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await h.client.submitAgentPrompt({ ...input('same-run-manual'), admissionIntent: { kind: 'manual-actor' as const } })
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('same-run-manual') }))?.status).toBe('terminal-confirmed')
  expect(h.prepare).toHaveBeenCalledTimes(1)
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('admits a later saved occurrence through the exact idle queue without consulting a screen', async () => {
  const h = await owner(), before = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(before, { ...before,
    nativeHandle: { kind: 'provider', providerId: target.providerId, sessionId: target.nativeSessionId },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: before.updatedAt } })
  await h.inner.registry.load('local')
  const original = h.client.agentSession('recipient'), completionId = agentTurnCompletionIdentity(original)!
  const first = { agentSessionId: 'recipient', operationId: 'consuming-completion', ...agentPromptCondition(original),
    prompt: 'Original automatic input', expectedInputByte: 0, expectedCompletionId: completionId }
  await h.client.submitAgentPrompt(first); await settledNative(h, key(first.operationId), 'admitted')
  const provider = h.client.providers.get('codex')
  provider.readPromptExecutionEvidence = async () => ({ sourceId: 'native-source', id: 'retained-end', state: 'ended', endReason: 'completed' })
  provider.inspectPromptExecution = vi.fn(() => { throw Error('Screen presentation cannot authorize automatic input') })
  const screen = Reflect.get(h.client, 'screenEvidence')
  vi.spyOn(screen, 'wait').mockImplementation(() => { throw Error('No terminal frame is needed for native idle admission') })
  await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'recipient', intentId: 'later-occurrence', operationId: 'save-later',
    prompt: 'A separately authorized later occurrence', active: true })
  const current = h.client.agentSession('recipient'), next = { agentSessionId: 'recipient', ...agentPromptCondition(current),
    operationId: 'later-input', prompt: 'A separately authorized later occurrence', expectedInputByte: 0,
    expectedFutureIntent: { intentId: 'later-occurrence', occurrenceAt: fixtureEpoch(0, 3) } }
  await h.client.submitAgentPrompt(next)
  const record = await settledNative(h, key(next.operationId), 'admitted')
  expect(record?.admission).toMatchObject({ transport: 'native', native: { plan: { operation: 'queue-idle', threadId: target.nativeSessionId } } })
  expect(provider.inspectPromptExecution).not.toHaveBeenCalled()
  expect(screen.wait).not.toHaveBeenCalled()
  expect(h.send).toHaveBeenCalledTimes(2)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})
