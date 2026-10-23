// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services'
import { core } from '../../../packages/connectors/test/fixtures/room-provisioning'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import type { ConnectionHostingTarget, SessionInputOperationResult } from '../src/shared/contracts'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { api } from '../src/renderer/src/lib/api'
import { AgentConnectorDialog } from '../src/renderer/src/components/AgentConnectorDialog'
import { ConnectorHeaderLinks } from '../src/renderer/src/components/ConnectorHeaderLinks'
import { connectorRoomDraftKey } from '../src/renderer/src/lib/connector-room-intent'
import { retainConnectorRoomIntent, useAppStore } from '../src/renderer/src/store'

function profiles(name: string): import('../../../packages/connectors/src/channel-profile-adapter').ChannelProfileAdapter {
  const readActor = ({ actor }: import('../../../packages/connectors/src/channel-profile-adapter').ChannelActorProfileRead) => ({ actor, state: 'unknown' as const, profile: null, checkedAt: 1, freshness: 'unknown' as const, reason: 'not-observed' as const })
  return { readActor, refreshActor: async input => readActor(input), getMetadata: ({ config, subject }) => ({ subject, cacheRevision: 'controlled-native-profile', observation: subject.kind === 'actor' ? { actor: subject.actor, state: 'unknown', profile: null, checkedAt: 1, freshness: 'unknown', reason: 'not-observed' } : { application: config.application, externalConversationId: subject.externalConversationId, state: 'observed', profile: { name, observedAt: 1 }, checkedAt: 1, freshness: 'current' } }) }
}
const f: ReturnType<typeof connectorJourneyFixture> = connectorJourneyFixture({ adapter: () => ({ ...f.original.adapter, channelProfiles: profiles('Original room owner') }) }), cleanup: Array<() => Promise<unknown> | void> = [], facts: unknown[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  if (process.env.ROOM_HOSTING_FACTS) await writeFile(process.env.ROOM_HOSTING_FACTS, JSON.stringify({ scope: 'Actual Renderer/AppStore/trusted IPC/public Core/two SQLite connection owners; configured hosting selection and adapter I/O controlled. Not default RuntimeController or deployed Host qualification.', facts }, null, 2) + '\n')
})
const target = { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' } }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 7000 }) }
async function hosting() {
  const otherTarget = { hostId: 'different-hosting-host', runtimeId: 'different-hosting-runtime' }
  const create = vi.fn(async () => ({ kind: 'created' as const, externalConversationId: 'other-owner-room' }))
  const other = await createConnectionServices({ directory: join(f.original.root, 'other-room-owner'), adapters: [{ ...f.original.adapter, rooms: { ...f.original.adapter.rooms, create }, channelProfiles: profiles('Other room owner') }], bindings: { spatial: f.original.spatial, checkpoint: f.original.checkpoint, session: async ref => { if (ref.hostId !== 'local') return null; const session = await f.original.client.readAgentSession(ref.agentSessionId); return session ? { hostId: 'local', agentSessionId: session.agentSessionId } : null } } })
  const secret = await other.secrets.store({ operationId: 'other-credential', secret: 'controlled-other-credential' })
  await other.connections.configure({ operationId: 'other-configure', expectedRevision: null, connection: { ...f.config, credentialRef: secret.credentialRef } })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'other-room.sock'), connections: other.connections, spatialState: f.original.spatial, coreClients: () => [{ hostId: 'local', client: f.original.client }] })
  await server.start()
  const a = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.original.root, 'ui.sock') } })
  const b = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(async () => { await a.dispose(); await b.dispose(); await server.stop(); await other.close() })
  let current = f.hostingTarget
  const calls: Array<{ method: string; input: any; hostingTarget: ConnectionHostingTarget }> = []
  const runtime: import('../src/main/connection-host-ipc').ConnectionHostIpc = {
    connectionHostingTarget: async () => structuredClone(current),
    callConnectionHost: async (owner, method, input) => {
      calls.push({ method, input: structuredClone(input), hostingTarget: structuredClone(owner) })
      if (JSON.stringify(owner) === JSON.stringify(f.hostingTarget)) return a.call(method, input)
      if (JSON.stringify(owner) === JSON.stringify(otherTarget)) return b.call(method, input)
      throw Error('Original controlled hosting owner unavailable')
    }, watchConnectionMetadata: async (owner, handlers) => (JSON.stringify(owner) === JSON.stringify(f.hostingTarget) ? a : b).subscribe('connection.metadata.watch', {}, handlers)
  }
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: vi.fn(), runtime, metadata: { publish() {}, observation() {} } })
  const forward = async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], owner?: ConnectionHostingTarget) => unwrapSessionInputOperationResult(structuredClone(await handlers.get('connections:call')!({}, method, params, owner)) as SessionInputOperationResult<ConnectionResultMap[M]>)
  vi.mocked(api.connections.hostingTarget).mockImplementation(id => runtime.connectionHostingTarget(id))
  vi.mocked(api.connections.call).mockImplementation(forward)
  return { a, b, other, otherTarget, calls, create, forward, switchOwner() { current = otherTarget } }
}
function original(hostingTarget?: ConnectionHostingTarget | null) { const session = f.session; if (session.kind !== 'agent') throw Error('The original fixture Session is an Agent'); return { target, session, name: 'Original Agent', ...(hostingTarget !== undefined ? { hostingTarget } : {}) } }
async function form(hostingTarget?: ConnectionHostingTarget | null) { await f.dom.render(<AgentConnectorDialog original={original(hostingTarget)} mode="create" onClose={() => {}} returnFocus={() => null} />) }

it('the mounted original menu freezes hosting independently of execution, persists the original room request and keeps old drafts separate', async () => {
  const h = await hosting()
  const oldDraft = { connectionId: f.config.connectionId, bindingId: null, bindingRevision: null, mode: 'create' as const, name: 'Unknown old draft', group: '', members: '', memberType: '', scope: 'all-messages' as const, publication: 'future-shared-conversation' as const, actorId: '', actorType: '' }
  useAppStore.setState({ connectorRoomDrafts: { [connectorRoomDraftKey(target)]: oldDraft } })
  await f.mount(); await f.journey('create'); await f.fill('Group name', 'Original hosting room'); await f.button('Create group')
  await wait(() => expect(h.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1))
  const call = h.calls.find(call => call.method === 'connection.room.create')!, saved = useAppStore.getState().connectorRoomIntents[call.input.operationId]!
  expect(call.hostingTarget).toEqual(f.hostingTarget); expect(call.input.executionHostId).toBe('local')
  expect(saved.hostingTarget).toEqual(f.hostingTarget); expect(saved.input).toEqual(call.input)
  facts.push({ case: 'draft-owner-retention', oldDraft, currentDraft: useAppStore.getState().connectorRoomDrafts[connectorRoomDraftKey(target)], operationId: call.input.operationId, route: call.hostingTarget })
  expect(useAppStore.getState().connectorRoomDrafts[connectorRoomDraftKey(target)]).toEqual(oldDraft)
  expect(useAppStore.getState().connectorRoomDrafts[connectorRoomDraftKey(target, f.hostingTarget)]?.name).toBe('Original hosting room')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Group name"]')?.value).not.toBe('Unknown old draft')
  await wait(() => expect(f.original.create).toHaveBeenCalledTimes(1)); expect(h.create).toHaveBeenCalledTimes(0)
  await f.original.unchanged()
  facts.push({ case: 'menu-original-room-hosting', operationId: call.input.operationId, hostingTarget: call.hostingTarget, executionHostId: call.input.executionHostId, oldDraftKept: true })
})

it('a lost room ACK survives real remount and reopens the original owner despite another Host holding the same operation ID', async () => {
  const h = await hosting(), forward = h.forward
  vi.mocked(api.connections.call).mockImplementation(async (method, input, owner) => {
    const result = await forward(method, input, owner)
    if (method === 'connection.room.create') throw Error('Controlled lost original room ACK')
    return result
  })
  await form(f.hostingTarget); await wait(() => expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Create group')).toBe(true)); await f.button('Create group')
  await wait(() => expect(h.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1))
  const input = h.calls.find(call => call.method === 'connection.room.create')!.input
  await h.b.call('connection.room.create', { ...input, name: 'Other owner sentinel' })
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('lost original room ACK'))
  await f.dom.render(null); h.switchOwner(); await useAppStore.persist.rehydrate(); vi.mocked(api.connections.call).mockImplementation(forward)
  const count = h.calls.length
  await form(); await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Setup on another bot hosting Host'))
  expect(h.calls.slice(count).filter(call => call.method === 'connection.room.inspect' && call.input.operationId === input.operationId)).toEqual([])
  await f.button('Open original setup')
  await wait(() => expect(h.calls.filter(call => call.method === 'connection.room.inspect' && call.input.operationId === input.operationId).length).toBeGreaterThan(0))
  facts.push({ case: 'lost-ACK-inspection-routing', operationId: input.operationId, routes: h.calls.filter(call => call.method === 'connection.room.inspect' && call.input.operationId === input.operationId).map(call => call.hostingTarget), otherOriginal: await h.b.call('connection.room.inspect', { operationId: input.operationId }) })
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('created-room'))
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('other-owner-room')
  const inspected = h.calls.filter(call => call.method === 'connection.room.inspect' && call.input.operationId === input.operationId)
  expect(inspected.length).toBeGreaterThan(0); expect(inspected.every(call => JSON.stringify(call.hostingTarget) === JSON.stringify(f.hostingTarget))).toBe(true)
  expect(f.original.create).toHaveBeenCalledTimes(1); expect(h.create).toHaveBeenCalledTimes(1)
  expect((await h.b.call('connection.room.inspect', { operationId: input.operationId })).operation?.creation).toMatchObject({ state: 'created', externalConversationId: 'other-owner-room' })
  expect(useAppStore.getState().connectorRoomIntents[input.operationId]?.hostingTarget).toEqual(f.hostingTarget)
  facts.push({ case: 'same-op-original-hosting-remount', operationId: input.operationId, originalRoom: 'created-room', otherRoom: 'other-owner-room', originalInspects: inspected.length })
})

it('an ownerless retained room request remains intact without Check or Continue against the current Host', async () => {
  const h = await hosting(), operationId = 'ownerless-original-room'
  const intent = { method: 'connection.room.create' as const, target, phase: 'may-have-dispatched' as const, input: { ...target, operationId, connectionId: f.config.connectionId, expectedConnectionRevision: 1, name: 'Original unknown room', members: [] } }
  await retainConnectorRoomIntent(intent); await useAppStore.persist.rehydrate(); h.switchOwner(); await form()
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original bot hosting owner unconfirmed'))
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  expect(useAppStore.getState().connectorRoomIntents[operationId]).toEqual(intent)
  facts.push({ case: 'ownerless-action-capability', operationId, buttons: [...document.querySelectorAll('button')].map(button => button.textContent), originalIO: h.calls.filter(call => call.input.operationId === operationId) })
  expect([...document.querySelectorAll('button')].some(button => ['Continue setup', 'Check status', 'Open original setup'].includes(button.textContent ?? ''))).toBe(false)
  expect(h.calls.filter(call => call.input.operationId === operationId)).toEqual([])
  await wait(() => expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Create group')).toBe(true))
  expect(f.original.create).toHaveBeenCalledTimes(0); expect(h.create).toHaveBeenCalledTimes(0)
  facts.push({ case: 'ownerless-original-room', operationId, originalRetained: true, originalIO: 0, independentNewFormAvailable: true })
})

it('late room metadata and diagnosis from one owner cannot replace the same binding identity on another owner', async () => {
  const h = await hosting()
  const input = { ...f.original.input, operationId: 'header-original-binding', connectionId: f.config.connectionId, expectedConnectionRevision: 1 }
  const bound = await h.a.call('connection.bind', input)
  if (bound.state !== 'applied') throw Error('Original controlled binding must apply')
  const binding = bound.binding, source = h.forward, pending: Array<() => void> = []
  vi.mocked(api.connections.call).mockImplementation(async (method, params, owner) => {
    if (method === 'connection.metadata.get' && JSON.stringify(owner) === JSON.stringify(f.hostingTarget)) {
      const result = await source(method, params as ConnectionParamsMap['connection.metadata.get'], owner); await new Promise<void>(resolve => pending.push(resolve)); return result
    }
    return source(method, params, owner)
  })
  const render = async (owner: ConnectionHostingTarget) => f.dom.render(<ConnectorHeaderLinks bindings={[binding]} hostingTarget={owner} issue="" checking={false} retainedSetup={false} syncEnabled={true} nameVersion={0} visible onOpen={() => {}} onConnect={() => {}} onMenuOpen={() => {}} />)
  await render(f.hostingTarget); await wait(() => expect(pending).toHaveLength(1)); await render(h.otherTarget)
  facts.push({ case: 'late-room-owner-selection', currentTarget: h.otherTarget, pendingOriginal: pending.length, routes: h.calls })
  await wait(() => expect(document.querySelector('.agent-region-header__connector')?.textContent).toContain('Other room owner'))
  await act(async () => { for (const resolve of pending) resolve() })
  const header = document.querySelector('.agent-region-header__connector')!
  expect(header.textContent).toContain('Other room owner'); expect(header.textContent).not.toContain('Original room owner')
  expect(h.calls.filter(call => call.method === 'connection.metadata.get').map(call => call.hostingTarget)).toContainEqual(h.otherTarget)
  facts.push({ case: 'late-original-room-reading', originalTarget: f.hostingTarget, currentTarget: h.otherTarget, releasedOriginal: pending.length })
})
