import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpaceMountEvent } from '../src/shared/space-mount'
import { spaceMountFixture } from './helpers/space-mount-fixture'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('the real registered Main/Preload/Renderer chain registers and edits only the selected original Core, then observes its shared CAS result', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, local = f.cores[0]!
  const resources = await f.api.call('resources', { hostId: b.id })
  expect(resources).toMatchObject({ hostId: b.id, runtimeId: b.identity.runtimeId, workspaces: [{ workspaceId: b.workspace.id, hostId: 'local', path: b.workspace.path }] })
  const saved = await f.api.call('register', { hostId: b.id, registration: { runtimeId: resources.runtimeId, workspaceId: b.workspace.id,
    expectedResource: { hostId: 'local', workspacePath: b.workspace.path, projectRootPath: b.workspace.path } } })
  const target = { hostId: b.id, reference: saved.reference }, observations: SpaceMountEvent[] = []
  const choices = await f.api.call('hostChoices',target)
  expect(choices.hosts).toEqual([{hostId:'local',kind:'local',label:b.id+' original Node',runtimeId:b.identity.runtimeId},{hostId:b.id+'-original-remote',kind:'ssh',label:b.id+' Agent device',runtimeId:b.id+'-remote-runtime'}])
  expect(JSON.stringify(choices)).not.toContain('private-route.example'); expect(JSON.stringify(choices)).not.toContain('/private/original-key')
  const reader = await f.api.watch(target, observation => observations.push(observation)); cleanup.push(() => reader.dispose())
  const zone = reader.initial.scope.zones[0]!
  const receipt = await f.api.call('apply', { ...target, edit: { reference: saved.reference, expectedRevision: reader.initial.revision,
    changes: { zones: [{ ...zone, branch: 'source-cas-update' }] } } })
  expect(receipt.diskDurability).toBe('confirmed')
  await vi.waitFor(() => expect(observations).toContainEqual(expect.objectContaining({ type: 'snapshot', snapshot: expect.objectContaining({ revision: receipt.revision,
    scope: expect.objectContaining({ zones: [expect.objectContaining({ branch: 'source-cas-update' })] }) }) })))
  expect(await local.store.read()).toBeNull()
  expect((await b.store.read())!.graph.zones[0]!.branch).toBe('source-cas-update')
  await expect(f.api.call('snapshot', { ...target, hostId: 'local' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(f.api.call('apply', { ...target, edit: { reference: { ...saved.reference, runtimeId: 'local-runtime' }, expectedRevision: receipt.revision, changes: {} } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(() => f.handlers.get('spaceMounts:call')!({ ...f.event, senderFrame: { ...f.sender.mainFrame } } as never, 'foreign-frame', 'resources', { hostId: b.id })).toThrow('Untrusted application')
})

it('closing the original window reader cancels its exact source subscription and leaves both Core graphs intact', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!
  const saved = await b.rpc.call('space.folder.register', { runtimeId: b.identity.runtimeId, workspaceId: b.workspace.id,
    expectedResource: { hostId: 'local', workspacePath: b.workspace.path, projectRootPath: b.workspace.path } })
  const abort = new AbortController(), events: SpaceMountEvent[] = []
  await f.api.watch({ hostId: b.id, reference: saved.reference }, event => events.push(event), abort.signal)
  expect(f.renderer.listenerCount('spaceMounts:event')).toBe(1)
  abort.abort()
  await vi.waitFor(() => expect(f.renderer.listenerCount('spaceMounts:event')).toBe(0))
  const before = await b.store.read(), zone = before!.graph.zones[0]!
  await b.rpc.call('space.apply', { reference: saved.reference, expectedRevision: before!.revision, changes: { zones: [{ ...zone, branch: 'after-window-close' }] } })
  expect(events).toEqual([])
  expect((await b.store.read())!.graph.zones[0]!.branch).toBe('after-window-close')
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('a changed configured carrier releases only its original mounted reader instead of adopting late source changes', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!
  const saved = await b.rpc.call('space.folder.register', { runtimeId: b.identity.runtimeId, workspaceId: b.workspace.id,
    expectedResource: { hostId: 'local', workspacePath: b.workspace.path, projectRootPath: b.workspace.path } })
  const events: SpaceMountEvent[] = []
  const reader = await f.api.watch({ hostId: b.id, reference: saved.reference }, event => events.push(event))
  f.routes.set(b.id, { client: { ...b.carrier } })
  await b.rpc.call('space.apply', { reference: saved.reference, expectedRevision: reader.initial.revision,
    changes: { zones: [{ ...reader.initial.scope.zones[0]!, branch: 'late-old-carrier' }] } })
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'RUNTIME_OWNER_MISMATCH' }) })))
  expect(events.some(event => event.type === 'snapshot')).toBe(false)
  expect(f.renderer.listenerCount('spaceMounts:event')).toBe(0)
  expect((await b.store.read())!.graph.zones[0]!.branch).toBe('late-old-carrier')
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('the original two-Core Session authority reaches the real trusted Main IPC, Preload and Renderer adapter without a global Session map', async () => {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const original = await createSpaceSessionsFixture(cleanup), sid = 'shared-member'
  await original.d.put(sid); await original.admit('D-in-B', 'runtime-d', sid, 'source-shared-member-op')
  const carrier = { forwardRpc: original.b.rpc.call.bind(original.b.rpc), subscribeRpc: original.b.rpc.subscribe.bind(original.b.rpc) }
  const f = spaceMountTransport(cleanup, [{ id: 'saved-b', carrier }]), events: import('../src/shared/space-mount').SpaceMountSessionsEvent[] = []
  const abort = new AbortController()
  const reader = await f.api.sessions({ hostId: 'saved-b', reference: original.reference }, event => events.push(event), abort.signal)
  expect(reader.initial.reference).toEqual(original.reference)
  await vi.waitFor(() => expect(events.some(value => value.type === 'observation' && value.observation.type === 'member' && value.observation.state.status === 'observed' && value.observation.member.runtimeId === 'runtime-d')).toBe(true))
  await original.d.put(sid, 2)
  await vi.waitFor(() => expect(events.some(value => value.type === 'observation' && value.observation.type === 'member' && value.observation.state.status === 'observed' && value.observation.state.session.updatedAt === 2)).toBe(true))
  expect(f.renderer.listenerCount('spaceMounts:sessionsEvent')).toBe(1)
  f.routes.set('saved-b', { client: { ...carrier } }); await original.d.put(sid, 3)
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'RUNTIME_OWNER_MISMATCH' }) })))
  expect(events.some(value => value.type === 'observation' && value.observation.type === 'member' && value.observation.state.status === 'observed' && value.observation.state.session.updatedAt === 3)).toBe(false)
  await vi.waitFor(() => expect(f.renderer.listenerCount('spaceMounts:sessionsEvent')).toBe(0))
  expect(await original.d.core.readAgentSession(sid)).not.toBeNull()
  abort.abort()
})

it('an unavailable original Host-choice catalogue preserves readable projects and never substitutes the observer configuration', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!
  const { writeFile } = await import('node:fs/promises')
  await writeFile(b.configurationPath, JSON.stringify({ workspaces:[b.workspace], hosts:[{id:'broken-original'}] }))
  const resources = await f.api.call('resources', { hostId:b.id })
  expect(resources.workspaces).toMatchObject([{workspaceId:b.workspace.id}])
  expect(JSON.stringify(resources)).not.toContain('local-original-remote')
  const saved = await f.api.call('register', {hostId:b.id,registration:{runtimeId:b.identity.runtimeId,workspaceId:b.workspace.id,expectedResource:{hostId:'local',workspacePath:b.workspace.path,projectRootPath:b.workspace.path}}})
  expect((await f.api.call('snapshot',{hostId:b.id,reference:saved.reference})).scope.zones).toMatchObject([{workspaceId:b.workspace.id}])
  await expect(f.api.call('hostChoices',{hostId:b.id,reference:saved.reference})).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
})

it('a pending foreign Agent-choice read cannot gate the original project list or the default source Agent path', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!
  const saved = await b.rpc.call('space.folder.register',{runtimeId:b.identity.runtimeId,workspaceId:b.workspace.id,expectedResource:{hostId:'local',workspacePath:b.workspace.path,projectRootPath:b.workspace.path}})
  let release!: () => void
  b.hostChoiceReads.wait = new Promise<void>(yes => { release = yes })
  const choices = f.api.call('hostChoices',{hostId:b.id,reference:saved.reference})
  let resources: Awaited<ReturnType<typeof f.api.call<'resources'>>> | undefined
  let pending: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(b.hostChoiceReads.calls).toBe(1))
    pending = f.api.call('resources',{hostId:b.id}).then(value => { resources = value })
    await vi.waitFor(() => expect(resources?.workspaces,'only the optional Agent choices are pending').toMatchObject([{workspaceId:b.workspace.id}]),{timeout:1000})
    expect(b.hostChoiceReads.calls).toBe(1)
    expect((await f.api.call('snapshot',{hostId:b.id,reference:saved.reference})).scope.space?.spaceId).toBe(saved.reference.spaceId)
  } finally { release(); await choices; await pending }
})


it('the original member Core SDK reaches fixed trusted Main IPC and the scoped presenter without putting a foreign SID in A', async () => {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { AgentProviderRegistry } = await import('../../../packages/core/src/agent-provider')
  const { DEFAULT_CONFIG } = await import('../src/main/config-store')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-member-sid'
  f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
  await f.b.put(sid); const session = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-member-window-op')
  const write = vi.spyOn(f.d.core, 'writeAgent').mockResolvedValue({ runId: session.run.runId, appliedByteRange: { startByte: 0, endByte: 4 }, acceptedThroughByte: 4 })
  const carrier = { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) }
  const main = spaceMountTransport(cleanup, [{ id: 'original-b-carrier', carrier }], structuredClone(DEFAULT_CONFIG))
  const events: import('../src/shared/space-mount').SpaceMountMemberEvent[] = []
  const surface = await main.api.member({ hostId: 'original-b-carrier', target: { reference: f.reference, regionId: admission.address.regionId,
    runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: session.run } }, event => events.push(event)); cleanup.push(() => surface.dispose())
  const snapshot = await surface.call('read', {})
  expect(snapshot).toMatchObject({ id: surface.initial.id, hostId: surface.initial.hostId, workspacePath: session.workspacePath,
    control: { kind: 'agent', hostId: surface.initial.hostId, agentSessionId: sid, run: session.run } })
  expect(snapshot.id).not.toBe(sid); expect(snapshot.hostId).not.toBe('local'); expect(snapshot.hostId).not.toBe('D-in-B')
  const store = (f.d.core as unknown as { store: import('../../../packages/core/src/agent-session-store').AgentMuxMemoryAgentSessionStore }).store
  await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'source-result', agentSessionId: sid,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original result', content: 'Original D work remains source-qualified', createdAt: 1, updatedAt: 1 } })
  const observerConversation = vi.spyOn(f.b.core, 'readAgentConversation').mockRejectedValue(Error('Never read the source-local same-SID conversation'))
  const released = vi.spyOn(f.d.core, 'releaseConversationView')
  const conversation = await surface.call('conversationRead', { input: { limit: 3, processDetails: 'deferred' } })
  expect(conversation.agentSessionId).toBe(sid); expect(JSON.stringify(conversation)).toContain('Original D work remains source-qualified')
  expect(conversation.agentSessionId).not.toBe(surface.initial.id); expect(observerConversation).not.toHaveBeenCalled()
  await expect(surface.call('conversationRead', { input: { agentSessionId: 'another-sid' } } as never)).rejects.toMatchObject({ code: 'SPACE_MEMBER_TARGET_MISMATCH' })
  const cut = await surface.call('conversationCheckpoint', { input: {} })
  const changes = await surface.call('conversationChanges', { input: { checkpoint: cut.checkpoint, view: conversation.window.view!, processDetails: 'deferred' } })
  expect(changes.window.id).toBe(conversation.window.id)
  const originalWatches = vi.spyOn(f.d.core, 'observeConversation')
  const one = await surface.call('conversationWatch', { view: conversation.window.view! }), two = await surface.call('conversationWatch', { view: conversation.window.view! })
  expect(one).toMatchObject({ agentSessionId: sid }); expect(two.readerId).not.toBe(one.readerId)
  const firstHandle = await originalWatches.mock.results[0]!.value, secondHandle = await originalWatches.mock.results[1]!.value
  await surface.call('conversationUnwatch', { readerId: one.readerId })
  await vi.waitFor(() => expect(firstHandle.closed.aborted).toBe(true))
  expect(secondHandle.closed.aborted).toBe(false)
  const update = await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'source-followup', agentSessionId: sid,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original continuation', content: 'Followed original D source', createdAt: 2, updatedAt: 2 } })
  ;(f.d.core as unknown as { publisher: import('../../../packages/core/src/client-event-publisher').AgentMuxClientEventPublisher }).publisher.publishTimeline(update, { source: 'native-hook', observedAt: 2, run: session.run }, 'local')
  await vi.waitFor(() => expect(events.some(event => event.type === 'conversation' && event.readerId === two.readerId && event.observation.kind === 'invalidated')).toBe(true))
  expect(events.some(event => event.type === 'conversation' && event.readerId === one.readerId)).toBe(false)
  await surface.call('conversationUnwatch', { readerId: two.readerId })
  expect(await surface.call('conversationRelease', { view: conversation.window.view! })).toMatchObject({ agentSessionId: sid, released: true })
  expect(released).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'local', agentSessionId: sid, view: conversation.window.view }))
  await surface.call('write', { data: 'ping', source: 'user' }); expect(write).toHaveBeenCalledOnce()
  expect(write.mock.calls[0]?.[0]).toMatchObject({ agentSessionId: sid, expectedRun: session.run, data: 'ping' })
  expect(() => main.handlers.get('spaceMounts:memberCall')!({ ...main.event, senderFrame: { ...main.sender.mainFrame } } as never, 'foreign-call', 'other-view', 'write', { data: 'bad', source: 'user' })).toThrow('Untrusted application')
  main.routes.set('original-b-carrier', { client: { ...carrier } })
  await expect(surface.call('write', { data: 'late', source: 'user' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(write).toHaveBeenCalledOnce(); expect(await f.d.core.readAgentSession(sid)).toMatchObject({ run: session.run })
})
