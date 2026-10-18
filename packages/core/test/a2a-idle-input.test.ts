import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentPromptSubmissionCoordinator as SourceCoordinator, type AgentPromptInputControl } from '../src/prompt-submission.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { agentTurnCompletionIdentity } from '../src/agent-session-identity.js'
import { AgentMuxFileAgentSessionStore as SourceStore } from '../src/agent-session-store.js'
import { confirmNativeInputAdoption as sourceConfirmAdoption } from '../src/native-input-adoption.js'
import type { AgentNativePromptInputPlan, AgentPromptExecutionEvidence, AgentPromptMessageContent, AgentPromptSubmissionRecord, AgentSessionHistoryItem } from '../src/types.js'
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

async function fixture(outcome: 'admitted' | 'unknown' = 'admitted', withActor = true, nativeIdle = false) {
  const h = await rpcOwnerFixture(); closes.push(h.close)
  const inner = h.client as unknown as { promptSubmission: SourceCoordinator; messageQueue: DurableAgentMuxMessageQueue }
  const deps = Reflect.get(inner.promptSubmission, 'deps') as ConstructorParameters<typeof AgentPromptSubmissionCoordinator>[0]
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, ...(withActor ? { nativeActor: actor } : {}), updatedAt: fixtureEpoch(0, 1),
    nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId },
    ...(nativeIdle ? {} : { semanticStatus: { state: 'done', source: 'native-hook', observedAt: fixtureEpoch(0, 1) } as const }) })
  await deps.registry.refresh('recipient', original.run)
  let inputByte = 0
  const run = () => ({ ...h.run(original.run.runId), acceptedInputBytes: inputByte, pid: 1234 })
  h.inner.kernel.status = vi.fn(async (runId: string) => runId === original.run.runId ? run() : h.run(runId))
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
  const assertCurrent = vi.fn(async () => {}), dispose = vi.fn(async () => {})
  let beforePrepare: (() => Promise<void>) | undefined
  const prepare = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (_context, selected) => {
    await beforePrepare?.()
    return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]),
      actorId: actor.actorId, threadId: selected.nativeSessionId, operation: selected.idleOnly ? 'queue-idle' : 'start-or-steer' }, assertCurrent, send, dispose }
  })
  let evidence: AgentPromptExecutionEvidence | null = { state: 'idle', sourceId: 'original-native-source', id: 'initial-idle-evidence' }
  const readEvidence = vi.fn(async () => evidence)
  const provider = { ...new AgentProviderRegistry().get('codex'), prepareNativeInput: prepare, readPromptExecutionEvidence: readEvidence }
  const coordinator = new AgentPromptSubmissionCoordinator({ ...deps, providers: new AgentProviderRegistry([provider]) })
  const session = h.client.agentSession('recipient'), condition = agentPromptCondition(session), completionId = agentTurnCompletionIdentity(session)!
  const idle = nativeIdle ? { nativeEvidence: { sourceId: evidence!.sourceId, id: evidence!.id }, inputByte: 0 } : { completionId, inputByte: 0 }
  const appendReference = (messageId: string) => inner.messageQueue.append({ messageId, operationId: 'operation-' + messageId, createdAt: fixtureEpoch(0, 1),
    sender: { kind: 'agent-session', agentSessionId: 'peer' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'peer', senderRunId: 'peer-run', recipientSessionId: 'recipient', recipientRunId: original.run.runId,
    threadId: 'original-thread', correlationId: 'correlation-' + messageId, replyTo: null, workspaceId: null, body: 'Original Inbox body stays outside notification input' }, { deliveryMode: 'reference' })
  await appendReference('original-message')
  expect((await inner.messageQueue.prepareNotification({ notificationId: id, agentSessionId: 'recipient', condition,
    idle }))?.wire).toBe(wire)
  const control: AgentPromptInputControl = { idleOnly: idle }
  const submit = (changed: { message?: AgentPromptMessageContent; control?: AgentPromptInputControl } = {}) => coordinator.submitInputPlan(
    session, run(), id, wire, { kind: 'single-phase', data: wire + '\r' }, condition, completionId, undefined, false, undefined, 0,
    changed.message ?? message, 'default', undefined, undefined, undefined, key, changed.control ?? control)
  const submitIndependent = async (idleOnly: boolean) => {
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
  const submitOrdinary = async (agentSessionId: string, controlled: boolean) => {
    const current = h.client.agentSession(agentSessionId), prompt = 'Original unrelated human input'
    return controlled ? h.client.submitAgentPrompt({ agentSessionId, operationId: id, expectedRun: current.run,
      admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt, authorHuman: true })
      : coordinator.submitInputPlan(current, h.run(current.run.runId), id, prompt, { kind: 'single-phase', data: prompt + '\r' },
        { kind: 'manual-actor', expectedRun: current.run }, undefined, undefined, false, undefined, undefined,
        { userContent: prompt, authorHuman: true }, 'immediate')
  }
  return { ...h, key, message, prepare, send, submit, assertCurrent, dispose, readEvidence,
    changeEvidence: (value: AgentPromptExecutionEvidence | null) => { evidence = value }, beforePrepare: (callback: () => Promise<void>) => { beforePrepare = callback },
    changeByte: () => { inputByte++ }, submitIndependent, submitOrdinary, queue: inner.messageQueue,
    read: () => h.store.readPromptAdmission('recipient', original.run, id) }
}

it('admits an exact Provider initial idle without inventing a completed turn', async () => {
  const f = await fixture('admitted', false, true)
  await expect(f.submit()).resolves.toEqual(f.message)
  const record = await f.read()
  expect(record?.admission?.completionId).toBeUndefined()
  expect(record?.admission?.native).toMatchObject({ outcome: 'admitted', plan: { operation: 'queue-idle' } })
  expect(f.client.agentSession('recipient').semanticStatus).toBeUndefined()
  expect(f.readEvidence).toHaveBeenCalledTimes(2)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['source', 'identity', 'working', 'unknown'] as const)('rejects only the notice when its native idle %s changes before claim', async change => {
  const f = await fixture('admitted', false, true)
  f.beforePrepare(async () => f.changeEvidence(change === 'unknown' ? null : { state: change === 'working' ? 'working' : 'idle',
    sourceId: change === 'source' ? 'changed-source' : 'original-native-source', id: change === 'identity' ? 'changed-evidence' : 'initial-idle-evidence' }))
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
  expect(await f.read()).toBeNull(); expect(f.send).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('rechecks input bytes after the final awaited native idle observation', async () => {
  const f = await fixture('admitted', false, true), original = f.readEvidence.getMockImplementation()!
  f.readEvidence.mockImplementationOnce(original).mockImplementationOnce(async () => { f.changeByte(); return await original() })
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED' })
  expect((await f.read())?.admission).toMatchObject({ acknowledged: false, notApplied: true, native: { outcome: 'not-applied' } })
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('settles an existing claim not-applied when its final native idle evidence disappears, without replaying that key', async () => {
  const f = await fixture('admitted', false, true), original = f.readEvidence.getMockImplementation()!
  f.readEvidence.mockImplementationOnce(original).mockResolvedValueOnce(null)
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED' })
  const record = await f.read()
  expect(record?.admission).toMatchObject({ acknowledged: false, notApplied: true, native: { outcome: 'not-applied' } })
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED' })
  expect(await f.read()).toEqual(record); expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

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

it.each([true, false])('an independent input can share an unknown Native predecessor completion only as a typed idle notification (idleOnly=%s)', async idleOnly => {
  const f = await fixture('unknown')
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  const old = await f.read(), completion = agentTurnCompletionIdentity(f.client.agentSession('recipient'))
  if (idleOnly) await expect(f.submitIndependent(true)).resolves.toMatchObject({ a2aNotificationId: 'independent-notification' })
  else await expect(f.submitIndependent(false)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  expect(await f.read()).toEqual(old)
  expect(agentTurnCompletionIdentity(f.client.agentSession('recipient'))).toBe(completion)
  expect(f.send).toHaveBeenCalledTimes(idleOnly ? 2 : 1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an ordinary automatic input cannot reuse a Native predecessor completion after its ACK', async () => {
  const f = await fixture(); await f.submit()
  const old = await f.read()
  await expect(f.submitIndependent(false)).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
  expect(await f.read()).toEqual(old); expect(f.send).toHaveBeenCalledTimes(1)
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

it.each([true, false])('a normal manual prompt cannot take the exact key of a pending platform notice (controlled=%s)', async controlled => {
  const f = await fixture()
  await expect(f.submitOrdinary('recipient', controlled))
    .rejects.toMatchObject({ code: controlled ? 'AGENT_PROMPT_OPERATION_CONFLICT' : 'A2A_NOTIFICATION_CONFLICT' })
  expect(await f.read()).toBeNull(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.queue.readNotification(id))?.state).toBe('pending')
})

it.each([true, false])('an unrelated Session can use the same operation string as a notice without borrowing its key (controlled=%s)', async controlled => {
  const f = await fixture(), other = f.client.agentSession('caller')
  await expect(f.submitOrdinary('caller', controlled).then(() => true)).resolves.toBe(true)
  const key = { ...f.key, agentSessionId: other.agentSessionId, expectedRun: other.run }
  await expect.poll(async () => {
    const original = await f.client.inspectAgentPromptSubmission(key)
    return original?.admission?.acknowledged === true || original?.terminalPromptSubmission?.submit.acknowledged === true
  }, { timeout: 5_000 }).toBe(true)
  expect((await f.client.inspectAgentPromptSubmission(key))?.admission?.intent?.message).toMatchObject({ userContent: 'Original unrelated human input', authorHuman: true })
  expect(f.inner.kernel.input).toHaveBeenCalledWith(other.run.runId, expect.objectContaining({ data: expect.stringContaining('Original unrelated human input') }))
  expect(f.inner.kernel.input).not.toHaveBeenCalledWith(f.key.expectedRun.runId, expect.anything())
  expect(await f.read()).toBeNull(); expect((await f.queue.readNotification(id))?.key).toEqual(f.key)
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a private notification producer cannot use an unrelated Session key with the same notice ID', async () => {
  const f = await fixture(), other = f.client.agentSession('caller'), claim = vi.fn(async () => 'unrelated-effect')
  await expect(f.queue.withUncontrolledInputClaim({ ...f.key, agentSessionId: other.agentSessionId, expectedRun: other.run }, claim, undefined, id))
    .rejects.toMatchObject({ code: 'A2A_NOTIFICATION_CONFLICT' })
  expect(claim).not.toHaveBeenCalled(); expect(await f.read()).toBeNull(); expect((await f.queue.readNotification(id))?.key).toEqual(f.key)
})

it('an acknowledged ordinary prompt cannot sign for a different notification using the same operation ID', async () => {
  const f = await fixture(), operationId = 'original-human-prompt'
  await f.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId, expectedRun: f.key.expectedRun,
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Original unrelated human message', authorHuman: true })
  const key = { ...f.key, submissionId: operationId }
  await expect.poll(async () => {
    const original = await f.client.inspectAgentPromptSubmission(key)
    return original?.admission?.acknowledged === true || original?.terminalPromptSubmission?.submit.acknowledged === true
  }, { timeout: 5_000 }).toBe(true)
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
  await expect(f.submit()).rejects.toMatchObject({ code: changed === 'input-byte' ? 'AGENT_PROMPT_INPUT_NOT_APPLIED' : 'AGENT_COMPLETION_CHANGED' })
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


it('uses Provider-confirmed idle input without a managed actor and binds the original native handle', async () => {
  const f = await fixture('admitted', false)
  await expect(f.submit()).resolves.toEqual(f.message)
  const context = f.prepare.mock.calls[0]![0]
  expect(context).not.toHaveProperty('nativeActor')
  expect(context.nativeHandle).toEqual({ kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId })
  expect(context.processId).toBe(1234)
  expect(f.assertCurrent).toHaveBeenCalledTimes(2)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect((await f.read())?.admission).toMatchObject({ inputKey: f.key, acknowledged: true, native: { outcome: 'admitted', plan: { operation: 'queue-idle' } } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('lets the Provider witness its input channel independently of an existing frontend actor credential', async () => {
  const f = await fixture(), prepare = f.prepare.getMockImplementation()!
  f.prepare.mockImplementation(async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, plan: { ...prepared.plan, actorId: 'provider-confirmed-original-queue', protocolId: 'fixture-durable-queue' } }
  })
  await expect(f.submit()).resolves.toEqual(f.message)
  expect(f.assertCurrent).toHaveBeenCalledTimes(2)
  expect((await f.read())?.admission?.intent?.plan).toMatchObject({ actorId: 'provider-confirmed-original-queue', protocolId: 'fixture-durable-queue' })
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['before-claim', 'before-dispatch'] as const)('keeps exact source recheck failure %s distinct from an unknown native effect', async phase => {
  const f = await fixture('admitted', false), error = new Error('The prepared source object changed')
  if (phase === 'before-claim') f.assertCurrent.mockRejectedValueOnce(error)
  else f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)
  if (phase === 'before-claim') {
    await expect(f.submit()).rejects.toBe(error)
    expect(await f.read()).toBeNull()
  } else {
    await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', cause: error })
    const original = await f.read()
    expect(original?.admission).toMatchObject({ inputKey: f.key, notApplied: true, acknowledged: false, native: { outcome: 'not-applied' } })
    expect(original?.admission?.transport === 'native' && original.admission.native).not.toHaveProperty('errorCode')
    await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED' })
    expect(await f.read()).toEqual(original)
  }
  expect(f.send).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledTimes(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('awaits the Provider helper release before returning the native input receipt', async () => {
  const f = await fixture('admitted', false)
  let released = false
  f.dispose.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 5)); released = true })
  await f.submit()
  expect(released).toBe(true)
  expect(f.dispose).toHaveBeenCalledTimes(1)
})


it.each(['admitted', 'unknown'] as const)('keeps the original %s result when private helper cleanup fails and publishes a separate diagnostic', async outcome => {
  const f = await fixture(outcome, false)
  const publisher = Reflect.get(Reflect.get(f.client, 'promptSubmission'), 'deps').publisher as AgentMuxClientEventPublisher
  const publish = vi.spyOn(publisher, 'publish')
  f.dispose.mockRejectedValue(new Error('Private helper release failed'))
  if (outcome === 'admitted') await expect(f.submit()).resolves.toEqual(f.message)
  else await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  expect((await f.read())?.admission).toMatchObject({ native: { outcome }, acknowledged: outcome === 'admitted' })
  const diagnostic = publish.mock.calls.map(([event]) => event).find(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_INPUT_CLEANUP_FAILED')
  expect(diagnostic).toMatchObject({ type: 'agent-error', code: 'AGENT_NATIVE_INPUT_CLEANUP_FAILED', evidence: { run: f.key.expectedRun } })
  expect(diagnostic).not.toHaveProperty('agentSessionId')
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
