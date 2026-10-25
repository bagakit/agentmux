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
  await section('members'); await act(async () => refresh().click())
  await wait(() => { expect(refresh().disabled).toBe(false); expect(dialog().querySelector('img[src="https://cdn.example/second-ou_person_0.png"]')).not.toBeNull() })
  expect(peopleCalls()).toHaveLength(1)
  const cached = await profile(), firstTime = cached.entry.observation.profile!.observedAt
  partial = true
  await act(async () => refresh().click()); await wait(() => expect(refresh().disabled).toBe(false))
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
it('leaving and returning to members permanently cancels the old bounded actor batch and releases group refresh while native reads remain pending', async () => {
  count = 7; await open()
  const cache = new ChannelStorage(f.services.database!).namespace(f.config)
  for (let index = 0; index < 128; index++) {
    const actor = { application: f.config.application, idType: 'open_id', userId: 'ou_unrelated_' + index }
    cache.put({ key: 'actor-profile:' + channelActorKey(actor), expectedRevision: null, value: { kind: 'json', value: { actor, state: 'observed', checkedAt: 1, freshness: 'stale', profile: { name: 'Unrelated earlier observation', observedAt: 1 } } } })
  }
  await section('members'); hold = true
  await act(async () => refresh().click()); await wait(() => expect(gates).toHaveLength(4))
  expect(peopleCalls()).toHaveLength(4); expect(refresh().disabled).toBe(true)
  await section('overview'); await wait(() => expect(refresh().disabled).toBe(false))
  await act(async () => refresh().click()); await wait(() => expect(refresh().disabled).toBe(false))
  await section('members')
  hold = false; gates.forEach(gate => gate.resolve())
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.metadata.refresh' && (call.input as { subject?: { kind: string } }).subject?.kind === 'actor' && call.result)).toHaveLength(4))
  expect(peopleCalls()).toHaveLength(4)
  await act(async () => refresh().click()); await wait(() => expect(refresh().disabled).toBe(false))
  expect(peopleCalls()).toHaveLength(11)
  const final = peopleCalls().slice(4).map(path => path.split('/').at(-1))
  expect(new Set(final).size).toBe(7)
}, 30_000)
