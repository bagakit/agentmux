// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import type { RoomReadWire } from '../../../packages/connectors/test/fixtures/room-discovery'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

let native: (input: RoomReadWire) => Promise<unknown>, joined: boolean
const f = connectorJourneyFixture({ platform: input => native(input) })
const people = (id: string, name: string) => ({ code: 0, data: { items: [{ member_id_type: 'open_id', member_id: id, name }], has_more: false } })
beforeEach(() => {
  joined = false
  native = async input => {
    if (input.url?.endsWith('/link')) return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=controlled-join', expire_time: String(Math.floor(Date.now() / 1000) + 300), is_permanent: false } }
    if (input.url?.endsWith('/members')) return joined ? people('ou_chosen', 'Chosen member') : { code: 0, data: { items: [], has_more: false } }
    if (input.url?.endsWith('/chats') && input.method?.toUpperCase() === 'POST') return { code: 0, data: { chat_id: 'oc_created' } }
    if (input.url?.endsWith('/chats') || input.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
    return { code: 0, data: { name: 'Original group', chat_status: 'normal', chat_mode: 'group', membership_approval: 'approval_required' } }
  }
})
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function consent() { await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click()) }
async function bindCreated() { await f.mount(); await f.menu('Create group chat'); await f.button('Create group'); await ready('Group created'); await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false')); await consent(); await f.button('Connect group') }

it('the original menu and default Host keep joining visible after an empty-invitation creation and local bind, then grant only a chosen real member', async () => {
  const open = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  await bindCreated(); await ready('Group saved')
  const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  expect(binding).toMatchObject({ externalConversationId: 'oc_created', state: 'active', revision: 1 })
  expect(document.querySelector('[aria-label="Group connection status"]')?.textContent).toContain('Sharing enabled locally')
  expect(document.querySelector('[aria-label="Group connection status"]')?.textContent).not.toContain('Sharing on')
  const join = document.querySelector('[aria-label="Joining this group"]')!
  expect(join.closest('details'), 'the original join next action remains outside collapsed details after bind').toBeNull()
  expect(join.textContent).toContain('Your own membership is not verified')
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Group member access"]')?.textContent).toContain('No members approved'))
  expect((await f.services.connections.bindings!.inspect({ bindingId: binding.bindingId })).grants).toEqual([])
  const creation = f.calls.find(call => call.method === 'connection.room.create')!
  expect(creation.input).toMatchObject({ members: [] })
  expect(creation.result).toMatchObject({ creation: { state: 'created', externalConversationId: 'oc_created' }, membership: { state: 'not-requested' } })
  expect(f.platformCalls.filter(call => call.url?.endsWith('/members') && call.method?.toUpperCase() === 'POST')).toHaveLength(0)
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(0)
  await f.button('Create join link'); await ready('Join link ready'); await f.button('Open join link')
  expect(open).toHaveBeenCalledOnce()
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).grants).toEqual([])
  expect(document.querySelector('[aria-label="Joining this group"]')?.textContent).toContain('Membership and Agent access still need confirmation')
  joined = true
  await f.button('Check group and members'); await ready('Chosen member')
  await f.button('Choose')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Member access ID"]')?.value).toBe('ou_chosen')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Member access ID type"]')?.value).toBe('open_id')
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(0)
  await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(node => node.closest('label')?.textContent === 'Send requests')!.click())
  await f.button('Approve this member'); await ready('1 member approved')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).grants).toMatchObject([{ actor: { application: f.config.application, idType: 'open_id', userId: 'ou_chosen' }, capabilities: ['input'] }])
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(1)
  expect(f.platformCalls.some(call => call.url?.includes('/messages'))).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('an unknown join of the original saved group survives remount and checks the same request without creating or inviting again', async () => {
  const original = native
  native = async input => input.url?.endsWith('/link') ? { code: 0, data: {} } : original(input)
  await bindCreated(); await ready('Group saved'); await f.button('Create join link'); await ready('Join link result not confirmed')
  const kept = Object.values(useAppStore.getState().connectorRoomIntents).find(item => item.method === 'connection.room.link.create')!
  expect(kept).toBeDefined()
  await f.button('Close'); await f.menu('Shared group details'); await ready('Join link result not confirmed')
  expect(document.querySelector('[aria-label="Joining this group"]')?.closest('details')).toBeNull()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    if (method === 'connection.room.link.inspect' && 'operationId' in input && input.operationId === kept.input.operationId) await held
    return await f.forward(method, input) as never
  })
  await f.button('Check link status')
  const progress = document.querySelector('[data-connector-request-pending]')
  expect(progress?.textContent ?? '').toContain('Working on this group request')
  expect(progress?.querySelector('svg')).not.toBeNull()
  expect(document.querySelector('[aria-label="Joining this group"]')?.textContent).toContain('Join link result not confirmed')
  release()
  await vi.waitFor(() => expect(document.querySelector('[data-connector-request-pending]')).toBeNull())
  await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.link.inspect').some(call => (call.input as { operationId: string }).operationId === kept.input.operationId)).toBe(true))
  expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(0)
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Group member access"]')?.textContent).toContain('No members approved'))
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Generate a new join link')
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', kept.input.operationId])).operation.state).toBe('unknown')
  await f.original.unchanged()
}, 25_000)

it('a returned original group keeps its current member page when an earlier reading of the same audience arrives late', async () => {
  let reads = 0, release!: (value: unknown) => void
  const late = new Promise<unknown>(resolve => { release = resolve }), original = native
  native = async input => {
    if (input.url?.endsWith('/oc_original/members')) return ++reads === 1 ? late : people('ou_current', 'Current member')
    if (input.url?.endsWith('/oc_other/members')) return people('ou_other', 'Other member')
    return original(input)
  }
  await f.mount(); await f.menu('Bind existing group chat'); await f.fill('Existing group ID', 'oc_original')
  await vi.waitFor(() => expect(reads).toBe(1))
  await f.fill('Existing group ID', 'oc_other'); await ready('Other member')
  await f.fill('Existing group ID', 'oc_original'); await ready('Current member')
  release(people('ou_old', 'Earlier member'))
  await vi.waitFor(async () => { await act(async () => {}); expect(f.calls.filter(call => call.method === 'connection.room.members' && call.result && (call.input as { externalConversationId: string }).externalConversationId === 'oc_original')).toHaveLength(2) })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Current member')
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Earlier member')
  expect(f.calls.filter(call => call.method === 'connection.grant' || call.method === 'connection.bind' || call.method === 'connection.room.create')).toHaveLength(0)
  await f.original.unchanged()
}, 25_000)
