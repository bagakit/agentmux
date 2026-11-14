import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { observeSpaceSessionStates } from '../src/space-session-stream.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import type { SpaceSessionsObservation } from '../src/space-sessions.js'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks() })
it('the actual two-Core public Space reader retains same-SID authorities and consumes only original member metadata', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-original-sid'
  await f.b.put(sid); await f.d.put(sid); await f.d.put('unrelated-d')
  await f.admit('local', 'runtime-b', sid, 'b-original-op'); const remote = await f.admit('D-in-B', 'runtime-d', sid, 'd-original-op')
  await f.admit('D-in-B', 'runtime-d', 'kept-missing-d', 'kept-d-op')
  const observed: SpaceSessionsObservation[] = []
  const reader = await observeSpaceSessionStates(f.b.rpc, { reference: f.reference }, { onObservation: value => observed.push(value) })
  cleanup.push(() => reader.dispose())
  expect(reader.initial).toMatchObject({ reference: f.reference, source: { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId } })
  await vi.waitFor(() => expect(new Set(observed.flatMap(value => value.type === 'member' && value.state.status === 'observed' ? [value.member.runtimeId] : [])).size, JSON.stringify(observed)).toBe(2))
  const states = observed.filter(value => value.type === 'member' && value.state.status === 'observed')
  expect(states).toEqual(expect.arrayContaining([expect.objectContaining({ member: { hostId: 'local', runtimeId: 'runtime-b', agentSessionId: sid }, state: expect.objectContaining({ authority: expect.objectContaining({ runtimeId: 'runtime-b' }), session: expect.objectContaining({ workspacePath: '/runtime-b/home' }) }) }),
    expect.objectContaining({ member: { hostId: 'D-in-B', runtimeId: 'runtime-d', agentSessionId: sid }, state: expect.objectContaining({ authority: expect.objectContaining({ runtimeId: 'runtime-d' }), session: expect.objectContaining({ workspacePath: '/runtime-d/home' }) }) })]))
  expect(JSON.stringify(observed)).not.toContain('private-token')
  // Directory metadata can precede its independent initial Native projection.
  // Establish both related projections before measuring an unrelated update.
  await vi.waitFor(() => expect(new Set(observed.flatMap(value => value.type === 'runtime' && value.event.type === 'process-state' &&
    value.event.agentSessionId === sid ? [value.runtimeId] : [])).size, JSON.stringify(observed)).toBe(2))
  observed.length = 0
  await f.d.put('unrelated-d', 2); await new Promise(resolve => setTimeout(resolve, 30))
  expect(observed, JSON.stringify(observed)).toEqual([])
  await f.d.put(sid, 3)
  await vi.waitFor(() => expect(observed.some(value => value.type === 'member' && value.member.hostId === 'D-in-B' && value.state.status === 'observed' && value.state.session.updatedAt === 3)).toBe(true))
  const state = (await f.b.spatial.read())!
  const readOriginal = f.b.spatial.readForLayout.bind(f.b.spatial)
  let release!: () => void
  const gate = new Promise<void>(yes => { release = yes })
  const sourceRead = vi.spyOn(f.b.spatial, 'readForLayout').mockImplementationOnce(async () => { await gate; return await readOriginal() })
  await f.b.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph,
    tabs: state.graph.tabs.map(tab => tab.tabId === remote.address.tabId ? { ...tab, regionIds: [] } : tab),
    regions: state.graph.regions.filter(region => region.regionId !== remote.address.regionId), tabLayouts: {} }, allowEntityRemoval: true })
  let leakedBeforeNewCut = false
  try {
    await vi.waitFor(() => expect(sourceRead).toHaveBeenCalled())
    observed.length = 0
    const published = vi.fn(), unlisten = f.d.core.onEvent(value => { if (value.type === 'agent-session' && value.session.agentSessionId === sid && value.session.updatedAt === 4) published() }, { observeMessages: false })
    cleanup.push(unlisten); await f.d.put(sid, 4); await vi.waitFor(() => expect(published).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 30))
    leakedBeforeNewCut = observed.some(value => value.type === 'member' && value.member.agentSessionId === sid && value.member.hostId === 'D-in-B' && value.state.status === 'observed' && value.state.session.updatedAt === 4)
  } finally { release() }
  expect(leakedBeforeNewCut, 'a late removed member cannot acquire B’s new revision while its admission read is pending').toBe(false)
  await vi.waitFor(() => expect(observed.some(value => value.type === 'removed' && value.member.hostId === 'D-in-B')).toBe(true))
  observed.length = 0; await f.d.put(sid, 6); await new Promise(resolve => setTimeout(resolve, 30))
  expect(observed.some(value => value.type === 'runtime' && value.hostId === 'D-in-B' || value.type === 'member' && value.member.hostId === 'D-in-B')).toBe(false)
  await f.b.put(sid, 5)
  await vi.waitFor(() => expect(observed.some(value => value.type === 'member' && value.member.hostId === 'local' && value.state.status === 'observed' && value.state.session.updatedAt === 5)).toBe(true))
  for (const core of [f.b, f.d]) { expect(core.inventory).not.toHaveBeenCalled(); expect(core.runs).not.toHaveBeenCalled(); expect(core.all).not.toHaveBeenCalled() }
})
it('keeps legacy foreign identity unknown and exact original absence missing, without substituting a local same-SID Session', async () => {
  const f = await createSpaceSessionsFixture(cleanup), old = await f.admit('D-in-B', 'runtime-d', 'legacy-sid', 'legacy-op')
  await f.b.put('legacy-sid'); await f.admit('D-in-B', 'runtime-d', 'missing-d-sid', 'missing-op')
  const state = (await f.b.spatial.read())!
  // Prior on-disk input is the boundary here: a current layout commit correctly
  // retains an admitted identity and cannot manufacture a legacy missing reference.
  await writeFile(f.b.spatial.path, JSON.stringify({ ...state, graph: { ...state.graph, regions: state.graph.regions.map(region => {
    if (region.regionId !== old.address.regionId) return region
    const { creationOperationId, ...original } = region; return original
  }) } }))
  const observed: SpaceSessionsObservation[] = [], reader = await observeSpaceSessionStates(f.b.rpc, { reference: f.reference }, { onObservation: value => observed.push(value) })
  cleanup.push(() => reader.dispose())
  await vi.waitFor(() => expect(observed, JSON.stringify(observed)).toContainEqual(expect.objectContaining({type:'member',member:{hostId:'D-in-B',runtimeId:'runtime-d',agentSessionId:'missing-d-sid'},state:{status:'missing',authority:{runtimeId:'runtime-d',ownerInstanceId:'runtime-d-instance'}}})))
  expect(observed, JSON.stringify(observed)).toContainEqual(expect.objectContaining({ type: 'member', member: { hostId: 'D-in-B', runtimeId: 'runtime-d', agentSessionId: 'legacy-sid' }, state: { status: 'unknown', issue: expect.objectContaining({ code: 'SPACE_SESSION_REFERENCE_UNCONFIRMED' }) } }))
  expect(observed.some(value => value.type === 'member' && value.member.agentSessionId === 'legacy-sid' && value.state.status === 'observed')).toBe(false)
})
it('the public CLI parser exposes one exact Space metadata reader with no all-Host or history flags', async () => {
  const command = await parseAgentMuxCliInvocation(['space', 'sessions', 'watch', '--runtime', 'runtime-b', '--space', 'original-space'])
  expect(command.command.method).toBe('space.sessions.watch'); expect(command.params).toEqual({ reference: { runtimeId: 'runtime-b', spaceId: 'original-space' } })
  await expect(parseAgentMuxCliInvocation(['space', 'sessions', 'watch', '--runtime', 'runtime-b', '--space', 'original-space', '--after-revision', '4'])).rejects.toThrow()
})

it('a valid managed Agent cannot enter the user/device Space reader through another RPC name', async () => {
  const f = await createSpaceSessionsFixture(cleanup)
  await f.b.put('managed-original')
  const { connectAgentMuxRpc } = await import('../src/public-rpc-client.js')
  const caller = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.b.server.path }, credentials: { agentSessionId: 'managed-original', capability: 'private-original-capability' } })
  cleanup.push(() => caller.dispose())
  await expect(observeSpaceSessionStates(caller, { reference: f.reference }, { onObservation() {} })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect((await f.b.core.readAgentSession('managed-original'))!.run.runId).toBe('runtime-b-run-managed-original')
})

it('a disconnected D metadata reader becomes unavailable, then reopens the same Runtime with its new owner instance and exact scope', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'reconnected-original'
  await f.d.put(sid); await f.admit('D-in-B','runtime-d',sid,'reconnect-original-op')
  const observed: SpaceSessionsObservation[] = [], failures: Error[] = []
  const reader = await observeSpaceSessionStates(f.b.rpc,{reference:f.reference},{onObservation:value=>observed.push(value),onError:error=>failures.push(error)})
  cleanup.push(()=>reader.dispose())
  await vi.waitFor(()=>expect(observed.some(value=>value.type==='member'&&value.state.status==='observed')).toBe(true))
  await f.d.disconnect()
  await vi.waitFor(()=>expect(observed.some(value=>value.type==='member'&&value.state.status==='unavailable')).toBe(true))
  expect(failures).toEqual([])
  expect((await f.b.spatial.read())!.graph.regions).toMatchObject([{agentSessionId:sid}])
  await f.d.put(sid,2); await f.d.reconnect()
  await vi.waitFor(()=>expect(observed.some(value=>value.type==='member'&&value.state.status==='observed'&&value.state.authority.ownerInstanceId===f.d.owner.ownerInstanceId&&value.state.session.updatedAt===2)).toBe(true),{timeout:5000})
  expect(observed.some(value => value.type === 'runtime' && value.event.type === 'session-observation-state'),
    'SDK-local directory state is consumed by the member owner, never forwarded as Space Runtime facts').toBe(false)
  expect(failures).toEqual([]); expect(f.d.inventory).not.toHaveBeenCalled()
})
