// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { useAppStore } from '../src/renderer/src/store'
import type { RoomReadWire } from '../../../packages/connectors/test/fixtures/room-discovery'

let native: (request: RoomReadWire) => Promise<unknown>
const f = connectorJourneyFixture({ platform: request => native(request) })
beforeEach(() => { native = async request => {
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_original', name: 'Original person' }], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [{ chat_id: 'oc_original', name: 'Team group', chat_status: 'normal' }, { chat_id: 'oc_other', name: 'Team group', chat_status: 'normal' }, { chat_id: 'oc_unnamed', chat_status: 'normal' }], has_more: false } }
  return { code: 0, data: { name: 'Team group', chat_status: 'normal', chat_mode: 'group', membership_approval: 'approval_required' } }
} })
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function disclose(name: string) { const details = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === name)!; expect(details, name).toBeDefined(); if (!details.open) await act(async () => details.querySelector('summary')!.click()); expect(details.open).toBe(true) }
async function chooseGroup(id: string) {
  await vi.waitFor(async () => { await act(async () => {}); expect(f.calls.some(call => call.method === 'connection.room.ls' && call.result)).toBe(true) })
  const trigger = document.querySelector<HTMLElement>('[aria-label="Existing group"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  const item = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="' + id + '"]')
  expect(item, 'real room option from the original SDK page').not.toBeNull()
  await act(async () => item!.click())
}
async function consent() { await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click()) }

it('the original Agent menu selects an actual default-Host SDK room, confirms the exact audience and grants only an explicitly chosen real member', async () => {
  await f.mount(); await f.menu('Bind existing group chat')
  await chooseGroup('oc_other'); await ready('Original person')
  expect(document.querySelector('[aria-label="Agent and group conversation"] [aria-label="Existing group"]')?.getAttribute('data-value')).toBe('oc_other')
  expect(f.calls.filter(call => call.method === 'connection.bind' || call.method === 'connection.grant')).toHaveLength(0)
  expect(f.platformCalls.some(call => call.url?.endsWith('/chats/oc_other/members'))).toBe(true)
  await consent(); await f.button('Connect group'); await ready('Sharing on')
  const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  expect(binding).toMatchObject({ connectionId: f.config.connectionId, externalConversationId: 'oc_other', scope: { publication: 'future-native-user-facing' } })
  await disclose('People in this group'); await f.button('Choose')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Member access ID"]')?.value).toBe('ou_original')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Member access ID type"]')?.value).toBe('open_id')
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(0)
  await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(node => node.closest('label')?.textContent === 'Send requests')!.click())
  await f.button('Approve this member'); await ready('1 member approved')
  const receipt = await f.cli(['binding', 'inspect', '--binding', binding.bindingId])
  expect(receipt.grants).toMatchObject([{ actor: { application: f.config.application, idType: 'open_id', userId: 'ou_original' }, capabilities: ['input'] }])
  expect(f.platformCalls.some(call => call.method === 'POST')).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('search and pagination use the exact application and native cursor while unnamed groups retain their original identity', async () => {
  native = async request => {
    if (request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [{ chat_id: 'oc_unnamed', chat_status: 'normal' }], has_more: request.params?.page_token !== 'original-next', page_token: 'original-next' } }
    return { code: 0, data: { items: [], has_more: false } }
  }
  await f.mount(); await f.menu('Bind existing group chat'); await ready('No groups found')
  await f.fill('Search groups', 'Exact search'); await f.button('Search'); await ready('More groups')
  await f.button('More groups')
  await vi.waitFor(async () => { await act(async () => {}); expect(f.platformCalls.filter(call => call.url?.endsWith('/chats/search'))).toHaveLength(2) })
  const calls = f.platformCalls.filter(call => call.url?.endsWith('/chats/search'))
  expect(calls.map(call => call.params)).toMatchObject([{ query: 'Exact search', page_size: 20 }, { query: 'Exact search', page_size: 20, page_token: 'original-next' }])
  await chooseGroup('oc_unnamed')
  expect(document.querySelector('[aria-label="Existing group"]')?.getAttribute('data-value')).toBe('oc_unnamed')
  expect(document.querySelector('[aria-label="Existing group"]')?.textContent).toContain('oc_unnamed')
  expect(f.calls.filter(call => call.method === 'connection.room.search').every(call => (call.input as { connectionId: string; expectedConnectionRevision: number }).connectionId === f.config.connectionId && (call.input as { expectedConnectionRevision: number }).expectedConnectionRevision === 1)).toBe(true)
  expect(f.calls.some(call => call.method === 'connection.bind')).toBe(false)
  await f.original.unchanged()
}, 25_000)

it('an unavailable directory preserves the explicit exact-ID path and healthy original input without inventing members', async () => {
  native = async () => { throw new Error('Controlled unavailable transport') }
  await f.mount(); await f.menu('Bind existing group chat'); await ready('Groups could not be read')
  await f.fill('Existing group ID', 'oc_exact'); await ready('Group members are not confirmed')
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Original person')
  expect(f.calls.some(call => call.method === 'connection.grant' || call.method === 'connection.room.link.create')).toBe(false)
  await consent(); await f.button('Connect group'); await ready('Sharing on')
  expect((await f.services.connections.bindings!.list({})).bindings[0]?.externalConversationId).toBe('oc_exact')
  await f.original.unchanged()
}, 25_000)
