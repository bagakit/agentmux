// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MOTE_CHAT_DEFAULT_VALUES } from '@agentmux/core/mote-chat'
import { AgentMuxError } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { copyConnectorIdentity } from './helpers/connector-identity-copy'

let f: Awaited<ReturnType<typeof moteBotUi>>
let missingExecutor = false
const application = { domain: 'signed.example', appId: 'private-chat-app' }
const creator = { application, idType: 'open_id', userId: 'original-creator' }
const guest = { ...creator, userId: 'original-guest' }
beforeEach(async () => {
  missingExecutor = false
  f = await moteBotUi({ generic: true, chatReadiness: async () => { if (missingExecutor) throw new AgentMuxError('Choose Executor for new chat before enabling this Mote.', 'MOTE_CHAT_EXECUTOR_REQUIRED') } })
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => f.topics.list(f.workspace))
  await act(async () => { await useAppStore.getState().refreshScratchTopics(f.workspace.id, true) })
  const { credentialRef } = await f.connections.secrets.store({ operationId: 'private-chat-credential', secret: 'controlled-private-chat-credential' })
  await f.client.call('connection.configure', { operationId: 'save-private-chat-bot', expectedRevision: null,
    connection: { connectionId: 'private-chat-bot', adapterId: 'signed-profile', application, label: 'Mote chat identity', enabled: true, credentialRef } })
  vi.spyOn(f.adapter.profile!, 'get').mockImplementation(async (config, revision) => ({ connectionId: config.connectionId, connectionRevision: revision,
    application: config.application, state: 'observed', language: null, profile: null, metadata: null, creator: { idType: creator.idType, userId: creator.userId }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }))
})
afterEach(async () => { await f?.close() })
const chat = () => document.querySelector<HTMLElement>('[data-mote-private-chat]')!
async function ready(check: () => void) { await vi.waitFor(async () => { await f.settle(); check() }, { timeout: 8000 }) }
async function fill(label: string, value: string) {
  const input = chat().querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input, label).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function button(text: string) {
  const node = [...chat().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!
  expect(node, text + '\n' + chat().textContent).toBeTruthy(); expect(node.disabled).toBe(false)
  await act(async () => node.click())
}
async function open() { await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off')) }
async function chooseAndEnable() {
  await ready(() => expect(chat().querySelector('[aria-label="Private chat bot"]')).not.toBeNull())
  const trigger = chat().querySelector<HTMLElement>('[aria-label="Private chat bot"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await ready(() => expect([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].some(item => item.textContent?.includes('Mote chat identity'))).toBe(true))
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes('Mote chat identity'))!.click())
  await act(async () => chat().querySelector<HTMLInputElement>('[aria-label="Enable Feishu private chat"]')!.click())
}
async function seed(limit = 2) {
  return await f.client.call('space.mote.chat.configure', { operationId: 'seed-chat-policy', target: f.target(), expectedRevision: null, expectedConnectionRevision: 1,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: true, connection: { connectionId: 'private-chat-bot', application }, strangerMessageLimit: limit } })
}

it('saves Profile chat policy through trusted IPC and the real public owner without changing group defaults, starting an Agent or enabling global sync', async () => {
  const before = await f.preferences.read({ kind: 'connection', target: f.target() })
  await open(); await chooseAndEnable(); await fill('Conversation update interval in minutes', '45'); await fill('New guest message allowance', '3')
  await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
  const current = (await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!
  expect(current.values).toEqual({ enabled: true, connection: { connectionId: 'private-chat-bot', application }, conversationIdleMs: 45 * 60000, strangerMessageLimit: 3 })
  expect(current.creator).toEqual(creator)
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target(1) })).configuration).toBeNull()
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).source).toEqual(before.source)
  expect((await f.client.call('connection.service.get', {})).enabled).toBe(false)
  expect(chat().textContent).toContain('Automatic chat sync is off.')
  expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
  expect(useAppStore.getState().moteChatIntents).toEqual({})
  await expect(f.handlers.get('moteChat:call')!({ sender: {} }, 'space.mote.chat.configure', { operationId: 'untrusted-write' })).rejects.toThrow('Untrusted renderer')
})

it('retains an unknown original save across Profile remount and inspects its exact receipt without replay or leaking the request into another Mote', async () => {
  await open(); await chooseAndEnable(); await fill('Conversation update interval in minutes', '47')
  const forward = f.chatRequests.getMockImplementation()!
  f.chatRequests.mockImplementation(async (method, input) => { const result = await forward(method, input); if (method === 'space.mote.chat.configure') throw Error('Controlled lost chat settings acknowledgement'); return result })
  await button('Save chat settings'); await ready(() => expect(chat().textContent).toContain('Chat settings were not confirmed.'))
  const input = structuredClone(f.chatRequests.mock.calls.find(([method]) => method === 'space.mote.chat.configure')![1])
  if (!('operationId' in input) || typeof input.operationId !== 'string') throw Error('The actual configuration input must retain its operation ID')
  expect(input.operationId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  expect(useAppStore.getState().moteChatIntents[input.operationId]?.input).toEqual(input)
  await f.render(0, true); await useAppStore.persist.rehydrate(); await f.renderMotePanel(1)
  await ready(() => expect(chat()?.getAttribute('data-mote-private-chat')).toBe(f.scopes[1]!.topic.id))
  expect(chat().querySelector('[data-mote-chat-request]')).toBeNull()
  await f.render(0, true); await f.renderMotePanel()
  await ready(() => expect(chat()?.querySelector('[data-mote-chat-request]')?.getAttribute('data-mote-chat-request')).toBe(input.operationId))
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Conversation update interval in minutes"]')!.value).toBe('47')
  await button('Check original request')
  await ready(() => expect(useAppStore.getState().moteChatIntents[input.operationId]).toBeUndefined())
  expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.configure')).toHaveLength(1)
  expect(f.chatRequests.mock.calls.some(([method, value]) => method === 'space.mote.chat.inspect' && 'operationId' in value && value.operationId === input.operationId)).toBe(true)
})

it('keeps a newer interval draft when a visible refresh returns an older original policy', async () => {
  await seed(); await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  const previous = await f.client.call('space.mote.chat.inspect', { target: f.target() }), forward = f.chatRequests.getMockImplementation()!
  let release!: (value: typeof previous) => void, held = false
  f.chatRequests.mockImplementation(async (method, input) => { if (method === 'space.mote.chat.inspect' && 'target' in input && !held) { held = true; return await new Promise(resolve => { release = resolve }) }; return forward(method, input) })
  await button('Refresh'); await fill('Conversation update interval in minutes', '90')
  await act(async () => release(previous))
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Conversation update interval in minutes"]')!.value).toBe('90')
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!.values.conversationIdleMs).toBe(MOTE_CHAT_DEFAULT_VALUES.conversationIdleMs)
})

it('keeps a refused enable draft and opens the original Executor preference without stranding it as an unknown write', async () => {
  await open(); await chooseAndEnable(); missingExecutor = true
  await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Choose Executor for new chat before enabling this Mote.'))
  expect(useAppStore.getState().moteChatIntents).toEqual({})
  expect(chat().textContent).toContain('Chat settings were not saved. Your draft is kept.')
  expect(chat().textContent).not.toContain('original request are kept')
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Enable Feishu private chat"]')!.checked).toBe(true)
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toBeNull()
  await button('Choose Executor')
  await ready(() => expect(document.querySelector('.mote-quick-mode-dialog')).not.toBeNull())
  expect(document.querySelector('.mote-quick-mode-dialog')!.textContent).toContain('Executor for new chat')
  await f.click('Close quick mode'); missingExecutor = false
  await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
  expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
})

it('shows creator unlimited access and each guest used, total and remaining allowance, then preserves used through a real allocation', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await seed()
  const service = await f.client.call('connection.service.get', {})
  await f.client.call('connection.service.configure', { operationId: 'allow-native-intake', expectedRevision: service.revision, service: { enabled: true } })
  for (const actor of [guest, creator]) {
    const saved = await f.connections.ingress!.receive({ connectionId: 'private-chat-bot', transportProof: 'controlled-signed-proof', raw: JSON.stringify({
      conversationKind: 'direct', eventId: 'event-' + actor.userId, messageId: 'message-' + actor.userId, externalConversationId: 'chat-' + actor.userId, actor, body: 'Original native private message', selection: 'message' }) }, () => {})
    // Native intake admits the real person before the deliberately unavailable Runtime boundary.
    await f.connections.ingress!.dispatch(saved.ingress.ingressId).catch(() => undefined)
  }
  expect((await f.client.call('space.mote.chat.audience', { target: f.target() })).people).toHaveLength(2)
  await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  await act(async () => chat().querySelector<HTMLElement>('.mote-private-chat__people > summary')!.click())
  await ready(() => expect(chat().querySelector('[data-mote-chat-person="original-guest"]')).not.toBeNull())
  const row = () => chat().querySelector<HTMLElement>('[data-mote-chat-person="original-guest"]')!
  expect(row().querySelectorAll('dd')[0]!.textContent).toBe('1'); expect(row().querySelectorAll('dd')[1]!.textContent).toBe('2'); expect(row().querySelectorAll('dd')[2]!.textContent).toBe('1')
  const creatorRow = chat().querySelector<HTMLElement>('[data-mote-chat-person="original-creator"]')!
  expect(creatorRow.textContent).toContain('Creator · unlimited'); expect(creatorRow.textContent).not.toContain('Edit allowance')
  expect(row().querySelector('[data-entity-kind="person"]')).not.toBeNull()
  expect(row().querySelector('[aria-label="Copy person name"]')).toBeNull()
  await copyConnectorIdentity(row(), 'Copy open_id', guest.userId)
  await copyConnectorIdentity(creatorRow, 'Copy open_id', creator.userId)
  expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.allocate')).toHaveLength(0)
  await act(async () => [...row().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit allowance')!.click())
  await fill('Total allowance for original-guest', '5')
  await act(async () => row().querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await ready(() => expect(row().querySelectorAll('dd')[1]!.textContent, chat().textContent ?? '').toBe('5'))
  const allocation = f.chatRequests.mock.calls.find(([method]) => method === 'space.mote.chat.allocate')![1]
  if (!('operationId' in allocation)) throw Error('The actual allocation must retain its operation ID')
  expect(allocation.operationId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  expect(row().querySelectorAll('dd')[0]!.textContent).toBe('1'); expect(row().querySelectorAll('dd')[2]!.textContent).toBe('4')
  expect((await f.client.call('space.mote.chat.audience', { target: f.target() })).people.find(person => person.actor.userId === guest.userId)).toMatchObject({ used: 1, total: 5, remaining: 4 })
})
