import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentPromptSubmissionCoordinator as SourceCoordinator, type AgentPromptInputControl } from '../src/prompt-submission.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { agentTurnCompletionIdentity } from '../src/agent-session-identity.js'
import { AgentMuxFileAgentSessionStore as SourceStore } from '../src/agent-session-store.js'
import { confirmNativeInputAdoption as sourceConfirmAdoption } from '../src/native-input-adoption.js'
import type { AgentNativePromptInputPlan, AgentPromptMessageContent, AgentPromptSubmissionRecord, AgentSessionHistoryItem } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { fixtureEpoch } from './helpers/fixture-values.js'
import { nativeInputCorrelationKey } from '../src/native-input-correlation.js'
import type { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'

const entry = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
const compiled = entry ? await import(entry) : null
const AgentMuxFileAgentSessionStore: typeof SourceStore = compiled?.AgentMuxFileAgentSessionStore ?? SourceStore
const AgentPromptSubmissionCoordinator: typeof SourceCoordinator = entry
  ? (await import(new URL('./prompt-submission.js', entry).href)).AgentPromptSubmissionCoordinator : SourceCoordinator
const confirmNativeInputAdoption: typeof sourceConfirmAdoption = entry
  ? (await import(new URL('./native-input-adoption.js', entry).href)).confirmNativeInputAdoption : sourceConfirmAdoption

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const id = 'original-notification', wire = '<amux:a2a from="peer" msg-id="original-message" read-via="message --skill" />'
const source = { providerId: 'codex', nativeSessionId: 'original-native-thread' }
const actor = { protocolId: 'original-protocol', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }

async function fixture(outcome: 'admitted' | 'unknown' = 'admitted') {
  const h = await rpcOwnerFixture(); closes.push(h.close)
  const inner = h.client as unknown as { promptSubmission: SourceCoordinator; messageQueue: DurableAgentMuxMessageQueue }
  const deps = Reflect.get(inner.promptSubmission, 'deps') as ConstructorParameters<typeof AgentPromptSubmissionCoordinator>[0]
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, nativeActor: actor, updatedAt: fixtureEpoch(0, 1),
    nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: fixtureEpoch(0, 1) } })
  await deps.registry.refresh('recipient', original.run)
  let inputByte = 0
  const run = () => ({ ...h.run(original.run.runId), acceptedInputBytes: inputByte, pid: 1234 })
  h.inner.kernel.status = vi.fn(async () => run())
  const key = { kind: 'prompt' as const, agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: id }
  const message: AgentPromptMessageContent = { a2aNotificationId: id, systemContext: wire }
  const send = vi.fn(async (_prompt: string, plan: AgentNativePromptInputPlan) => {
    const sentKey = nativeInputCorrelationKey(plan.clientCorrelation!)
    if (sentKey?.kind !== 'prompt') throw new Error('The original typed notification correlation is missing')
    // A different Store instance reads the original committed claim before any native effect.
    const persisted = await new AgentMuxFileAgentSessionStore(h.store.path).readPromptAdmission('recipient', original.run, sentKey.submissionId)
    expect(persisted?.admission?.intent?.plan).toEqual(plan)
    expect(persisted?.admission?.inputKey).toEqual(sentKey)
    expect(persisted?.admission?.intent?.message).toEqual({ a2aNotificationId: sentKey.submissionId, systemContext: _prompt })
    if (outcome === 'unknown' && sentKey.submissionId === id) throw new Error('Original queue ACK was lost after acceptance')
    return { outcome: 'admitted' as const, queuedSubmissionId: 'original-native-queue-item' }
  })
  let beforePrepare: (() => Promise<void>) | undefined
  const prepare = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (_context, selected) => {
    await beforePrepare?.()
    return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]),
      actorId: actor.actorId, threadId: selected.nativeSessionId, operation: selected.idleOnly ? 'queue-idle' : 'start-or-steer' }, send, dispose: vi.fn() }
  })
  const provider = { ...new AgentProviderRegistry().get('codex'), prepareNativeInput: prepare }
  const coordinator = new AgentPromptSubmissionCoordinator({ ...deps, providers: new AgentProviderRegistry([provider]) })
  const session = h.client.agentSession('recipient'), condition = agentPromptCondition(session), completionId = agentTurnCompletionIdentity(session)!
  const appendReference = (messageId: string) => inner.messageQueue.append({ messageId, operationId: 'operation-' + messageId, createdAt: fixtureEpoch(0, 1),
    sender: { kind: 'agent-session', agentSessionId: 'peer' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'peer', senderRunId: 'peer-run', recipientSessionId: 'recipient', recipientRunId: original.run.runId,
    threadId: 'original-thread', correlationId: 'correlation-' + messageId, replyTo: null, workspaceId: null, body: 'Original Inbox body stays outside notification input' }, { deliveryMode: 'reference' })
  await appendReference('original-message')
  expect((await inner.messageQueue.prepareNotification({ notificationId: id, agentSessionId: 'recipient', condition,
    idle: { completionId, inputByte: 0 } }))?.wire).toBe(wire)
  const control: AgentPromptInputControl = { idleOnly: { completionId, inputByte: 0 } }
  const submit = (changed: { message?: AgentPromptMessageContent; control?: AgentPromptInputControl } = {}) => coordinator.submitInputPlan(
    session, run(), id, wire, { kind: 'single-phase', data: wire + '\r' }, condition, completionId, undefined, false, undefined, 0,
    changed.message ?? message, 'default', undefined, undefined, undefined, key, changed.control ?? control)
  const submitIndependent = async (idleOnly: boolean) => {
    const current = (await h.store.readMetadata('recipient'))!
    await h.store.compareAndSwapMetadata(current, { ...current, updatedAt: Math.max(current.updatedAt, fixtureEpoch(0, 3)),
      semanticStatus: { state: 'done', source: 'native-transcript', observedAt: fixtureEpoch(0, 3) } })
    const latest = await deps.registry.refresh('recipient', original.run), nextId = 'independent-notification'
    const nextWire = wire.replace('original-message', 'independent-message'), completion = agentTurnCompletionIdentity(latest)!
    const nextKey = { ...key, submissionId: nextId }
    if (idleOnly) {
      await appendReference('independent-message')
      expect((await inner.messageQueue.prepareNotification({ notificationId: nextId, agentSessionId: 'recipient', condition: agentPromptCondition(latest),
        idle: { completionId: completion, inputByte: 0 } }))?.wire).toBe(nextWire)
    }
    return coordinator.submitInputPlan(h.client.agentSession('recipient'), run(), nextId, nextWire,
      { kind: 'single-phase', data: nextWire + '\r' }, agentPromptCondition(latest), completion, undefined, false, undefined, 0,
      idleOnly ? { a2aNotificationId: nextId, systemContext: nextWire } : { userContent: nextWire }, 'default', undefined, undefined, undefined,
      nextKey, idleOnly ? { idleOnly: { completionId: completion, inputByte: 0 } } : undefined)
  }
  return { ...h, key, message, prepare, send, submit, beforePrepare: (callback: () => Promise<void>) => { beforePrepare = callback },
    changeByte: () => { inputByte++ }, submitIndependent, queue: inner.messageQueue,
    read: () => h.store.readPromptAdmission('recipient', original.run, id) }
}

it('persists one independent notification input before native idle-queue admission; retry is receipt-only', async () => {
  const f = await fixture()
  await expect(f.submit()).resolves.toEqual(f.message)
  expect(f.prepare).toHaveBeenCalledWith(expect.anything(), { ...source, idleOnly: true })
  const record = await f.read()
  expect(record?.admission).toMatchObject({ inputKey: f.key, completionId: expect.any(String), acknowledged: true,
    native: { plan: { operation: 'queue-idle' }, outcome: 'admitted', queuedSubmissionId: 'original-native-queue-item' }, intent: { message: f.message } })
  expect(record?.admission?.native).not.toHaveProperty('turnId')
  await expect(f.submit()).resolves.toEqual(f.message)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps lost queue ACK and original correlation unknown without a second native add', async () => {
  const f = await fixture('unknown')
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  const original = await f.read()
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  expect(await f.read()).toEqual(original)
  expect(original?.admission).toMatchObject({ acknowledged: false, native: { outcome: 'unknown', plan: { operation: 'queue-idle', clientCorrelation: expect.any(String) } } })
  expect(f.send).toHaveBeenCalledTimes(1)
})

it.each([true, false])('an independent input can pass an unknown Native predecessor only as a typed idle notification (idleOnly=%s)', async idleOnly => {
  const f = await fixture('unknown')
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  const old = await f.read()
  if (idleOnly) await expect(f.submitIndependent(true)).resolves.toMatchObject({ a2aNotificationId: 'independent-notification' })
  else await expect(f.submitIndependent(false)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  expect(await f.read()).toEqual(old)
  expect(f.send).toHaveBeenCalledTimes(idleOnly ? 2 : 1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not let the independent idle notice bypass its exact source after an unknown Native input', async () => {
  const f = await fixture('unknown'); await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  const old = await f.read()
  f.beforePrepare(async () => {
    const current = (await f.store.readMetadata('recipient'))!
    await f.store.compareAndSwapMetadata(current, { ...current, nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: 'foreign-source' } })
  })
  await expect(f.submitIndependent(true)).rejects.toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED' })
  expect(await f.read()).toEqual(old); expect(f.send).toHaveBeenCalledTimes(1)
  expect(await f.store.readPromptAdmission('recipient', f.key.expectedRun, 'independent-notification')).toBeNull()
})

it('a normal controlled manual prompt cannot take the exact key of a pending platform notice', async () => {
  const f = await fixture()
  await expect(f.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId: id, expectedRun: f.key.expectedRun,
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Unrelated original human input', authorHuman: true }))
    .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await f.read()).toBeNull(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.queue.readNotification(id))?.state).toBe('pending')
})

it('an acknowledged ordinary prompt cannot sign for a different notification using the same operation ID', async () => {
  const f = await fixture(), operationId = 'original-human-prompt'
  await f.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId, expectedRun: f.key.expectedRun,
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Original unrelated human message', authorHuman: true })
  const key = { ...f.key, submissionId: operationId }
  await expect.poll(async () => (await f.client.inspectAgentPromptSubmission(key))?.admission?.acknowledged).toBe(true)
  const original = await f.client.inspectAgentPromptSubmission(key)
  await expect(f.client.notifyMessages({ operationId, messageIds: ['original-message'] }))
    .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await f.client.inspectAgentPromptSubmission(key)).toEqual(original)
  expect(await f.queue.readNotification(operationId)).toBeNull()
  expect((await f.queue.readByMessageId('original-message'))?.notification).toMatchObject({ state: 'pending', notificationId: id })
})

it('treats typed notification identity as immutable original input content', async () => {
  const f = await fixture(); await f.submit()
  await expect(f.submit({ message: { ...f.message, a2aNotificationId: 'foreign-notification' }, control: {} }))
    .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(f.send).toHaveBeenCalledTimes(1)
})

it.each(['completion', 'input-byte'] as const)('rechecks the original %s before the native idle-queue effect', async changed => {
  const f = await fixture()
  f.beforePrepare(async () => {
    if (changed === 'input-byte') f.changeByte()
    else {
      const current = (await f.store.readMetadata('recipient'))!
      await f.store.compareAndSwapMetadata(current, { ...current, updatedAt: Math.max(current.updatedAt, fixtureEpoch(0, 2)), semanticStatus: { state: 'working', source: 'native-hook', observedAt: fixtureEpoch(0, 2) } })
    }
  })
  await expect(f.submit()).rejects.toMatchObject({ code: changed === 'input-byte' ? 'AGENT_PROMPT_INPUT_UNCONFIRMED' : 'AGENT_COMPLETION_CHANGED' })
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['admitted', 'unknown'] as const)('joins exact original notification wire after native %s; edits remain readable without adoption', async outcome => {
  const f = await fixture(outcome)
  if (outcome === 'unknown') await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  else await expect(f.submit()).resolves.toEqual(f.message)
  const record = (await f.read())!
  const plan = record.admission!.transport === 'native' ? record.admission!.native.plan : undefined
  expect(plan).toBeDefined()
  const item: AgentSessionHistoryItem = { id: 'original-native-record', turnId: 'native-idle-turn', kind: 'user-message', contentParts: [{ kind: 'text', text: wire }],
    conversation: { nativeInput: { source, semanticItemId: 'original-semantic-item', turnId: 'native-idle-turn', clientCorrelation: plan!.clientCorrelation! } } }
  const adopt = (value: AgentSessionHistoryItem, original: AgentPromptSubmissionRecord = record) => confirmNativeInputAdoption(value,
    { hostId: 'local', agentSessionId: 'recipient' }, source, async () => original)
  expect((await adopt(item)).conversation?.adoptedInput).toEqual({ key: f.key, purpose: 'a2a-notification' })
  for (const edited of [{ ...item, contentParts: [{ kind: 'text' as const, text: wire + ' manual edit' }] },
    { ...item, contentParts: [...item.contentParts, { kind: 'text' as const, text: 'another part' }] }]) {
    const result = await adopt(edited)
    expect(result.conversation?.adoptedInput).toBeUndefined(); expect(result.contentParts).toEqual(edited.contentParts)
  }
  const manual = structuredClone(record), admission = manual.admission
  if (admission?.transport !== 'native' || !admission.intent) throw new Error('The original native claim is missing')
  const { expectedTurnId: _originalTurn, ...originalPlan } = admission.native.plan
  const manualPlan: AgentNativePromptInputPlan = { ...originalPlan, operation: 'start-or-steer' }
  admission.acknowledged = true
  admission.native = { plan: manualPlan, outcome: 'admitted', turnId: item.turnId! }
  admission.intent = { ...admission.intent, plan: manualPlan, execution: 'immediate',
    admissionIntent: { kind: 'native-conversation', source, expectedRun: f.key.expectedRun }, message: { userContent: wire, authorHuman: true } }
  expect((await adopt(item, manual)).conversation?.adoptedInput).toEqual({ key: f.key })
})
