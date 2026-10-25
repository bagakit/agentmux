// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { ChannelStorage } from '../../../packages/connectors/src/channel-storage'
import { channelActorKey } from '@agentmux/core/connections'
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { defaultHttpInstance } from '../../../packages/connectors/test/fixtures/room-discovery'
import { deferred, profileLoopback } from '../../../packages/connectors/test/fixtures/profile-loopback'
let wire: Awaited<ReturnType<typeof profileLoopback>>, transport: typeof defaultHttpInstance.request
let avatar = 'first', count = 1, hold = false, denied = false, partial = false
let gates: Array<ReturnType<typeof deferred<void>>> = []
beforeEach(async () => {
  avatar = 'first'; count = 1; hold = false; denied = false; partial = false; gates = []
  transport = defaultHttpInstance.request.bind(defaultHttpInstance)
  wire = await profileLoopback(async url => {
    if (url.pathname.endsWith('/members')) return { code: 0, data: { items: Array.from({ length: count }, (_, i) => ({ member_id_type: 'open_id', member_id: 'ou_person_' + i, name: 'Member ' + i })), has_more: false } }
    if (url.pathname.includes('/contact/v3/users/')) {
      const userId = url.pathname.split('/').at(-1)!
      if (hold) { const gate = deferred<void>(); gates.push(gate); await gate.promise }
      return denied ? { code: 41050, msg: 'No contact visibility' } : { code: 0, data: { user: { open_id: userId, name: partial ? 'Partial member' : 'Current member', ...(!partial ? { avatar: { avatar_240: 'https://cdn.example/' + avatar + '-' + userId + '.png' } } : {}) } } }
    }
    return { code: 0, data: { name: 'Current group', avatar: 'https://cdn.example/group-' + avatar + '.png', chat_status: 'normal', chat_mode: 'group' } }
  })
})
const f = connectorJourneyFixture({ platform: input => transport({ ...input, adapter: 'http', url: wire.origin + new URL(input.url!).pathname }) })
afterEach(async () => { gates.forEach(gate => gate.resolve()); await wire.close() })
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 })
const dialog = () => document.querySelector<HTMLElement>('.agent-connector-dialog')!
const refresh = () => dialog().querySelector<HTMLButtonElement>('[aria-label="Refresh group details"]')!
const peopleCalls = () => wire.calls.filter(path => path.includes('/contact/v3/users/'))
async function section(name: string) { await act(async () => dialog().querySelector<HTMLButtonElement>(`[role="tab"][aria-controls$="-${name}-panel"]`)!.click()) }
async function open() {
  const result = await f.forward('connection.bind', { ...f.original.input, operationId: 'profile-bind', bindingId: 'profile-binding', connectionId: f.config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_original_dialog' }, f.hostingTarget)
  expect(result.state).toBe('applied')
  await f.mount(); await f.journey('details'); await wait(() => { expect(refresh()).not.toBeNull(); expect(refresh().disabled).toBe(false) })
  return result
}
const subject = () => ({ kind: 'actor' as const, actor: { application: f.config.application, idType: 'open_id', userId: 'ou_person_0' } })
const profile = () => f.forward('connection.metadata.get', { connectionId: f.config.connectionId, subject: subject() }, f.hostingTarget)
it('actual group-details refresh observes group and visible people through original IPC and native SDK, retaining partial and permission-denied profiles', async () => {
  await open()
  await wait(() => expect(dialog().querySelector('img[src="https://cdn.example/group-first.png"]')).not.toBeNull())
  expect(peopleCalls()).toHaveLength(0)
  const baseline = wire.calls.length
  avatar = 'second'
  await act(async () => refresh().click()); await wait(() => expect(refresh().disabled).toBe(false))
  expect(peopleCalls()).toHaveLength(0)
  expect(wire.calls.slice(baseline).filter(path => path.endsWith('/oc_original_dialog'))).toHaveLength(1)
  await section('members')
  await wait(() => { expect(refresh().disabled).toBe(false); expect(dialog().querySelector('img[src="https://cdn.example/second-ou_person_0.png"]')).not.toBeNull() })
  expect(peopleCalls()).toHaveLength(1)
  const firstImage = dialog().querySelector<HTMLImageElement>('img[src="https://cdn.example/second-ou_person_0.png"]')!
  await act(async () => firstImage.dispatchEvent(new Event('error')))
  expect(dialog().querySelector('img[src="https://cdn.example/second-ou_person_0.png"]')).toBeNull()
  const cached = await profile(), firstTime = cached.entry.observation.profile!.observedAt
  partial = true
  await act(async () => refresh().click()); await wait(() => expect(refresh().disabled).toBe(false))
  await wait(() => expect(dialog().querySelector('img[src="https://cdn.example/second-ou_person_0.png"]')).not.toBeNull())
  const retained = await profile()
  expect(retained.entry.observation.profile).toMatchObject({ name: 'Partial member', avatarUrl: 'https://cdn.example/second-ou_person_0.png', observedAt: firstTime })
  denied = true
  const bindingBefore = await f.forward('connection.binding.inspect', { bindingId: 'profile-binding' }, f.hostingTarget)
  await act(async () => refresh().click()); await wait(() => expect(refresh().disabled).toBe(false))
  expect((await profile()).entry.observation).toMatchObject({ state: 'unavailable', freshness: 'stale', profile: retained.entry.observation.profile })
  expect(await f.forward('connection.binding.inspect', { bindingId: 'profile-binding' }, f.hostingTarget)).toEqual(bindingBefore)
  expect(dialog().textContent).toContain('Earlier')
  expect(f.calls.filter(call => call.method === 'connection.metadata.refresh' && (call.input as { subject?: { kind: string } }).subject?.kind === 'actor')).toHaveLength(3)
}, 30_000)
it('only first visible missing profiles read natively; leaving cancels queued reads, returning reuses cache and in-flight reads without a total cap', async () => {
  count = 7; await open()
  const cache = new ChannelStorage(f.services.database!).namespace(f.config)
  for (let index = 0; index < 128; index++) {
    const actor = { application: f.config.application, idType: 'open_id', userId: 'ou_unrelated_' + index }
    cache.put({ key: 'actor-profile:' + channelActorKey(actor), expectedRevision: null, value: { kind: 'json', value: { actor, state: 'observed', checkedAt: 1, freshness: 'stale', profile: { name: 'Unrelated earlier observation', observedAt: 1 } } } })
  }
  hold = true; await section('members')
  await wait(() => expect(gates).toHaveLength(4))
  expect(peopleCalls()).toHaveLength(4)
  await act(async () => refresh().click())
  await wait(() => expect(refresh().disabled).toBe(true))
  // The explicit current refresh joins the original four requests.
  expect(peopleCalls()).toHaveLength(4)
  await section('overview'); await wait(() => expect(refresh().disabled).toBe(false))
  hold = false; gates.forEach(gate => gate.resolve())
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.metadata.refresh' && (call.input as { subject?: { kind: string } }).subject?.kind === 'actor' && call.result)).toHaveLength(4))
  expect(peopleCalls()).toHaveLength(4)
  await section('members')
  await wait(() => expect(dialog().querySelectorAll('.connector-member-row img').length || dialog().querySelectorAll('[data-member-row] img').length).toBe(7))
  expect(peopleCalls()).toHaveLength(7)
  expect(new Set(peopleCalls().map(path => path.split('/').at(-1))).size).toBe(7)
  await section('overview'); await section('members')
  await wait(() => expect(dialog().querySelectorAll('[data-member-row] img')).toHaveLength(7))
  expect(peopleCalls()).toHaveLength(7)
}, 30_000)

it('fills a visible name-only profile but keeps complete stale observations without forced refresh', async () => {
  count = 2; await open()
  const cache = new ChannelStorage(f.services.database!).namespace(f.config)
  for (let i = 0; i < 2; i++) {
    const actor = { application: f.config.application, idType: 'open_id', userId: 'ou_person_' + i }
    cache.put({ key: 'actor-profile:' + channelActorKey(actor), expectedRevision: null, value: { kind: 'json', value: { actor, state: 'observed', checkedAt: 1, freshness: 'stale', profile: { name: 'Earlier ' + i, ...(i ? { avatarUrl: 'https://cdn.example/retained.png' } : {}), observedAt: 1 } } } })
  }
  await section('members')
  await wait(() => expect(dialog().querySelector('img[src="https://cdn.example/first-ou_person_0.png"]')).not.toBeNull())
  expect(dialog().querySelector('img[src="https://cdn.example/retained.png"]')).not.toBeNull()
  expect(peopleCalls()).toEqual(['/open-apis/contact/v3/users/ou_person_0'])
  expect(dialog().textContent).toContain('Earlier 1')
  expect(dialog().textContent).toContain('Profile update unconfirmed')
})

it('Mote people reuse the original shared metadata lookup and late subscription readiness does not cancel the first visible native read', async () => {
  const { MoteChatPeople } = await import('../src/renderer/src/components/MoteChatPeople')
  const { MOTE_CHAT_DEFAULT_VALUES } = await import('@agentmux/core/mote-chat')
  const { api } = await import('../src/renderer/src/lib/api')
  const actor = subject().actor
  const configuration = { target: { spaceId: 'profile-space', zoneId: 'profile-zone', expectedResource: { hostId: 'local', workspaceId: 'workspace', workspacePath: f.original.root } }, revision: 1,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: true, connection: { connectionId: f.config.connectionId, application: f.config.application } }, creator: actor }
  vi.spyOn(api.moteChat, 'call').mockImplementation(async method => {
    if (method !== 'space.mote.chat.audience') throw Error('This profile consumer must not change chat policy')
    return { people: [{ actor, creator: true, revision: 1, total: null, used: 0, remaining: null, name: 'Earlier member' }], next: null } as any
  })
  const subscription = vi.mocked(api.connections.onMetadataChanged).getMockImplementation()!
  let ready: ((state: 'ready') => void) | undefined
  vi.mocked(api.connections.onMetadataChanged).mockImplementation((listener, state, target) => { ready = state; return subscription(listener, state, target) })
  hold = true
  await f.dom.render(<MoteChatPeople configuration={configuration} hostingTarget={f.hostingTarget} active refreshRevision={0} onSaved={() => { throw Error('No access mutation') }} />)
  await wait(() => expect(gates).toHaveLength(1))
  await act(async () => ready?.('ready'))
  expect(peopleCalls()).toHaveLength(1)
  hold = false; gates[0]!.resolve()
  await wait(() => expect(document.querySelector('[data-mote-chat-person] img')?.getAttribute('src')).toBe('https://cdn.example/first-ou_person_0.png'))
  expect(document.querySelector('[data-mote-chat-person]')?.textContent).toContain('Current member')
  expect(peopleCalls()).toHaveLength(1)
})
