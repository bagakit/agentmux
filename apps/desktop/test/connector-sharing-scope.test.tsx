// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile, readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { useAppStore } from '../src/renderer/src/store'

const f = connectorJourneyFixture({ publication: true, platform: async request => {
  if (request.url?.endsWith('/messages')) return { code: 0, data: { message_id: 'om_original', chat_id: 'oc_shared', msg_type: 'post' } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [{ chat_id: 'oc_shared', name: 'Design team', chat_status: 'normal' }], has_more: false } }
  return { code: 0, data: { name: 'Design team', chat_status: 'normal', chat_mode: 'group' } }
} })
const row = (id: string, type: 'assistant' | 'user') => JSON.stringify({ sessionId: 'original-native', uuid: id, type, message: { role: type, content: [{ type: 'text', text: 'Original ' + id }] } }) + '\n'
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }) }
async function select(label: string, value: string) {
  const trigger = document.querySelector<HTMLElement>('[aria-label="' + label + '"]')!
  expect(trigger, label).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  const option = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="' + value + '"]')!
  expect(option, value).not.toBeNull(); await act(async () => option.click())
}
async function consent() { await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click()) }
async function openExisting() { await f.mount(); await f.menu('Bind existing group chat'); await f.fill('Existing group ID', 'oc_shared') }

it('existing reply-only consent is not expanded by opening details and a broader scope requires explicit new confirmation at the same original audience', async () => {
  await openExisting(); expect(document.querySelector('[aria-label="Group sharing content"]')?.getAttribute('data-value')).toBe('future-native-user-facing')
  await consent(); await f.button('Connect group'); await ready('Sharing on')
  const original = (await f.services.connections.bindings!.list({})).bindings[0]!
  await f.button('Close'); await f.menu('Shared group details'); await ready('Sharing on')
  expect((await f.cli(['binding', 'inspect', '--binding', original.bindingId])).binding.scope.publication).toBe('future-native-user-facing')
  const change = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Change connected group')!
  await act(async () => change.querySelector('summary')!.click())
  await consent(); await select('Group sharing content', 'future-shared-conversation')
  expect(document.querySelector<HTMLInputElement>('.agent-connector-check input')!.checked).toBe(false)
  expect([...document.querySelectorAll<HTMLButtonElement>('footer button')].find(node => node.textContent === 'Change group')?.disabled).toBe(true)
  for (const text of ['human messages', 'Terminal input', 'questions, answers and resources', 'may not sync yet', 'Earlier history is not published', 'existing private context']) await ready(text)
  expect(f.calls.filter(call => call.method === 'connection.binding.relink')).toHaveLength(0)
  await consent(); await f.button('Change group'); await ready('New conversation content')
  const next = (await f.cli(['binding', 'inspect', '--binding', original.bindingId])).binding
  expect(next).toMatchObject({ bindingId: original.bindingId, revision: 2, externalConversationId: 'oc_shared', scope: { publication: 'future-shared-conversation' } })
  expect((await f.cli(['binding', 'inspect', '--binding', original.bindingId, '--revision', '1'])).binding.scope.publication).toBe('future-native-user-facing')
  expect(f.platformCalls.some(call => call.url?.endsWith('/messages'))).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)

it('the original default PublicationHost content gap remains readable beside its confirmed SDK delivery and inspects that exact effect without retrying', async () => {
  await openExisting(); await select('Group sharing content', 'future-shared-conversation'); await consent(); await f.button('Connect group'); await ready('Sharing on')
  const binding = (await f.services.connections.bindings!.list({})).bindings[0]!, metadata = await readFile(f.original.storePath)
  await appendFile(f.original.transcript, row('qualified-speech', 'assistant'))
  await vi.waitFor(() => expect(f.services.publication!.store.list(binding)[0]?.state).toBe('confirmed'), { timeout: 6000 })
  const effect = f.services.publication!.store.list(binding)[0]!
  await appendFile(f.original.transcript, row('unqualified-input', 'user'))
  await vi.waitFor(() => expect(f.services.publication!.observation(binding.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' }), { timeout: 6000 })
  await f.button('Close'); await f.menu('Shared group details'); await ready('Some content has not synced'); await ready('Latest delivery confirmed')
  const service = document.querySelector('.agent-connector-service')!
  expect(service.closest('details'), 'content gap is readable before opening receipt details').toBeNull()
  expect(service.textContent).toContain('keep working in the original conversation')
  await f.button('View original delivery'); expect(document.querySelector<HTMLDetailsElement>('[aria-label="Group delivery"] details')?.open).toBe(true)
  await f.button('Check receipt'); await ready('Platform receipt: confirmed · ' + effect.operationId)
  expect(f.calls.filter(call => call.method === 'connection.delivery.inspect').at(-1)?.input).toEqual({ operationId: effect.operationId })
  const listed = await f.cli(['delivery', 'ls', '--connection', binding.connectionId, '--binding', binding.bindingId, '--binding-revision', '1'])
  expect(listed.observation).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' })
  expect((await f.cli(['delivery', 'inspect', '--operation-id', effect.operationId])).delivery.state).toBe('confirmed')
  expect(f.platformCalls.filter(call => call.url?.endsWith('/messages'))).toHaveLength(1)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
  expect(await readFile(f.original.storePath)).toEqual(metadata); expect(f.original.client.connect).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
}, 25_000)
