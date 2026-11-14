// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
// Reuse the existing full-App DOM boundary; native terminal attachment is not this navigation proof.
import './fixtures/mote-app'
import { MOTE_CHAT_DEFAULT_VALUES } from '@agentmux/core/mote-chat'
import { AgentMuxError } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { moteChatDraftKey } from '../src/renderer/src/lib/mote-chat-draft'
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
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (workspaceId, id) => workspaceId === f.workspace.id ? f.topics.read(f.workspace, id) : null)
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
  await act(async () => chat().querySelector<HTMLInputElement>('[aria-label="Enable external private chat"]')!.click())
}
async function seed(limit = 2) {
  return await f.client.call('space.mote.chat.configure', { operationId: 'seed-chat-policy', target: f.target(), expectedRevision: null, expectedConnectionRevision: 1,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: true, connection: { connectionId: 'private-chat-bot', application }, strangerMessageLimit: limit } })
}

it('saves Profile chat policy through trusted IPC and the real public owner without changing group defaults, starting an Agent or enabling global sync', async () => {
  const before = await f.preferences.read({ kind: 'connection', target: f.target() })
  await open(); await chooseAndEnable(); await fill('Guest conversation inactivity in minutes', '45'); await fill('New guest message allowance', '3')
  await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
  const current = (await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!
  expect(current.values).toEqual({ enabled: true, connection: { connectionId: 'private-chat-bot', application }, conversationIdleMs: 45 * 60000, strangerMessageLimit: 3 })
  expect(current.creator).toBeNull()
  expect(f.adapter.profile!.get).not.toHaveBeenCalled()
  expect(f.chatRequests.mock.calls.find(([method]) => method === 'space.mote.chat.configure')![1]).not.toHaveProperty('refreshCreator')
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target(1) })).configuration).toBeNull()
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).source).toEqual(before.source)
  expect((await f.client.call('connection.service.get', {})).enabled).toBe(false)
  expect(chat().textContent).toContain('Automatic chat sync is off.')
  expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
  expect(useAppStore.getState().moteChatIntents).toEqual({})
})

it('retains an unknown original save across Profile remount and inspects its exact receipt without replay or leaking the request into another Mote', async () => {
  await open(); await chooseAndEnable(); await fill('Guest conversation inactivity in minutes', '47')
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
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('47')
  await button('Check original request')
  await ready(() => expect(useAppStore.getState().moteChatIntents[input.operationId]).toBeUndefined())
  expect(useLauncherState.getState().drafts[moteChatDraftKey({ kind: 'policy', target: f.target(), hostingTarget: f.hostingTarget })]?.moteChat).toBeUndefined()
  expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.configure')).toHaveLength(1)
  expect(f.chatRequests.mock.calls.some(([method, value]) => method === 'space.mote.chat.inspect' && 'operationId' in value && value.operationId === input.operationId)).toBe(true)
})

it('keeps a newer interval draft when a visible refresh returns an older original policy', async () => {
  await seed(); await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  const previous = await f.client.call('space.mote.chat.inspect', { target: f.target() }), forward = f.chatRequests.getMockImplementation()!
  let release!: (value: typeof previous) => void, held = false
  f.chatRequests.mockImplementation(async (method, input) => { if (method === 'space.mote.chat.inspect' && 'target' in input && !held) { held = true; return await new Promise(resolve => { release = resolve }) }; return forward(method, input) })
  await button('Refresh'); await fill('Guest conversation inactivity in minutes', '90')
  await act(async () => release(previous))
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('90')
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!.values.conversationIdleMs).toBe(MOTE_CHAT_DEFAULT_VALUES.conversationIdleMs)
})

it('keeps a refused enable draft and opens the original Executor preference without stranding it as an unknown write', async () => {
  await open(); await chooseAndEnable(); missingExecutor = true
  await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Choose Executor for new chat before enabling this Mote.'))
  expect(useAppStore.getState().moteChatIntents).toEqual({})
  expect(chat().textContent).toContain('Chat settings were not saved. Your draft is kept.')
  expect(chat().textContent).not.toContain('original request are kept')
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Enable external private chat"]')!.checked).toBe(true)
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toBeNull()
  await button('Mote preferences')
  expect(document.querySelector('.mote-quick-mode-dialog')).not.toBeNull()
  expect(document.querySelector('.mote-quick-mode-dialog')!.textContent).toContain('Executor for new chat')
  await f.click('Close quick mode'); missingExecutor = false
  await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
  expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
})

it('shows the native creator policy and each guest used, total and remaining allowance, then preserves used through a real allocation', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const seeded = await seed()
  await f.client.call('space.mote.chat.configure', { operationId: 'confirm-policy-creator', target: f.target(), expectedRevision: seeded.configuration.revision, expectedConnectionRevision: 1, values: seeded.configuration.values, refreshCreator: true })
  const service = await f.client.call('connection.service.get', {})
  await f.client.call('connection.service.configure', { operationId: 'allow-native-intake', expectedRevision: service.revision, service: { enabled: true } })
  for (const actor of [guest]) {
    const saved = await f.connections.ingress!.receive({ connectionId: 'private-chat-bot', transportProof: 'controlled-signed-proof', raw: JSON.stringify({
      conversationKind: 'direct', eventId: 'event-' + actor.userId, messageId: 'message-' + actor.userId, externalConversationId: 'chat-' + actor.userId, actor, body: 'Original native private message', selection: 'message' }) }, () => {})
    // Native intake admits the real person before the deliberately unavailable Runtime boundary.
    await f.connections.ingress!.dispatch(saved.ingress.ingressId).catch(() => undefined)
  }
  expect((await f.client.call('space.mote.chat.audience', { target: f.target() })).people).toHaveLength(1)
  const originalCall = api.connections.call
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, owner) => {
    if (method === 'connection.metadata.get' && 'subject' in input && input.subject.kind === 'actor') {
      return { connectionId: input.connectionId, connectionRevision: 1, application, entry: { subject: input.subject, cacheRevision: 'stale-profile', observation: { actor: input.subject.actor, state: 'unavailable', freshness: 'stale', checkedAt: 1, profile: { name: 'Previously observed person', observedAt: 1 } } } } as any
    }
    return originalCall(method, input, owner)
  })
  await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  await act(async () => chat().querySelector<HTMLElement>('.mote-private-chat__people > summary')!.click())
  await ready(() => expect(chat().querySelector('[data-mote-chat-person="original-guest"]')).not.toBeNull())
  const row = () => chat().querySelector<HTMLElement>('[data-mote-chat-person="original-guest"]')!
  expect(row().querySelectorAll('dd')[0]!.textContent).toBe('1'); expect(row().querySelectorAll('dd')[1]!.textContent).toBe('2'); expect(row().querySelectorAll('dd')[2]!.textContent).toBe('1')
  expect(chat().textContent).toContain('The confirmed native creator uses Main and has unlimited access.')
  expect(row().querySelector('[data-entity-kind="person"]')).not.toBeNull()
  await ready(() => expect(row().querySelector('.connector-entity__profile-note[role="status"]')?.textContent).toBe('Profile update unconfirmed'))
  const accountDetails = row().querySelector<HTMLDetailsElement>('.agent-connector-disclosure')!
  expect(accountDetails.open).toBe(false)
  expect(accountDetails.querySelector('p')?.textContent).toBe('The original adapter does not expose typed metadata management.')
  expect(row().querySelector('.connector-entity')?.textContent).not.toContain('typed metadata management')
  await act(async () => accountDetails.querySelector<HTMLElement>('summary')!.click())
  expect(accountDetails.open).toBe(true)
  await copyConnectorIdentity(row(), 'Copy person name', 'Previously observed person')
  await copyConnectorIdentity(row(), 'Copy open_id', guest.userId)
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

it('keeps clean refresh and edited saves on the original hosting owner when another connector page changes its global selection', async () => {
  await open()
  const discovery = vi.mocked(api.connections.hostingTarget); discovery.mockClear()
  const foreign = { hostId: 'another-host', runtimeId: 'another-runtime' }
  await act(async () => useAppStore.setState({ manualConnectionSelections: { lark: foreign, discord: foreign } }))
  await button('Refresh')
  await ready(() => expect(chat().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off'))
  await chooseAndEnable(); await fill('Guest conversation inactivity in minutes', '49')
  await button('Refresh'); await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
  expect(discovery).not.toHaveBeenCalled()
  expect(f.chatRequests.mock.calls.every(([, , owner]) => JSON.stringify(owner) === JSON.stringify(f.hostingTarget))).toBe(true)
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration?.values.conversationIdleMs).toBe(49 * 60000)
})

it('keeps a retained request with missing original hosting unknown without discovering or querying another owner', async () => {
  const input = { operationId: 'retained-without-hosting', target: f.target(), expectedRevision: null, expectedConnectionRevision: null, values: { ...MOTE_CHAT_DEFAULT_VALUES } }
  await act(async () => useAppStore.setState({ moteChatIntents: { [input.operationId]: { method: 'space.mote.chat.configure', phase: 'not-dispatched', input } } }))
  f.chatRequests.mockClear()
  await f.renderMotePanel()
  await ready(() => expect(chat()).not.toBeNull())
  expect(f.chatRequests).not.toHaveBeenCalled()
  expect(chat().textContent).toContain('The original bot hosting Host is not recorded.')
  expect(useAppStore.getState().moteChatIntents[input.operationId]?.input).toEqual(input)
})

it('shows unknown native creator as a Main limitation while saving finite guest policy through the original public owner', async () => {
  vi.mocked(f.adapter.profile!.get).mockImplementation(async (config, revision) => ({ connectionId: config.connectionId, connectionRevision: revision,
    application: config.application, state: 'observed', language: null, profile: null, metadata: null, creator: null, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }))
  await seed(0); await f.renderMotePanel()
  await ready(() => expect(chat()?.textContent).toContain('Native creator not confirmed.'))
  expect(chat().textContent).toContain('Zero blocks new guests until you explicitly grant an allowance.')
  expect(chat().textContent).toContain('Shared Mote Executor')
  await fill('New guest message allowance', '3'); await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toMatchObject({ creator: null, values: { enabled: true, strangerMessageLimit: 3 } })
  expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
})

it('confirms Main identity with saved values while preserving a dirty guest draft and keeps a later refused refresh separate from saved proof', async () => {
  const seeded = await seed(2)
  await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  await fill('Guest conversation inactivity in minutes', '47')
  await button('Confirm Main identity')
  await ready(() => expect(chat().textContent).toContain('Main identity confirmed for private-chat-app.'))
  const refreshCall = f.chatRequests.mock.calls.find(([method, input]) => method === 'space.mote.chat.configure' && 'refreshCreator' in input && input.refreshCreator)
  expect(refreshCall).toBeDefined()
  const refresh = refreshCall![1]
  expect(refresh).toMatchObject({ values: seeded.configuration.values, expectedRevision: seeded.configuration.revision, expectedConnectionRevision: 1, refreshCreator: true })
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('47')
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toMatchObject({ creator, values: seeded.configuration.values })
  vi.mocked(f.adapter.profile!.get).mockImplementation(async (config, revision) => ({ connectionId: config.connectionId, connectionRevision: revision, application: config.application,
    state: 'unknown', language: null, profile: null, metadata: null, creator: null, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }))
  await button('Refresh Main identity')
  await ready(() => expect(chat().textContent).toContain('The original Main identity check was not confirmed.'))
  expect(chat().textContent).toContain('Confirmed bot creator')
  expect(useAppStore.getState().moteChatIntents).toEqual({})
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration?.creator).toEqual(creator)
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('47')
})

it('saves an independent guest policy while an identity read is held and rejects its original late CAS without replay or overwriting the draft', async () => {
  const seeded = await seed(2), profile = vi.mocked(f.adapter.profile!.get), qualify = profile.getMockImplementation()!
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  profile.mockImplementation(async (...args) => { await held; return qualify(...args) })
  await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  await fill('Guest conversation inactivity in minutes', '47'); await button('Confirm Main identity')
  await ready(() => expect(profile).toHaveBeenCalledTimes(1))
  const refresh = structuredClone(f.chatRequests.mock.calls.find(([method, input]) => method === 'space.mote.chat.configure' && 'refreshCreator' in input && input.refreshCreator)![1])
  expect(refresh).toMatchObject({ values: seeded.configuration.values, expectedRevision: 1, refreshCreator: true })
  try {
    await fill('Guest conversation inactivity in minutes', '49'); await fill('New guest message allowance', '4')
    await button('Save chat settings')
    await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
    const saved = (await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!
    expect(saved).toMatchObject({ revision: 2, creator: null, values: { conversationIdleMs: 49 * 60000, strangerMessageLimit: 4 } })
    await act(async () => release())
    await ready(() => expect(chat().textContent).toContain('The original Main identity check was not confirmed.'))
    expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toEqual(saved)
    expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('49')
    expect(f.chatRequests.mock.calls.filter(([method, input]) => method === 'space.mote.chat.configure' && 'refreshCreator' in input && input.refreshCreator).map(([, input]) => input)).toEqual([refresh])
    expect(useAppStore.getState().moteChatIntents).toEqual({})
  } finally { await act(async () => release()) }
})

it('restores unknown identity requests on their original owner without treating them as guest drafts or blocking a newer policy save', async () => {
  await seed(2)
  const forward = f.chatRequests.getMockImplementation()!
  f.chatRequests.mockImplementation(async (method, input, owner) => { const result = await forward(method, input, owner); if (method === 'space.mote.chat.configure' && 'refreshCreator' in input && input.refreshCreator) throw Error('Controlled lost identity acknowledgement'); return result })
  await f.renderMotePanel(); await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  await button('Confirm Main identity')
  await ready(() => expect(chat().textContent).toContain('The original Main identity check was not confirmed.'))
  const original = structuredClone(Object.values(useAppStore.getState().moteChatIntents)[0]!)
  expect(original).toMatchObject({ method: 'space.mote.chat.configure', hostingTarget: f.hostingTarget, phase: 'may-have-dispatched', input: { refreshCreator: true } })
  const current = (await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!
  await f.client.call('space.mote.chat.configure', { operationId: 'other-current-policy', target: f.target(), expectedRevision: current.revision, expectedConnectionRevision: 1,
    values: { ...current.values, conversationIdleMs: 52 * 60000, strangerMessageLimit: 7 } })
  await f.renderMotePanel(1)
  vi.mocked(api.connections.hostingTarget).mockResolvedValue({ hostId: 'other-default', runtimeId: 'other-runtime' })
  await f.renderMotePanel()
  await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('52')
  expect(chat().textContent).toContain('Main identity · result not confirmed')
  expect(useAppStore.getState().moteChatIntents[original.input.operationId]).toEqual(original)
  await fill('New guest message allowance', '8'); await button('Save chat settings')
  await ready(() => expect(chat().textContent).toContain('Original chat settings save confirmed.'))
  await fill('Guest conversation inactivity in minutes', '55')
  await button('Check original request')
  await ready(() => expect(useAppStore.getState().moteChatIntents).toEqual({}))
  expect(chat().textContent).toContain('Original Main identity confirmation recorded for private-chat-app.')
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('55')
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration).toMatchObject({ revision: 4, values: { conversationIdleMs: 52 * 60000, strangerMessageLimit: 8 } })
  expect(f.chatRequests.mock.calls.filter(([method, input]) => method === 'space.mote.chat.configure' && 'refreshCreator' in input && input.refreshCreator)).toHaveLength(1)
})

async function applicationProfile() {
  await f.renderApplicationMote(); await f.click('Profile')
  await ready(() => expect(document.querySelector('.mote-profile__preferences > summary')).not.toBeNull())
  const details = document.querySelector<HTMLDetailsElement>('.mote-profile__preferences')!
  if (!details.open) await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  await ready(() => expect(chat()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBeDefined())
}

it('replaces an unconfirmed identity notice after inspecting that exact saved receipt without losing a newer guest draft', async () => {
  await seed(); await f.renderMotePanel(); await ready(() => expect(chat()?.textContent).toContain('Confirm Main identity'))
  const forward = f.chatRequests.getMockImplementation()!
  f.chatRequests.mockImplementation(async (method, input, owner) => { const result = await forward(method, input, owner); if (method === 'space.mote.chat.configure' && 'refreshCreator' in input && input.refreshCreator) throw Error('Controlled lost identity acknowledgement'); return result })
  await button('Confirm Main identity'); await ready(() => expect(chat().textContent).toContain('The original Main identity check was not confirmed.'))
  await fill('Guest conversation inactivity in minutes', '58'); await button('Check original request')
  await ready(() => expect(chat().textContent).toContain('Original Main identity confirmation recorded for'))
  expect(chat().textContent).not.toContain('The original Main identity check was not confirmed.')
  expect(chat().querySelector<HTMLInputElement>('[aria-label="Guest conversation inactivity in minutes"]')!.value).toBe('58')
})

it.each([
  ['feishu', 'open.feishu.cn', 'lark'], ['discord', 'discord.com', 'discord'], ['telegram', 'telegram.org', 'telegram']
])('opens the exact saved %s application through the real App navigation and original Settings consumer', async (adapterId, domain, section) => {
  const app = { domain, appId: 'selected-' + adapterId }, connectionId = 'connection-' + adapterId
  const { credentialRef } = await f.connections.secrets.store({ operationId: 'native-reference-credential', secret: 'private-test-token' })
  await f.client.call('connection.configure', { operationId: 'save-native-reference', expectedRevision: null, connection: { connectionId, adapterId, application: app, label: 'Selected ' + adapterId, enabled: true, credentialRef } })
  await f.client.call('space.mote.chat.configure', { operationId: 'select-native-chat', target: f.target(), expectedRevision: null, expectedConnectionRevision: 1,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, connection: { connectionId, application: app } } })
  await applicationProfile(); await button('Manage bot identity')
  await ready(() => expect(document.querySelector('[data-settings-page]')).not.toBeNull())
  expect(document.querySelector('[data-settings-page]')?.getAttribute('data-settings-page')).toBe(section)
  const pane = document.querySelector<HTMLElement>(`[data-settings-pane="${section}"]`)!
  expect(pane.querySelector<HTMLSelectElement>('[aria-label="Connector hosting Host"]')?.value).toBe('original')
  await ready(() => expect(pane.textContent).toContain(app.appId))
  expect(pane.querySelector('[data-connector-mote-detail]')).toBeNull()
  expect(pane.querySelector('.connector-editor-title')?.textContent).toBe('Selected ' + adapterId)
  expect(f.connectionCalls.mock.calls.some(([method, , owner]) => method === 'connection.ls' && JSON.stringify(owner) === JSON.stringify(f.hostingTarget))).toBe(true)
  if (section !== 'lark') expect(pane.querySelector('[data-enrollment-create]')).toBeNull()
})

it('requires an explicit connector choice before managing bots when no application is selected', async () => {
  await applicationProfile()
  expect(document.querySelector('[data-settings-page]')).toBeNull()
  const trigger = chat().querySelector<HTMLElement>('[aria-label="Manage connector"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await ready(() => expect(document.querySelector('.selection-field__option[data-value="telegram"]')).not.toBeNull())
  await act(async () => (document.querySelector('.selection-field__option[data-value="telegram"]') as HTMLElement).click())
  await ready(() => expect(document.querySelector<HTMLElement>('[data-settings-pane="telegram"]')?.hidden).toBe(false))
  expect(document.querySelector('[data-settings-pane="telegram"]')?.textContent).toContain('Connect a bot')
  expect(f.chatRequests.mock.calls.some(([method]) => method === 'space.mote.chat.configure')).toBe(false)
})
