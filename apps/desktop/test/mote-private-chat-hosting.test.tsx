// @vitest-environment happy-dom
import { act } from 'react'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import './fixtures/mote-app'
import { AgentMuxControlServer, connectAgentMuxRpc, AgentMuxError } from '@agentmux/core'
import { MOTE_CHAT_DEFAULT_VALUES } from '@agentmux/core/mote-chat'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store'
import { RuntimeController } from '../src/main/runtime-controller'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { moteChatDraftKey } from '../src/renderer/src/lib/mote-chat-draft'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
const cleanup: Array<() => unknown | Promise<unknown>> = []
const application = { domain: 'signed.example', appId: 'remote-chat-app' }
beforeEach(async () => { f = await moteBotUi({ generic: true }); await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...state.config!.hosts, { id: 'original-host', kind: 'ssh', hostname: 'original.invalid', label: 'Original bot Host' }, { id: 'remote', kind: 'ssh', hostname: 'controlled.invalid', label: 'Remote bot Host' }] } }))) })
afterEach(async () => { const errors: unknown[] = []; for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }; try { await f?.close() } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors, 'Mote hosting consumer cleanup failed') })
const panel = () => document.querySelector<HTMLElement>('[data-mote-private-chat]')!
const minutes = () => panel().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!
async function ready(check: () => void) { await vi.waitFor(async () => { await f.settle(); check() }, { timeout: 8000 }) }
async function source(hostId: string) { const picker = panel().querySelector<HTMLSelectElement>('[aria-label="Bot hosting source"]')!; expect(picker).not.toBeNull(); await act(async () => { picker.value = 'host:' + hostId; picker.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function sourceReadComplete() { await ready(() => expect(panel().querySelector('p.mote-private-chat__activity')).toBeNull()) }
async function fill(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(minutes(), value); minutes().dispatchEvent(new Event('input', { bubbles: true })); minutes().dispatchEvent(new Event('change', { bubbles: true })) }) }
async function click(text: string) { const node = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!; expect(node, text + '\n' + panel().textContent).toBeTruthy(); expect(node.disabled).toBe(false); await act(async () => node.click()) }

/** Real configured-route qualification, native owner fences and public Mote owner.
 * The remote transport is a private Unix endpoint, not an external SSH deployment. */
async function remoteOwner() {
  vi.spyOn(f.adapter.profile!, 'get').mockImplementation(async (config, revision) => ({ connectionId: config.connectionId, connectionRevision: revision, application: config.application,
    state: 'observed', language: null, profile: null, metadata: null, creator: { idType: 'open_id', userId: 'native-creator' }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }))
  const core = await rpcOwnerFixture([]); cleanup.push(core.close)
  let identity = { ...hostedTestOwner(core.client), runtimeId: 'remote-bot-runtime' }
  const hosted = new AgentMuxHostedRuntimeService(core.client, core.store.path, () => identity); cleanup.push(() => hosted.dispose())
  const unavailable = async () => { throw Error('Configuring private chat must not start or borrow an Agent') }
  const services = await createConnectionServices({ directory: join(core.root, 'connections'), adapters: f.adapters, moteChat: {
    assertTarget: async target => { const value = await f.preferences.read({ kind: 'connection', target }); if (value.status !== 'ready') throw Error('The exact original Mote resource is not confirmed') },
    agents: { prepare: unavailable, create: unavailable, inspect: unavailable, prepareInput: unavailable, activity: unavailable }
  } }); cleanup.push(() => services.close())
  const server = new AgentMuxControlServer({ socketPath: join(core.root, 'remote.sock'), connections: services.connections, moteChat: services.moteChat!,
    motePreferences: f.preferences, hostedRuntime: () => hosted, coreClients: core.coreClients }); await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const calls: Array<{ method: string; params: unknown; fence: unknown }> = []
  const client = Object.assign(core.client, { runtimeOwnerIdentity: () => identity, forwardRpc: async (method: any, params: any, context: any, fence: any) => {
    calls.push({ method, params, fence }); return rpc.call(method, params, { ...(context.caller ? { credentials: context.caller } : {}), ...(fence ? { runtimeFence: fence } : {}) })
  } })
  const controller = new RuntimeController(core.store, async () => client), routes = Reflect.get(controller, 'hosts') as Map<string, unknown>
  routes.set('remote', { client }); cleanup.push(async () => { routes.clear(); await controller.dispose() })
  vi.spyOn(f.runtime, 'connectionHostingTarget').mockImplementation((source, context) => controller.connectionHostingTarget(source, context))
  const originalCall = f.runtime.callConnectionHost.bind(f.runtime)
  vi.spyOn(f.runtime, 'callConnectionHost').mockImplementation((target, method, params, context) => target.hostId === 'remote' ? controller.callConnectionHost(target, method, params, context) : originalCall(target, method, params, context))
  const { credentialRef } = await services.secrets.store({ operationId: 'remote-credential', secret: 'controlled-remote-token' })
  await rpc.call('connection.configure', { operationId: 'remote-bot', expectedRevision: null, connection: { connectionId: 'remote-bot', adapterId: 'signed-profile', application, label: 'Remote private chat bot', enabled: true, credentialRef } })
  return { rpc, calls, services, target: { hostId: 'remote', runtimeId: identity.runtimeId }, replaceRuntime: () => { identity = { ...identity, runtimeId: 'replacement-bot-runtime', ownerInstanceId: 'replacement-bot-owner' } } }
}

async function chooseRemoteBot() {
  const trigger = panel().querySelector<HTMLElement>('[aria-label="Private chat bot"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await ready(() => expect([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].some(item => item.textContent?.includes('Remote private chat bot'))).toBe(true))
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes('Remote private chat bot'))!.click())
  await act(async () => panel().querySelector<HTMLInputElement>('[aria-label="Enable external private chat"]')!.click())
}

it('selects a configured remote source through the original Runtime identity/owner fence while the local source is unavailable, and keeps all consumers there', async () => {
  const remote = await remoteOwner(); await f.renderMotePanel()
  await ready(() => expect(panel().textContent).toContain('Runtime host is not configured: local'))
  await source('remote'); await sourceReadComplete(); expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off')
  expect(api.connections.hostingTarget).toHaveBeenLastCalledWith('remote')
  expect(panel().querySelector<HTMLSelectElement>('[aria-label="Bot hosting source"]')?.selectedOptions[0]?.textContent).toBe('Remote bot Host')
  expect(remote.calls.some(call => call.method === 'runtime.owner.identity')).toBe(true)
  expect(remote.calls.find(call => call.method === 'connection.owner.inspect')?.fence).toEqual({ runtimeId: 'remote-bot-runtime', ownerInstanceId: 'original-owner' })
  await chooseRemoteBot(); await fill('45'); await click('Save chat settings')
  await ready(() => expect(panel().textContent).toContain('Original chat settings save confirmed.'))
  expect((await remote.rpc.call('space.mote.chat.inspect', { target: f.target() })).configuration).toMatchObject({ creator: null, values: { enabled: true, conversationIdleMs: 45 * 60000, strangerMessageLimit: 0 } })
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toBeNull()
  await act(async () => useAppStore.setState({ manualConnectionSelections: { lark: { hostId: 'wrong-global-host', runtimeId: 'wrong-runtime' } } }))
  vi.mocked(api.connections.hostingTarget).mockClear(); await click('Refresh')
  await ready(() => expect(panel().textContent).not.toContain('Refreshing chat settings'))
  expect(api.connections.hostingTarget).not.toHaveBeenCalled()
  await click('Confirm Main identity'); await ready(() => expect(panel().textContent).toContain('Main identity confirmed for'))
  await click('Manage bot identity')
  expect(f.navigation.openMoteConnection).not.toHaveBeenCalled() // The controlled adapter has no native Settings page.
  expect(panel().textContent).toContain('The original selected connection is not confirmed.')
  const people = panel().querySelector<HTMLDetailsElement>('.mote-private-chat__people')!; await act(async () => people.querySelector<HTMLElement>('summary')!.click())
  await ready(() => expect(remote.calls.some(call => call.method === 'space.mote.chat.audience')).toBe(true))
  expect(f.chatRequests.mock.calls.every(([, , target]) => JSON.stringify(target) === JSON.stringify(remote.target))).toBe(true)
  expect(f.connectionCalls.mock.calls.every(([, , target]) => JSON.stringify(target) === JSON.stringify(remote.target))).toBe(true)
  const business = remote.calls.filter(call => call.method.startsWith('space.mote.chat.') || ['connection.ls', 'connection.service.get'].includes(call.method))
  expect(business.length).toBeGreaterThan(5); expect(business.every(call => JSON.stringify(call.fence) === JSON.stringify({ runtimeId: 'remote-bot-runtime', ownerInstanceId: 'original-owner' }))).toBe(true)
})

it('keeps an unknown original locator/request separate from an explicitly selected remote configuration and never retargets its receipt', async () => {
  const remote = await remoteOwner(), input = { operationId: 'unknown-original-source', target: f.target(), expectedRevision: null, expectedConnectionRevision: null,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, conversationIdleMs: 47 * 60000 } }
  const original = { method: 'space.mote.chat.configure' as const, phase: 'may-have-dispatched' as const, input }
  await act(async () => useAppStore.setState({ moteChatIntents: { [input.operationId]: original } }))
  await f.renderMotePanel(); await ready(() => expect(panel().textContent).toContain('The original bot hosting Host is not recorded.'))
  expect(f.chatRequests).not.toHaveBeenCalled(); expect(minutes().value).toBe('47')
  await source('remote'); await sourceReadComplete(); expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off')
  expect(minutes().value).toBe('30'); expect(useAppStore.getState().moteChatIntents[input.operationId]).toEqual(original)
  await chooseRemoteBot(); await fill('52'); await click('Save chat settings')
  await ready(() => expect(panel().textContent).toContain('Original chat settings save confirmed.'))
  expect((await remote.rpc.call('space.mote.chat.inspect', { target: f.target() })).configuration?.values.conversationIdleMs).toBe(52 * 60000)
  const before = f.chatRequests.mock.calls.length
  expect([...panel().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Check original request')?.disabled).toBe(true)
  expect(f.chatRequests.mock.calls.slice(before)).toEqual([])
  expect(useAppStore.getState().moteChatIntents[input.operationId]).toEqual(original)
})

it('retains a dirty draft on the current source, rejects a late source read after a newer edit, and refuses changed Runtime writes without fallback', async () => {
  const remote = await remoteOwner(), qualify = vi.mocked(f.runtime.connectionHostingTarget).getMockImplementation()!
  // The original source is the existing private owner; remote selection uses the real qualified path.
  vi.mocked(f.runtime.connectionHostingTarget).mockImplementation((id, context) => id === undefined || id === 'original-host' ? Promise.resolve(f.hostingTarget) : qualify(id, context))
  await f.renderMotePanel(); await ready(() => expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off'))
  await fill('47'); await source('remote'); await sourceReadComplete(); expect(minutes().value).toBe('30')
  await source('original-host'); await sourceReadComplete(); expect(minutes().value).toBe('47')
  await fill('30')
  expect([...panel().querySelectorAll('button')].some(node => node.textContent === 'Save chat settings'), panel().textContent!).toBe(false)
  const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { const result = await forward(method, input, target); if (method === 'space.mote.chat.inspect' && 'target' in input && target?.hostId === 'remote') { started = true; await held }; return result })
  try {
    await source('remote'); await ready(() => expect(started, JSON.stringify(vi.mocked(api.connections.hostingTarget).mock.calls) + '\n' + panel().textContent).toBe(true)); await fill('49'); await act(async () => release())
    await sourceReadComplete(); expect(panel().textContent).toContain('Your newer draft stays with its original hosting Host.')
    expect(minutes().value).toBe('49'); expect(panel().querySelector<HTMLSelectElement>('[aria-label="Bot hosting source"]')?.selectedOptions[0]?.textContent).toBe('Original bot Host')
  } finally { release() }
  f.chatRequests.mockImplementation(forward); await fill('30'); await source('remote'); await ready(() => expect(panel().textContent).toContain('remote-bot-runtime'))
  await chooseRemoteBot(); await fill('55'); remote.replaceRuntime(); await click('Save chat settings')
  await ready(() => expect(panel().textContent).toContain('Chat settings'))
  expect((await remote.rpc.call('space.mote.chat.inspect', { target: f.target() })).configuration).toBeNull()
  expect(minutes().value).toBe('55'); expect(panel().textContent).toContain('Runtime')
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toBeNull()
  expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.configure').every(([, , target]) => JSON.stringify(target) === JSON.stringify(remote.target))).toBe(true)
})

it('keeps a held original policy request on its own owner while another source saves independently and ignores its late acknowledgement', async () => {
  const remote = await remoteOwner(), qualify = vi.mocked(f.runtime.connectionHostingTarget).getMockImplementation()!
  vi.mocked(f.runtime.connectionHostingTarget).mockImplementation((id, context) => id === undefined || id === 'original-host' ? Promise.resolve(f.hostingTarget) : qualify(id, context))
  await f.renderMotePanel(); await ready(() => expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off'))
  const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { const result = await forward(method, input, target); if (method === 'space.mote.chat.configure' && target?.hostId === f.hostingTarget.hostId) { started = true; await held }; return result })
  try {
    await fill('47'); await click('Save chat settings'); await ready(() => expect(started).toBe(true))
    const original = structuredClone(Object.values(useAppStore.getState().moteChatIntents)[0]!)
    expect(original.hostingTarget).toEqual(f.hostingTarget)
    await source('remote'); await sourceReadComplete()
    expect(minutes().value).toBe('30'); expect(Object.values(useAppStore.getState().moteChatIntents)).toContainEqual(original)
    await chooseRemoteBot(); await fill('52'); await click('Save chat settings')
    await ready(() => expect(panel().textContent).toContain('Original chat settings save confirmed.'))
    await act(async () => release()); await ready(() => expect(Object.keys(useAppStore.getState().moteChatIntents)).toHaveLength(0))
    expect(minutes().value).toBe('52')
    expect(panel().querySelector<HTMLSelectElement>('[aria-label="Bot hosting source"]')?.selectedOptions[0]?.textContent).toBe('Remote bot Host')
    expect((await remote.rpc.call('space.mote.chat.inspect', { target: f.target() })).configuration?.values.conversationIdleMs).toBe(52 * 60000)
    expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration?.values.conversationIdleMs).toBe(47 * 60000)
    expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.configure')).toHaveLength(2)
  } finally { release() }
})

it('keeps typing during the first explicit source read and makes that draft saveable once the same source is confirmed', async () => {
  const remote = await remoteOwner(); await f.renderMotePanel()
  await ready(() => expect(panel().textContent).toContain('Runtime host is not configured: local'))
  const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { const result = await forward(method, input, target); if (method === 'space.mote.chat.inspect' && 'target' in input && target?.hostId === 'remote') { started = true; await held }; return result })
  try {
    await source('remote'); await ready(() => expect(started).toBe(true)); await fill('56'); await act(async () => release()); await sourceReadComplete()
    expect(minutes().value).toBe('56')
    expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off')
    await click('Save chat settings'); await ready(() => expect(panel().textContent).toContain('Original chat settings save confirmed.'))
    expect((await remote.rpc.call('space.mote.chat.inspect', { target: f.target() })).configuration?.values.conversationIdleMs).toBe(56 * 60000)
  } finally { release() }
})

it('retains the original policy draft after switching source and receiving a late explicit prewrite refusal', async () => {
  await remoteOwner(); const qualify = vi.mocked(f.runtime.connectionHostingTarget).getMockImplementation()!
  vi.mocked(f.runtime.connectionHostingTarget).mockImplementation((id, context) => id === undefined || id === 'original-host' ? Promise.resolve(f.hostingTarget) : qualify(id, context))
  await f.renderMotePanel(); await sourceReadComplete()
  const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { if (method === 'space.mote.chat.configure' && target?.hostId === 'original-host' && !started) { started = true; await held; throw new AgentMuxError('Controlled original revision conflict', 'MOTE_CHAT_REVISION_CONFLICT') }; return forward(method, input, target) })
  try {
    await fill('47'); await click('Save chat settings'); await ready(() => expect(started).toBe(true)); await source('remote'); await sourceReadComplete()
    expect(minutes().value).toBe('30'); await act(async () => release()); await ready(() => expect(Object.values(useAppStore.getState().moteChatIntents)).toHaveLength(0))
    expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toBeNull()
    await source('original-host'); await sourceReadComplete()
    expect(minutes().value).toBe('47'); expect(panel().textContent).toContain('Chat settings were not saved. Your draft is kept. Controlled original revision conflict')
    expect(panel().textContent).not.toContain('Chat settings were not confirmed.')
    await f.renderMotePanel(1); await sourceReadComplete(); await f.renderMotePanel(); await sourceReadComplete()
    expect(minutes().value).toBe('47'); expect(panel().textContent).toContain('Controlled original revision conflict')
    await click('Save chat settings'); await ready(() => expect(panel().textContent).toContain('Original chat settings save confirmed.'))
    expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration?.values.conversationIdleMs).toBe(47 * 60000)
  } finally { release() }
})

const sameActor = { application, idType: 'open_id', userId: 'same-guest' }
async function peopleOnBothSources() {
  const remote = await remoteOwner(), qualify = vi.mocked(f.runtime.connectionHostingTarget).getMockImplementation()!
  vi.mocked(f.runtime.connectionHostingTarget).mockImplementation((id, context) => id === undefined || id === 'original-host' ? Promise.resolve(f.hostingTarget) : qualify(id, context))
  const { credentialRef } = await f.connections.secrets.store({ operationId: 'original-same-app-credential', secret: 'controlled-original' })
  await f.client.call('connection.configure', { operationId: 'original-same-app', expectedRevision: null, connection: { connectionId: 'remote-bot', adapterId: 'signed-profile', application, label: 'Original private bot', enabled: true, credentialRef } })
  for (const [rpc, services] of [[f.client, f.connections], [remote.rpc, remote.services]] as const) {
    await rpc.call('space.mote.chat.configure', { operationId: 'source-private-policy', target: f.target(), expectedRevision: null, expectedConnectionRevision: 1,
      values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: true, connection: { connectionId: 'remote-bot', application } } })
    new MoteChatStore(services.database!).savePerson({ key: JSON.stringify([f.target().spaceId, application.domain, application.appId, sameActor.idType, sameActor.userId]), spaceId: f.target().spaceId,
      person: { actor: sameActor, creator: false, revision: 1, total: 4, used: 1, remaining: 3 } })
  }
  await f.renderMotePanel(); await sourceReadComplete(); await act(async () => panel().querySelector<HTMLDetailsElement>('.mote-private-chat__people')!.querySelector<HTMLElement>('summary')!.click())
  await ready(() => expect(person()).not.toBeNull()); return remote
}
const person = () => panel().querySelector<HTMLElement>('[data-mote-chat-person="same-guest"]')!
async function editAllowance(value: string) {
  const edit = [...person().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Edit allowance')
  if (edit) await act(async () => edit.click())
  const field = person().querySelector<HTMLInputElement>('[aria-label="Total allowance for same-guest"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) })
}
const allowanceSave = () => [...person().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Save allowance')!
async function switchPeople(hostId: string) { await source(hostId); await sourceReadComplete(); await ready(() => expect(person()).not.toBeNull()) }
async function reopenPeople() {
  await f.renderMotePanel(1); await sourceReadComplete(); await f.renderMotePanel(); await sourceReadComplete()
  const details = panel().querySelector<HTMLDetailsElement>('.mote-private-chat__people')!
  if (!details.open) await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  await ready(() => expect(person()).not.toBeNull())
}

it('does not let another source’s unknown allocation block the same application actor on the selected owner', async () => {
  const remote = await peopleOnBothSources(), forward = f.chatRequests.getMockImplementation()!
  f.chatRequests.mockImplementation(async (method, input, target) => { const result = await forward(method, input, target); if (method === 'space.mote.chat.allocate' && target?.hostId === 'original-host') throw Error('Controlled lost original allocation acknowledgement'); return result })
  await editAllowance('9'); await act(async () => allowanceSave().click()); await ready(() => expect(person().textContent).toContain('The allowance was not confirmed.'))
  const original = structuredClone(Object.values(useAppStore.getState().moteChatIntents)[0]!)
  await switchPeople('remote'); await editAllowance('5'); expect(allowanceSave().disabled).toBe(false)
  await act(async () => allowanceSave().click()); await ready(() => expect(person().querySelectorAll('dd')[1]?.textContent).toBe('5'))
  expect(useAppStore.getState().moteChatIntents[original.input.operationId]).toEqual(original)
  expect((await remote.rpc.call('space.mote.chat.audience', { target: f.target() })).people[0]?.total).toBe(5)
  expect((await f.client.call('space.mote.chat.audience', { target: f.target() })).people[0]?.total).toBe(9)
})

it('retains an unsent person allowance across source switching and keeps it after its later original prewrite refusal', async () => {
  await peopleOnBothSources(); await editAllowance('9'); await switchPeople('remote'); await switchPeople('original-host')
  expect(person().querySelector<HTMLInputElement>('[aria-label="Total allowance for same-guest"]')?.value).toBe('9')
  await reopenPeople(); expect(person().querySelector<HTMLInputElement>('[aria-label="Total allowance for same-guest"]')?.value).toBe('9')
  expect((await f.client.call('space.mote.chat.audience', { target: f.target() })).people[0]?.total).toBe(4)
  const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { if (method === 'space.mote.chat.allocate' && target?.hostId === 'original-host' && !started) { started = true; await held; throw new AgentMuxError('Controlled original person conflict', 'MOTE_CHAT_REVISION_CONFLICT') }; return forward(method, input, target) })
  try {
    await act(async () => allowanceSave().click()); await ready(() => expect(started).toBe(true)); await switchPeople('remote'); await switchPeople('original-host'); await act(async () => release()); await ready(() => expect(Object.keys(useAppStore.getState().moteChatIntents)).toHaveLength(0)); await ready(() => expect(person().textContent).toContain('Controlled original person conflict'))
    expect(person().querySelector<HTMLInputElement>('[aria-label="Total allowance for same-guest"]')?.value).toBe('9')
    expect(person().textContent).toContain('The allowance was not saved. Your entered total is kept. Controlled original person conflict')
    expect(allowanceSave().disabled).toBe(false)
    const key = moteChatDraftKey({ kind: 'allowance', target: f.target(), hostingTarget: f.hostingTarget, connection: { connectionId: 'remote-bot', application }, actor: sameActor })
    expect(useLauncherState.getState().drafts[key]?.moteChat?.issue).toContain('Controlled original person conflict')
    const cancel = [...person().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Cancel')!
    await act(async () => cancel.click()); expect(person().querySelector('[aria-label="Total allowance for same-guest"]')).toBeNull()
  } finally { release() }
})

it('keeps a newer policy draft through actual Mote unmounts when an older successful save acknowledges later', async () => {
  await remoteOwner(); const qualify = vi.mocked(f.runtime.connectionHostingTarget).getMockImplementation()!
  vi.mocked(f.runtime.connectionHostingTarget).mockImplementation((id, context) => id === undefined || id === 'original-host' ? Promise.resolve(f.hostingTarget) : qualify(id, context))
  await f.renderMotePanel(); await sourceReadComplete()
  const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { const result = await forward(method, input, target); if (method === 'space.mote.chat.configure' && !started) { started = true; await held }; return result })
  try {
    await fill('47'); await click('Save chat settings'); await ready(() => expect(started).toBe(true))
    await f.renderMotePanel(1); await sourceReadComplete(); await f.renderMotePanel(); await sourceReadComplete(); expect(minutes().value).toBe('47')
    await fill('55'); await act(async () => release()); await ready(() => expect(Object.keys(useAppStore.getState().moteChatIntents)).toHaveLength(0))
    await f.renderMotePanel(1); await sourceReadComplete(); await f.renderMotePanel(); await sourceReadComplete(); expect(minutes().value).toBe('55')
    await click('Save chat settings'); await ready(() => expect(panel().textContent).toContain('Original chat settings save confirmed.'))
    expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration?.values.conversationIdleMs).toBe(55 * 60000)
  } finally { release() }
})

it('keeps a newer allowance draft across Mote unmounts after an older ACK and clears only an explicit current Cancel', async () => {
  await peopleOnBothSources(); const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { const result = await forward(method, input, target); if (method === 'space.mote.chat.allocate' && !started) { started = true; await held }; return result })
  try {
    await editAllowance('9'); await act(async () => allowanceSave().click()); await ready(() => expect(started).toBe(true)); await reopenPeople(); await editAllowance('10')
    await act(async () => release()); await ready(() => expect(Object.keys(useAppStore.getState().moteChatIntents)).toHaveLength(0)); await reopenPeople()
    expect(person().querySelector<HTMLInputElement>('[aria-label="Total allowance for same-guest"]')?.value).toBe('10')
    expect((await f.client.call('space.mote.chat.audience', { target: f.target() })).people[0]?.total).toBe(9)
    const cancel = [...person().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Cancel')!
    await act(async () => cancel.click()); await reopenPeople()
    expect(person().querySelector('[aria-label="Total allowance for same-guest"]')).toBeNull()
    expect(person().querySelectorAll('dd')[1]?.textContent).toBe('9')
  } finally { release() }
})

it('does not adopt a saved draft whose exact utility slot belongs to another original Mote target', async () => {
  const foreign = { kind: 'policy' as const, target: f.target(1), hostingTarget: f.hostingTarget, version: mintObjectId(), issue: 'Foreign draft feedback',
    values: { ...MOTE_CHAT_DEFAULT_VALUES }, minutes: '79', strangers: '8' }, key = moteChatDraftKey({ kind: 'policy', target: f.target(), hostingTarget: f.hostingTarget })
  expect(useLauncherState.getState().setMoteChatDraft(key, foreign)).toBe(false)
  // Retain malformed original bytes, then consume the actual persisted fragment.
  useLauncherState.setState(state => ({ drafts: { ...state.drafts, [key]: { browser: '', note: '', moteChat: foreign } } }))
  await useLauncherState.persist.rehydrate(); await f.renderMotePanel(); await sourceReadComplete()
  expect(minutes().value).toBe('30'); expect(panel().textContent).not.toContain('Foreign draft feedback')
  expect(useLauncherState.getState().drafts[key]?.moteChat).toEqual(foreign)
  expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.configure')).toHaveLength(0)
})

it('lets one original request be inspected while another original owner’s receipt read is held', async () => {
  const remote = await remoteOwner(), one = { method: 'space.mote.chat.configure' as const, phase: 'may-have-dispatched' as const, hostingTarget: f.hostingTarget,
    input: { operationId: 'original-request-one', target: f.target(), expectedRevision: null, expectedConnectionRevision: null, values: { ...MOTE_CHAT_DEFAULT_VALUES } } },
    two = { ...one, hostingTarget: remote.target, input: { ...one.input, operationId: 'original-request-two' } }
  await act(async () => useAppStore.setState({ moteChatIntents: { [one.input.operationId]: one, [two.input.operationId]: two } }))
  await f.renderMotePanel(); await sourceReadComplete()
  const forward = f.chatRequests.getMockImplementation()!; let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.chatRequests.mockImplementation(async (method, input, target) => { if (method === 'space.mote.chat.inspect' && 'operationId' in input && input.operationId === one.input.operationId) { started = true; await held }; return forward(method, input, target) })
  const check = (id: string) => panel().querySelector<HTMLButtonElement>('[data-mote-chat-request="'+id+'"] button')!
  try {
    await act(async () => check(one.input.operationId).click()); await ready(() => expect(started).toBe(true)); expect(check(one.input.operationId).disabled).toBe(true)
    expect(check(two.input.operationId).disabled).toBe(false); await act(async () => check(two.input.operationId).click())
    await ready(() => expect(panel().querySelector('[data-mote-chat-request="'+two.input.operationId+'"]')?.textContent).toContain('No receipt in this reading.'))
    expect(f.chatRequests.mock.calls.some(([method,input,target]) => method === 'space.mote.chat.inspect' && 'operationId' in input && input.operationId === two.input.operationId && target?.hostId === 'remote')).toBe(true)
  } finally { await act(async () => release()) }
})
