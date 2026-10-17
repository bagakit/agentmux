import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxFileAgentSessionStore, sessionHistoryMetadata } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxAgentCreateInput } from '../src/client.js'
import { parseAgentSpawnCreator } from '../src/agent-spawn.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { spawnOwnerFixture } from './helpers/a2a-spawn-owner.js'
import { agentCreationIntentDigest } from '../src/agent-creation-authority.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Private spawn fixture cleanup failed')
})

const fixture = (remote = false) => spawnOwnerFixture(cleanups, remote)

const creator = { agentSessionId: 'creator', run: { runId: 'run-creator' }, owner: { kind: 'local' } }

it('no-prompt creation freezes the authenticated creator and discloses it through the current source Unix RPC without a message', async () => {
  const h = await fixture(), before = await h.spatial.readForLayout()
  const result = await h.create()
  expect(result.creation).toMatchObject({ createdBy: creator, initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  expect(result.session.creation?.createdBy).toEqual(creator)
  expect(result.creation.createdRun).toEqual({ runId: 'child-run-1' })
  const original = await new AgentMuxFileAgentSessionStore(h.store.path).readMetadata('child')
  expect(original?.creation?.createdBy).toEqual(creator)
  const inspection = await h.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'child' } })
  expect(inspection.session.creation?.createdBy).toEqual(creator)
  const childRpc = await connectAgentMuxRpc({ endpoint: h.endpoint,
    credentials: { agentSessionId: 'child', capability: h.launches[0]!.env.AGENTMUX_AGENT_CAPABILITY! } })
  cleanups.push(() => childRpc.dispose())
  expect((await childRpc.call('whoami', {})).session.creation?.createdBy).toEqual(creator)
  const wire = h.launches[0]!.args.join('\n')
  expect(wire).toContain('created by AgentMux Session creator, Run run-creator')
  expect(wire).toContain('No request yet. Wait for the user.')
  expect(wire).not.toContain(h.capability)
  expect(await h.store.loadCreationSessionId('original-spawn')).toBe('child')
  expect(await h.client.resolveAgentCreationSessionId('original-spawn')).toBe('child')
  expect((await h.create()).session.run).toEqual(result.session.run)
  expect(h.start).toHaveBeenCalledOnce()
  expect(await h.spatial.readForLayout()).toEqual(before)
  for (const name of ['input', 'stop', 'attach', 'detach']) expect(h.inner.kernel[name]).not.toHaveBeenCalled()
  expect((await h.client.listMessages({ participantSessionId: 'creator', direction: 'outgoing', caller: h.credentials })).messages).toEqual([])
})

it('an unknown original start retains creator in the no-Run seed and reconciles that same Run without another start', async () => {
  const h = await fixture(), actualStart = h.start.getMockImplementation()!
  h.start.mockImplementationOnce(async input => { await actualStart(input); throw new Error('Original start acknowledgement lost') })
  await expect(h.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  const pending = await new AgentMuxFileAgentSessionStore(h.store.path).loadCreationCorrelation('child')
  expect(pending?.preparedCreation?.creation?.createdBy).toEqual(creator)
  expect(pending?.preparedCreation).not.toHaveProperty('run')
  expect(JSON.stringify(pending)).not.toContain(h.capability)
  const recovered = await h.create()
  expect(recovered.session.run).toEqual({ runId: 'child-run-1' })
  expect(recovered.creation.createdBy).toEqual(creator)
  await expect(h.create({ creationCaller: { agentSessionId: 'unrelated', capability: h.capability } }))
    .rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  expect(h.start).toHaveBeenCalledOnce()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('a forged creation caller refuses only that operation and the healthy original creator can still create', async () => {
  const h = await fixture()
  await expect(h.create({ creationCaller: { agentSessionId: 'creator', capability: 'invalid' } }))
    .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(h.start).not.toHaveBeenCalled()
  expect((await h.create()).creation.createdBy).toEqual(creator)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  await expect(h.create({ createdBy: creator } as unknown as Partial<AgentMuxAgentCreateInput>))
    .rejects.toBeInstanceOf(AgentMuxError)
})

it('retired reading metadata retains original creation as facts without retaining credentials', async () => {
  const h = await fixture(), result = await h.create()
  const original = (await h.store.readMetadata(result.session.agentSessionId))!
  const history = sessionHistoryMetadata(original)
  expect(history.creation?.createdBy).toEqual(creator)
  expect(history.creation?.createOperationId).toBe('original-spawn')
  expect(history).not.toHaveProperty('capabilityHash')
  expect(history).not.toHaveProperty('hookToken')
  expect(history).not.toHaveProperty('run')
})

it('creator structure rejects additional authority and preserves exact remote owner rather than a display alias', () => {
  expect(parseAgentSpawnCreator(creator)).toEqual(creator)
  const remote = { ...creator, owner: { kind: 'runtime', runtimeId: 'original-source-runtime' } }
  expect(parseAgentSpawnCreator(remote)).toEqual(remote)
  for (const invalid of [{ ...creator, verified: true }, { ...creator, owner: { kind: 'local', runtimeId: 'claimed' } },
    { ...creator, run: { runId: '' } }]) expect(() => parseAgentSpawnCreator(invalid)).toThrow()
})

it('original message creation intent stays canonical when its already authenticated author is also the creation caller', async () => {
  const h = await fixture(), message = { callerAgentSessionId: 'creator', capability: h.capability }
  const first = await h.create({ initialMessage: message, prompt: '  Original task\n正文  ' }, false)
  const repeated = await h.create({ initialMessage: message, prompt: '  Original task\n正文  ' })
  expect(repeated.session.run).toEqual(first.session.run)
  expect(repeated.creation.intentDigest).toBe(first.creation.intentDigest)
  expect(first.creation.intentDigest).toBe(agentCreationIntentDigest({ agentSessionId: 'child', createOperationId: 'original-spawn',
    providerId: 'claude', executorId: 'private-executor', workspacePath: h.root, injectAgentMuxGuide: false,
    prompt: '  Original task\n正文  ', initialMessage: { callerAgentSessionId: 'creator', run: { runId: 'run-creator' }, threadId: undefined } }))
  expect(first.creation.initialMessageId).toBeDefined()
  expect(h.start).toHaveBeenCalledOnce()
  expect(h.launches[0]!.args.join('\n')).toContain('  Original task\n正文  ')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('a frozen initial-message seed keeps the original operation when an identical creator is supplied on reconciliation', async () => {
  const h = await fixture(), launch = h.start.getMockImplementation()!
  h.start.mockImplementationOnce(async input => { await launch(input); throw new Error('Original authored start ACK lost') })
  const initialMessage = { callerAgentSessionId: 'creator', capability: h.capability }
  await expect(h.create({ initialMessage, prompt: 'Original discussion' }, false))
    .rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  const result = await h.create({ initialMessage, prompt: 'Original discussion' })
  expect(result.creation.createdBy).toEqual(creator)
  expect(result.creation.createdRun).toEqual({ runId: 'child-run-1' })
  expect(h.start).toHaveBeenCalledOnce()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('source parser and Unix RPC read both indexed directions with bound pagination without Runtime or input effects', async () => {
  const h = await fixture()
  await h.create({ agentSessionId: 'child-a', createOperationId: 'spawn-a' })
  await h.create({ agentSessionId: 'child-b', createOperationId: 'spawn-b' })
  await h.create({ agentSessionId: 'unrelated-child', createOperationId: 'unrelated-spawn', creationCaller: { agentSessionId: 'unrelated', capability: h.capability } })
  const metadata = vi.spyOn(h.store, 'loadMetadata').mockRejectedValue(new Error('Unrelated Session inventory must not enter relation reading'))
  const runtime = vi.spyOn(h.client, 'connectRuntime').mockRejectedValue(new Error('Relation reading must not connect Runtime'))
  const invocation = await parseAgentMuxCliInvocation(['agent', 'spawn', 'ls', '--host', 'local', '--session', 'creator', '--direction', 'created', '--limit', '1'])
  expect(invocation.command.method).toBe('agent.spawn.ls')
  const query = invocation.params as { hostId: string; participantSessionId: string; direction: 'created'; limit: number }
  const first = await h.rpc.call('agent.spawn.ls', query)
  expect(first.records.map(row => row.agentSessionId)).toEqual(['child-a'])
  expect(first.coverage).toEqual({ scope: 'selected-owner', history: 'recorded-creations' })
  expect(first.nextCursor).not.toBeNull()
  const second = await h.rpc.call('agent.spawn.ls', { ...query, cursor: first.nextCursor! })
  expect(second.records.map(row => row.agentSessionId)).toEqual(['child-b'])
  expect(second.nextCursor).toBeNull()
  const { hostId: _route, ...read } = query
  const reopened = await new AgentMuxFileAgentSessionStore(h.store.path).listSpawns({ ...read, cursor: first.nextCursor! })
  expect(reopened.records.map(row => row.agentSessionId)).toEqual(['child-b'])
  const child = await connectAgentMuxRpc({ endpoint: h.endpoint, credentials: { agentSessionId: 'child-a', capability: h.launches[0]!.env.AGENTMUX_AGENT_CAPABILITY! } })
  cleanups.push(() => child.dispose())
  const origin = await child.call('agent.spawn.ls', { hostId: 'local', participantSessionId: 'child-a', direction: 'creator' })
  expect(origin.records).toHaveLength(1)
  expect(origin.records[0]!.creation.createdBy).toEqual(creator)
  await expect(h.rpc.call('agent.spawn.ls', { ...query, direction: 'creator', cursor: first.nextCursor! })).rejects.toBeDefined()
  await expect(h.rpc.call('agent.spawn.ls', { ...query, participantSessionId: 'unrelated' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const altered = structuredClone(first); altered.records = [...altered.records, ...altered.records]
  expect(() => parseRpcNativeResult('agent.spawn.ls', altered, query, h.credentials)).toThrow()
  expect(metadata).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled()
  expect(h.start).toHaveBeenCalledTimes(3)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('retirement preserves the same indexed relation and birth Run after a real Store reopen', async () => {
  const h = await fixture(), first = await h.create()
  await h.client.stopAgent('child', first.session.run)
  const reopened = new AgentMuxFileAgentSessionStore(h.store.path)
  expect(await reopened.readMetadata('child')).toBeNull()
  const page = await reopened.listSpawns({ participantSessionId: 'creator', direction: 'created' })
  expect(page.records).toHaveLength(1)
  expect(page.records[0]).toMatchObject({ agentSessionId: 'child', phase: 'retired', creation: { createdBy: creator, createdRun: first.session.run } })
  expect((await reopened.readHistorySource('child'))?.history?.creation?.createdBy).toEqual(creator)
})

it.each([false, true])('native no-input takeover preserves unrequested context and the original identity even after a lost start ACK (lost=%s)', async lost => {
  const h = await fixture(), provider = h.client.providers.get('claude')
  if (!provider.assertNativeResumeSource) throw new Error('The selected Provider must own native source verification')
  vi.spyOn(provider as Required<Pick<typeof provider, 'assertNativeResumeSource'>>, 'assertNativeResumeSource').mockResolvedValue()
  const nativeResumeSource = { nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'original-native', transcriptPath: join(h.root, 'retained.jsonl') },
    workspacePath: h.root, revision: 'a'.repeat(64) }
  if (lost) {
    const launch = h.start.getMockImplementation()!
    h.start.mockImplementationOnce(async input => { await launch(input); throw new Error('Original no-input takeover ACK lost') })
    await expect(h.create({ nativeResumeSource })).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
    expect((await h.store.loadCreationCorrelation('child'))?.preparedCreation?.creation?.agentMuxContext).toBeUndefined()
  }
  const result = await h.create({ nativeResumeSource })
  expect(result.creation).toMatchObject({ createdBy: creator, createdRun: result.session.run, initialPrompt: 'not-requested' })
  expect(result.creation.agentMuxContext).toBeUndefined()
  expect(result.promptConfirmed).toBe(true)
  expect(result.session.nativeHandle).toEqual(nativeResumeSource.nativeHandle)
  expect(h.launches[0]!.args.join('\n')).not.toContain('created by AgentMux')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.start).toHaveBeenCalledOnce()
})

it('the original public discuss path returns one creation and the exact first-message reference on retry', async () => {
  const h = await fixture(), request = { executorId: 'private-executor', providerId: 'claude', text: '  Original delegated task\n正文  ', operationId: 'original-discussion' }
  const first = await h.rpc.call('agent.discuss', request)
  expect(first.creation).toMatchObject({ createdBy: creator, createdRun: { runId: 'child-run-1' }, createOperationId: request.operationId })
  expect(first.creation.initialMessageId).toBeDefined()
  expect((await h.rpc.call('agent.discuss', request)).targetAgentSessionId).toBe(first.targetAgentSessionId)
  const messages = await h.client.listMessages({ participantSessionId: 'creator', direction: 'outgoing', caller: h.credentials })
  expect(messages.messages).toHaveLength(1)
  expect(messages.messages[0]!.envelope).toMatchObject({ messageId: first.creation.initialMessageId, senderSessionId: 'creator' })
  expect((await h.client.readMessage({ messageId: first.creation.initialMessageId!, caller: h.credentials }))?.envelope.body).toBe(request.text)
  expect(h.start).toHaveBeenCalledOnce(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('a fork records its authenticated creator separately from its original native conversation source', async () => {
  const h = await fixture(), before = (await h.store.readMetadata('unrelated'))!
  const native = { kind: 'provider' as const, providerId: 'claude', sessionId: 'original-native', transcriptPath: join(h.root, 'original-native.jsonl') }
  await h.store.compareAndSwapMetadata(before, { ...before, providerId: 'claude', executorId: 'private-executor', nativeHandle: native })
  const kernel = h.inner.kernel as unknown as { status(runId: string): Promise<CtxmuxAdapterRun> }
  vi.spyOn(kernel, 'status').mockImplementation(async runId => ({ ...h.run(runId),
    state: runId === 'run-unrelated' ? { type: 'exited', code: 0, signal: null } : { type: 'running' } }))
  const forkSource = { agentSessionId: 'unrelated', expectedRun: { runId: 'run-unrelated' }, expectedNativeHandle: native }
  const result = await h.create({ forkSource })
  expect(result.session.forkedFrom).toEqual(forkSource)
  expect(result.creation.createdBy).toEqual(creator)
  expect(result.creation.createdRun).toEqual(result.session.run)
  expect(result.creation.initialMessageId).toBeUndefined()
  expect(h.start).toHaveBeenCalledOnce(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})
