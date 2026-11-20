import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { openDemandStore, type DemandQualifiedDispatchIntent } from '@agentmux/demand'
import { GoalDispatchInputOwner } from '../src/goal-dispatch-input.js'
import { goalFiniteInputPort } from '../src/goal-finite-runtime.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { DurableAgentMuxMessageQueue } from '../../../packages/core/src/agent-global-message-queue.js'
import type { AgentProvider } from '../../../packages/core/src/agent-provider.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'

const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const original = (): DemandQualifiedDispatchIntent => ({ operationId: 'original-Goal-OP', target: { kind: 'space-member',
  source: { runtimeId: 'B', spaceId: 'Space', regionId: 'Region', admission: { kind: 'creation', operationId: 'C' } },
  execution: { runtimeId: 'original-runtime', agentSessionId: 'recipient' } }, runId: 'run-recipient', execution: 'finite', prompt: 'Original Goal body', agentMuxNote: 'Original independent Goal note' })
const key = () => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: original().operationId })

/** Real original Demand writer -> Host input owner -> SDK -> Unix/public Hosted ->
 * Core authorization/journal/Provider. The final native byte port is controlled. */
async function fixture() {
  const h = await rpcOwnerFixture(['recipient']); cleanup.push(h.close)
  const actor = { protocolId: 'goal-native-protocol', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  const row = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(row, { ...row, nativeActor: actor, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native-thread' } })
  await h.inner.registry.load('local')
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 1234 }))
  const provider = (h.client as unknown as { providers: { get(id: string): AgentProvider } }).providers.get('codex'), previous = provider.prepareNativeInput
  const send = vi.fn<NonNullable<Awaited<ReturnType<NonNullable<AgentProvider['prepareNativeInput']>>>>['send']>(async () => ({ outcome: 'admitted', turnId: 'original-native-turn' }))
  provider.prepareNativeInput = async (context, selected) => {
    expect(context.nativeActor).toEqual(actor); expect(selected.nativeSessionId).toBe('original-native-thread')
    return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), threadId: selected.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose: async () => {} }
  }
  cleanup.push(() => { if (previous) provider.prepareNativeInput = previous; else delete provider.prepareNativeInput })
  const hosted = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client)); cleanup.push(() => hosted.dispose())
  const socketPath = join(h.root, 'goal-input.sock'), server = new AgentMuxControlServer({ socketPath, coreClients: h.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc, expectedRuntimeId: 'original-runtime', connectOnDemand: true, agentSessionIds: ['recipient'] })
  const port = goalFiniteInputPort(client, original().target, original().runId); cleanup.push(() => port.dispose())
  const demands = openDemandStore({ root: join(h.root, 'original-goals') })
  await seedStoredDemand(demands, { id: 'original-goal', title: 'Original Goal', assigneeSessionIds: [original().target] })
  await demands.prepareDispatch('original-goal', original())
  const owner = new GoalDispatchInputOwner(demands, { sessionTimeline: async () => { throw new Error('A qualified input must not use legacy Session timeline matching') } })
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  const retain = async (prompt = original().prompt, note = original().agentMuxNote, authorHuman = false) => await queue.savePromptInput({ key: key(), admissionIntent: { kind: 'session-conversation', expectedRun: key().expectedRun }, execution: 'immediate', environment: { providerId: 'codex', executorId: 'codex' }, source: { kind: 'prompt', prompt, authorHuman, sourceChannel: 'api', ...(note === undefined ? {} : { agentMuxNote: note }) } })
  return { ...h, client, demands, owner, port, send, retain, ref: { goalId: 'original-goal', operationId: original().operationId } }
}

it.each(['body', 'note', 'author'] as const)('refuses another producer’s same-key %s before any original waiting input can be rejoined', async changed => {
  const h = await fixture(), foreign = await h.retain(changed === 'body' ? 'Another producer body' : original().prompt, changed === 'note' ? 'Another independent note' : original().agentMuxNote, changed === 'author')
  await h.demands.recordDispatchPhase(h.ref.goalId, h.ref.operationId, { stage: 'submitted' })
  const rejoin = vi.spyOn(h.client, 'rejoinAgentInputWaiting')
  const failure = await h.owner.submitQualified(h.ref, h.port, true).then(() => null, error => error)
  expect(foreign).not.toBeNull(); if (!foreign) throw Error('The original fixture input was not persisted')
  expect(rejoin).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.rawInput).not.toHaveBeenCalled()
  expect(failure).toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  const retained = await h.client.inspectAgentInput({ key: key() })
  expect(retained?.ref).toEqual(foreign.control.ref); expect(retained?.status).toBe('waiting')
  expect((await h.demands.inspectDispatch(h.ref.goalId, h.ref.operationId))?.prompt).toBe(original().prompt)
  expect((await h.client.readAgentSession('recipient'))?.run).toEqual({ runId: original().runId })
})

it('explicitly resumes the same original submitted operation through canonical intake and records its exact original Core receipt', async () => {
  const h = await fixture(); await h.retain()
  await h.demands.recordDispatchPhase(h.ref.goalId, h.ref.operationId, { stage: 'submitted' })
  // Read-only Check never wakes the retained waiting request.
  await expect(h.owner.reconcileQualified(h.ref, h.port)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(h.send).not.toHaveBeenCalled()
  await h.owner.submitQualified(h.ref, h.port, true)
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key() }))?.status).toBe('admitted')
  await h.owner.reconcileQualified(h.ref, h.port)
  expect(await h.demands.inspectDispatch(h.ref.goalId, h.ref.operationId)).toMatchObject({ ...original(), stage: 'confirmed', receipt: { kind: 'core-input', inputKey: key(), outcome: 'admitted' } })
  await h.owner.submitQualified(h.ref, h.port, true)
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.rawInput).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})


it('a late first public RPC cannot regress a confirmed original receipt or send another input', async () => {
  const h = await fixture()
  let release!: () => void, received!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), initial = new Promise<void>(resolve => { received = resolve })
  const first = h.owner.submitQualified(h.ref, { ...h.port, submit: async input => { const result = await h.port.submit(input); received(); await held; return result } }, false).catch(error => error)
  await initial
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key() }))?.status).toBe('admitted')
  await h.owner.reconcileQualified(h.ref, h.port)
  release(); await first
  expect(await h.demands.inspectDispatch(h.ref.goalId, h.ref.operationId)).toMatchObject({ ...original(), stage: 'confirmed', receipt: { kind: 'core-input', inputKey: key() } })
  await h.owner.submitQualified(h.ref, h.port, true)
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.rawInput).not.toHaveBeenCalled()
})

it('retains an unknown native claim and never replays its input during Check or explicit original continuation', async () => {
  const h = await fixture()
  h.send.mockImplementation(async () => { throw new Error('Native ACK lost after original send') })
  await h.owner.submitQualified(h.ref, h.port, false).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key() }))?.status).toBe('unknown')
  const canonical = await h.client.inspectAgentInput({ key: key() })
  await expect(h.owner.reconcileQualified(h.ref, h.port)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(h.owner.submitQualified(h.ref, h.port, true)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(await h.client.inspectAgentInput({ key: key() })).toEqual(canonical)
  expect(await h.demands.inspectDispatch(h.ref.goalId, h.ref.operationId)).toMatchObject({ ...original(), stage: 'unknown' })
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.rawInput).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('read-only inspection does not adopt another producer’s admitted content from its same-key receipt', async () => {
  const h = await fixture(), note = original().agentMuxNote
  await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: key().expectedRun, operationId: original().operationId,
    prompt: 'Another producer body', ...(note === undefined ? {} : { agentMuxNote: note }), admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: false, sourceChannel: 'api' })
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key() }))?.status).toBe('admitted')
  await expect(h.owner.reconcileQualified(h.ref, h.port)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(await h.demands.inspectDispatch(h.ref.goalId, h.ref.operationId)).toMatchObject({ ...original(), stage: 'prepared' })
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.rawInput).not.toHaveBeenCalled()
})


it('an empty journal read also checks the original claim without submitting or rejoining input', async () => {
  const h = await fixture(), inspectClaim = vi.spyOn(h.client, 'inspectAgentPromptSubmission'), rejoin = vi.spyOn(h.client, 'rejoinAgentInputWaiting')
  expect(await h.port.inspectOriginal(original())).toBeNull()
  expect(inspectClaim).toHaveBeenCalledExactlyOnceWith(key())
  expect(rejoin).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.rawInput).not.toHaveBeenCalled()
  expect(await h.demands.inspectDispatch(h.ref.goalId, h.ref.operationId)).toMatchObject({ ...original(), stage: 'prepared' })
})

it('explicit original continuation delegates a wholly not-applied attempt to Core’s same-key retry gate', async () => {
  const h = await fixture()
  h.send.mockImplementationOnce(async () => ({ outcome: 'not-applied', errorCode: -32600 }))
  await h.owner.submitQualified(h.ref, h.port, false).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key() }))?.status).toBe('not-applied')
  const prior = await h.client.inspectAgentInput({ key: key() })
  await h.owner.submitQualified(h.ref, h.port, true).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key() }))?.status).toBe('admitted')
  await h.owner.reconcileQualified(h.ref, h.port)
  const canonical = await h.client.inspectAgentInput({ key: key() })
  expect(canonical?.key).toEqual(key()); expect(canonical?.ref.key).toEqual(key())
  expect(canonical?.ref.waitGeneration).toBeGreaterThan(prior!.ref.waitGeneration)
  expect(await h.demands.inspectDispatch(h.ref.goalId, h.ref.operationId)).toMatchObject({ ...original(), stage: 'confirmed', receipt: { kind: 'core-input', inputKey: key(), outcome: 'admitted' } })
  expect(h.send).toHaveBeenCalledTimes(2); expect(h.rawInput).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
