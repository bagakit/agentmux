import { afterEach, expect, it, vi } from 'vitest'
import { connectSpaceMember } from '../src/space-member-client.js'
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import { consumeConversationWindowPage, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '../src/conversation-changes.js'
import type { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks() })
it('the actual two-Core member SDK reads the exact full foreign Session and sends input only to its current original Run', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-original-sid'
  const local = await f.b.put(sid), remote = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-member-op')
  const write = vi.spyOn(f.d.core, 'writeAgent').mockResolvedValue({ runId: remote.run.runId, appliedByteRange: { startByte: 0, endByte: 4 }, acceptedThroughByte: 4 })
  const localWrite = vi.spyOn(f.b.core, 'writeAgent').mockRejectedValue(Error('The observer-local same SID must never receive this input'))
  const target = { reference: f.reference, regionId: admission.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: remote.run }
  const client = await connectSpaceMember(f.b.rpc, target); cleanup.push(() => client.dispose()); await client.readAgentSession(sid)
  const calls = vi.spyOn(f.d.hosted, 'call')
  calls.mockClear()
  await client.writeAgent({ agentSessionId: sid, expectedRun: remote.run, data: 'ping', source: 'user' })
  const effects = calls.mock.calls.map(call => [call[0], call[0] === 'runtime.invoke' ? (call[1] as { invocation: { method: string } }).invocation.method : null])
  expect(effects, JSON.stringify(effects)).toEqual([['runtime.invoke', 'writeAgent']])
  await client.connect()
  expect(client.agentSessions()).toMatchObject([{ agentSessionId: sid, workspacePath: remote.workspacePath, capabilityHash: expect.any(String) }])
  expect(client.agentSessions()[0]?.workspacePath).not.toBe(local.workspacePath)
  expect(write).toHaveBeenCalledOnce(); expect(write.mock.calls[0]?.[0]).toMatchObject({ agentSessionId: sid, expectedRun: remote.run, data: 'ping' }); expect(localWrite).not.toHaveBeenCalled()
  await expect(client.writeAgent({ agentSessionId: sid, expectedRun: { runId: 'another-run' }, data: 'wrong', source: 'user' })).rejects.toMatchObject({ code: 'SPACE_MEMBER_TARGET_MISMATCH' })
  expect(write).toHaveBeenCalledOnce()
  const wrong = await connectSpaceMember(f.b.rpc, { ...target, reference: { ...target.reference, runtimeId: 'another-original-space-core' } }); cleanup.push(() => wrong.dispose())
  await expect(wrong.writeAgent({ agentSessionId: sid, expectedRun: remote.run, data: 'wrong-source', source: 'user' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(write).toHaveBeenCalledOnce()
  const state = (await f.b.spatial.read())!
  await f.b.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph, tabs: state.graph.tabs.map(tab => tab.tabId === admission.address.tabId ? { ...tab, regionIds: [] } : tab), regions: state.graph.regions.filter(region => region.regionId !== target.regionId), tabLayouts: {} }, allowEntityRemoval: true })
  await expect(client.writeAgent({ agentSessionId: sid, expectedRun: remote.run, data: 'removed', source: 'user' })).rejects.toMatchObject({ code: 'SPACE_MEMBER_NOT_FOUND' })
  expect(write).toHaveBeenCalledOnce(); expect(await f.d.core.readAgentSession(sid)).toMatchObject({ run: remote.run })
  for (const c of [f.b, f.d]) { expect(c.inventory).not.toHaveBeenCalled(); expect(c.runs).not.toHaveBeenCalled(); expect(c.all).not.toHaveBeenCalled() }
})
it('the finite member parser rejects another Session, Run, inventory and native approval without changing an existing Agent', () => {
  const target = { reference: { runtimeId: 'B', spaceId: 'project' }, regionId: 'region', runtimeId: 'D', agentSessionId: 'sid', expectedRun: { runId: 'run' } }
  const input = (method: string, first: unknown) => ({ target, call: { method: 'runtime.invoke', params: { consumerId: 'reader', fence: { runtimeId: 'D', ownerInstanceId: 'D-instance' }, invocation: { method, args: [first] } } } })
  expect(() => parseSpaceMemberParams('space.member.call', input('readAgentSession', 'other-sid'))).toThrow()
  const fabricated = input('runtimeSubject', { kind: 'agent-session', agentSessionId: 'sid' }); fabricated.call.params.invocation.args.push({ runId: 'run', state: 'running', pid: 123 })
  expect(() => parseSpaceMemberParams('space.member.call', fabricated)).toThrow('known Runtime fact')
  expect(() => parseSpaceMemberParams('space.member.call', input('writeAgent', { agentSessionId: 'sid', expectedRun: { runId: 'other-run' } }))).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('readAgentSessions', {}))).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('respondAgentInteraction', { agentSessionId: 'sid', expectedRun: { runId: 'run' } }))).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('readAgentConversation', { hostId: 'local', agentSessionId: 'another-sid' }))).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('readAgentConversation', { hostId: 'other-host', agentSessionId: 'sid' }))).toThrow()
  const options = input('conversationCheckpoint', { hostId: 'local', agentSessionId: 'sid' }); options.call.params.invocation.args.push({ caller: { agentSessionId: 'another-sid' } })
  expect(() => parseSpaceMemberParams('space.member.call', options)).toThrow()
  const watch = (ref: unknown) => ({ target, call: { method: 'runtime.conversation-watch', params: { consumerId: 'reader', fence: { runtimeId: 'D', ownerInstanceId: 'D-instance' }, reference: ref } } })
  expect(() => parseSpaceMemberParams('space.member.watch', watch({ hostId: 'local', agentSessionId: 'another-sid' }))).toThrow()
})

it('the actual two-Core member SDK reads, follows and releases only the original conversation, preserving fragmented records', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-conversation-sid'
  await f.b.put(sid); const session = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'conversation-member-op')
  const store = (f.d.core as unknown as { store: AgentMuxMemoryAgentSessionStore }).store
  const originalBody = 'Original D conversation body. '.repeat(3000)
  await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'original-D-record', agentSessionId: sid,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original result', content: originalBody, createdAt: 1, updatedAt: 1 } })
  const target = { reference: f.reference, regionId: admission.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: session.run }
  const client = await connectSpaceMember(f.b.rpc, target); cleanup.push(() => client.dispose())
  const observerRead = vi.spyOn(f.b.core, 'readAgentConversation').mockRejectedValue(Error('The Source-local same SID must not supply conversation content'))
  let pending: ConversationWindowAssembly | undefined, snapshot: ConversationWindowSnapshot | undefined, cursor: string | undefined, pages = 0
  for (; pages < 100; pages++) {
    const page = await client.readAgentConversation({ hostId: 'local', agentSessionId: sid, maxBytes: 16 * 1024, ...(cursor ? { cursor } : {}) })
    const assembled = consumeConversationWindowPage(page, pending)
    if (assembled.kind === 'complete') { snapshot = assembled.snapshot; pending = undefined; if (!page.nextCursor) break }
    else pending = assembled.pending
    cursor = page.nextCursor ?? undefined
  }
  expect(pages).toBeGreaterThan(0); expect(snapshot).toBeDefined()
  expect(JSON.stringify(snapshot)).toContain(originalBody)
  expect(observerRead).not.toHaveBeenCalled()
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.d.server.path, 'agent', 'conversation', 'inspect', '--input', '-'], objectCliEnvironment(f.d.root),
    JSON.stringify({ hostId: 'local', agentSessionId: sid, maxBytes: 4 * 1024 * 1024 }))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.stringify(JSON.parse(cli.stdout).result)).toContain(originalBody)
  const checkpoint = await client.conversationCheckpoint({ hostId: 'local', agentSessionId: sid })
  const watch = await client.observeConversation({ hostId: 'local', agentSessionId: sid, view: snapshot!.window.view! }, () => {})
  expect(watch.agentSessionId).toBe(sid)
  const changed = await client.readConversationChanges({ hostId: 'local', agentSessionId: sid, checkpoint: checkpoint.checkpoint, view: snapshot!.window.view!, maxBytes: 16 * 1024 })
  expect(changed.agentSessionId).toBe(sid); expect(changed.window.id).toBe(snapshot!.window.id)
  await expect(client.readAgentConversation({ hostId: 'local', agentSessionId: 'different-sid' })).rejects.toMatchObject({ code: 'SPACE_MEMBER_TARGET_MISMATCH' })
  watch.dispose(); expect(watch.closed.aborted).toBe(true)
  expect(await client.releaseConversationView({ hostId: 'local', agentSessionId: sid, view: snapshot!.window.view! })).toMatchObject({ agentSessionId: sid, released: true })
  expect(await f.d.core.readAgentSession(sid)).toMatchObject({ run: session.run })
  for (const core of [f.b, f.d]) { expect(core.inventory).not.toHaveBeenCalled(); expect(core.runs).not.toHaveBeenCalled(); expect(core.all).not.toHaveBeenCalled() }
})

it('a managed caller cannot acquire a member control identity through the public wrapper', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'managed-original'
  const session = await f.b.put(sid), admission = await f.admit('local', f.b.owner.runtimeId, sid, 'managed-member-op')
  const { connectAgentMuxRpc } = await import('../src/public-rpc-client.js')
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.b.server.path }, credentials: { agentSessionId: sid, capability: 'private-original-capability' } }); cleanup.push(() => rpc.dispose())
  const client = await connectSpaceMember(rpc, { reference: f.reference, regionId: admission.address.regionId, runtimeId: f.b.owner.runtimeId, agentSessionId: sid, expectedRun: session.run }); cleanup.push(() => client.dispose())
  await expect(client.readAgentSession(sid)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(await f.b.core.readAgentSession(sid)).toMatchObject({ run: session.run })
})

it('routes original input waiting controls and SIGINT through the finite member SDK only', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-control-sid'
  await f.b.put(sid); const session = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-control-C')
  const target = { reference: f.reference, regionId: admission.address.regionId, runtimeId: f.d.owner.runtimeId,
    agentSessionId: sid, expectedRun: session.run, expectedAdmission: { kind: 'creation' as const, operationId: 'original-control-C' } }
  const client = await connectSpaceMember(f.b.rpc, target); cleanup.push(() => client.dispose())
  const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: session.run, submissionId: 'original-control-input' }
  const ref = { key, waitGeneration: 1 }
  const stop = vi.spyOn(f.d.core, 'stopAgentInputWaiting').mockResolvedValue({ ref, cancelOperationId: 'original-cancel', outcome: 'observation-stopped', at: 1 })
  const observerStop = vi.spyOn(f.b.core, 'stopAgentInputWaiting').mockRejectedValue(Error('The observer must not stop this input'))
  const rejoin = vi.spyOn(f.d.core, 'rejoinAgentInputWaiting').mockResolvedValue({ key, ref, persistence: 'confirmed', status: 'waiting', observation: 'owned', admission: null,
    control: { ref, state: 'enabled', at: 1, waiting: { phase: 'session', reason: 'session-resume-needed', wake: 'session-restored' } } })
  const signal = vi.spyOn(f.d.core, 'signalAgent').mockResolvedValue()
  const observerSignal = vi.spyOn(f.b.core, 'signalAgent').mockRejectedValue(Error('The observer must not signal this Run'))
  await expect(client.stopAgentInputWaiting({ ref, cancelOperationId: 'original-cancel' })).resolves.toMatchObject({ ref, outcome: 'observation-stopped' })
  await expect(client.rejoinAgentInputWaiting({ ref })).resolves.toMatchObject({ key, ref })
  await client.signalAgent(sid, session.run, 'SIGINT')
  expect(stop).toHaveBeenCalledExactlyOnceWith({ ref, cancelOperationId: 'original-cancel' })
  expect(rejoin).toHaveBeenCalledOnce(); expect(rejoin.mock.calls[0]?.[0]).toEqual({ ref })
  expect(signal).toHaveBeenCalledExactlyOnceWith(sid, session.run, 'SIGINT')
  expect(observerStop).not.toHaveBeenCalled(); expect(observerSignal).not.toHaveBeenCalled()
  await expect(client.signalAgent(sid, session.run, 'SIGTERM')).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(client.stopAgentInputWaiting({ ref: { ...ref, key: { ...key, agentSessionId: 'another-sid' } }, cancelOperationId: 'wrong-member' })).rejects.toMatchObject({ code: 'SPACE_MEMBER_TARGET_MISMATCH' })
  expect(signal).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce()
})

it('member input control codecs reject another target, arbitrary signals and injected caller arguments', () => {
  const target = { reference: { runtimeId: 'B', spaceId: 'project' }, regionId: 'region', runtimeId: 'D', agentSessionId: 'sid', expectedRun: { runId: 'run' } }
  const input = (method: string, args: unknown[]) => ({ target, call: { method: 'runtime.invoke', params: { consumerId: 'reader', fence: { runtimeId: 'D', ownerInstanceId: 'D-instance' }, invocation: { method, args } } } })
  const key = { kind: 'prompt', agentSessionId: 'sid', expectedRun: { runId: 'run' }, submissionId: 'input' }
  expect(() => parseSpaceMemberParams('space.member.call', input('statusAgent', ['sid']))).not.toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('statusAgent', ['other-sid']))).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('signalAgent', ['sid', { runId: 'run' }, 'SIGINT']))).not.toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('signalAgent', ['sid', { runId: 'run' }, 'SIGKILL']))).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('stopAgentInputWaiting', [{ ref: { key, waitGeneration: 1 }, cancelOperationId: 'cancel', caller: { agentSessionId: 'sid', capability: 'fabricated' } }]))).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', input('submitAgentPrompt', [{ agentSessionId: 'sid', expectedRun: { runId: 'run' }, operationId: 'input', prompt: 'body' }, { caller: 'fabricated' }]))).toThrow()
})

it('stable member input reuses the original opened-file index instead of parsing the whole graph for every key', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'indexed-member'
  const session = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'indexed-member-op')
  const index = vi.spyOn(f.b.spatial as unknown as { readAgentIndex: (...args: unknown[]) => Promise<unknown> }, 'readAgentIndex')
  const write = vi.spyOn(f.d.core, 'writeAgent').mockResolvedValue({ runId: session.run.runId, appliedByteRange: null, acceptedThroughByte: 1 })
  const client = await connectSpaceMember(f.b.rpc, { reference: f.reference, regionId: admission.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: session.run }); cleanup.push(() => client.dispose())
  await client.readAgentSession(sid)
  const initial = index.mock.calls.length
  for (let i = 0; i < 20; i++) await client.writeAgent({ agentSessionId: sid, expectedRun: session.run, data: 'x', source: 'user' })
  expect(write).toHaveBeenCalledTimes(20); expect(initial).toBe(1); expect(index).toHaveBeenCalledTimes(1)
})

it('an actual in-place source write during a member read stays unknown without revoking ordinary membership', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'concurrent-member'
  const session = await f.b.put(sid), admission = await f.admit('local', f.b.owner.runtimeId, sid, 'concurrent-member-op')
  const { appendFile } = await import('node:fs/promises')
  const indexed = f.b.spatial as unknown as { readAgentIndex(file: import('node:fs/promises').FileHandle): Promise<unknown> }
  const original = indexed.readAgentIndex.bind(indexed)
  vi.spyOn(indexed, 'readAgentIndex').mockImplementationOnce(async file => { await appendFile(f.b.spatial.path, ' '); return await original(file) })
  await expect(f.b.spatial.readSpaceAgentRegion({ spaceId: f.reference.spaceId, regionId: admission.address.regionId })).rejects.toMatchObject({ code: 'SPACE_MEMBER_UNAVAILABLE' })
  expect(await f.b.spatial.readSpaceAgentMembership({ spaceId: f.reference.spaceId, hostId: 'local', agentSessionId: sid })).toMatchObject({ member: true })
  expect(await f.b.core.readAgentSession(sid)).toMatchObject({ run: session.run })
})

it('two members sharing an actor and raw consumer ID keep independent original reader leases', async () => {
  const f = await createSpaceSessionsFixture(cleanup), one = await f.b.put('member-one'), two = await f.b.put('member-two')
  const a = await f.admit('local', f.b.owner.runtimeId, one.agentSessionId, 'one-op'), b = await f.admit('local', f.b.owner.runtimeId, two.agentSessionId, 'two-op')
  const target = (session: typeof one, regionId: string) => ({ reference: f.reference, regionId, runtimeId: f.b.owner.runtimeId, agentSessionId: session.agentSessionId, expectedRun: session.run })
  const first = target(one, a.address.regionId), second = target(two, b.address.regionId), values: unknown[] = []
  const { AgentMuxHostedTransferReader } = await import('../src/hosted-value.js')
  const decode = new AgentMuxHostedTransferReader(), fence = { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId }, consumerId = 'same-original-consumer'
  const watchOne = await f.b.rpc.subscribe('space.member.watch', { target: first, call: { method: 'runtime.events', params: { consumerId, fence, sessions: 'full', agentSessionIds: [one.agentSessionId] } } }, { onInitial() {}, onEvent() {} }); cleanup.push(() => watchOne.dispose())
  const openingTwo = f.b.rpc.subscribe('space.member.watch', { target: second, call: { method: 'runtime.events', params: { consumerId, fence, sessions: 'full', agentSessionIds: [two.agentSessionId] } } }, { onInitial() {}, onEvent(event) { if (event.type === 'snapshot') { const value = decode.accept(event.data); if (value) values.push(value) } } })
  await expect(openingTwo, 'another member must keep an independent original event owner').resolves.toMatchObject({ dispose: expect.any(Function) })
  const watchTwo = await openingTwo; cleanup.push(() => watchTwo.dispose())
  await f.b.put(two.agentSessionId, 2)
  await vi.waitFor(() => expect(values.some(value => JSON.stringify(value).includes('"updatedAt":2'))).toBe(true))
  await f.b.rpc.call('space.member.call', { target: first, call: { method: 'runtime.release-consumer', params: { consumerId, fence } } })
  values.length = 0; await f.b.put(two.agentSessionId, 3)
  await vi.waitFor(() => expect(values.some(value => JSON.stringify(value).includes('"updatedAt":3'))).toBe(true))
  expect(await f.b.core.readAgentSession(two.agentSessionId)).toMatchObject({ run: two.run })
})
