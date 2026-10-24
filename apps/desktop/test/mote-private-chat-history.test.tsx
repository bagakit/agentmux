// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { MOTE_CHAT_DEFAULT_VALUES, parseMoteChatDiagnosis, type MoteChatDiagnosis, type MoteChatGeneration, type MoteChatTarget } from '@agentmux/core/mote-chat'
import type { ConnectionHostingTarget } from '../src/shared/contracts'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { composerConfig } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { RuntimeController } from '../src/main/runtime-controller'

let f: Awaited<ReturnType<typeof moteBotUi>>
let history: MoteChatStore
const closes: Array<() => Promise<unknown>> = []
const application = { domain: 'signed.example', appId: 'original-private-bot' }
const alice = { application, idType: 'open_id', userId: 'same-user' }
const other = { ...alice, application: { ...application, appId: 'other-private-bot' } }
beforeEach(async () => {
  f = await moteBotUi({ generic: true, chatReadiness: async () => {} })
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => f.topics.list(f.workspace))
  await act(async () => useAppStore.getState().refreshScratchTopics(f.workspace.id, true))
  const { credentialRef } = await f.connections.secrets.store({ operationId: 'history-credential', secret: 'controlled-history-credential' })
  await f.client.call('connection.configure', { operationId: 'history-bot', expectedRevision: null,
    connection: { connectionId: 'private-bot', adapterId: 'signed-profile', application, label: 'Original private bot', enabled: true, credentialRef } })
  vi.spyOn(f.adapter.profile!, 'get').mockImplementation(async (config, revision) => ({ connectionId: config.connectionId, connectionRevision: revision,
    application: config.application, state: 'observed', language: null, profile: null, metadata: null, creator: { idType: alice.idType, userId: alice.userId }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }))
  await f.client.call('space.mote.chat.configure', { operationId: 'history-policy', target: f.target(), expectedRevision: null, expectedConnectionRevision: 1,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: true, connection: { connectionId: 'private-bot', application } } })
  history = new MoteChatStore(await f.connections.openDatabase())
  for (const actor of [alice, other]) history.savePerson({ key: JSON.stringify([f.target().spaceId, actor.application.domain, actor.application.appId, actor.idType, actor.userId]), spaceId: f.target().spaceId,
    person: { actor, name: 'Same display name', creator: false, revision: 1, total: 4, used: 1, remaining: 3 } })
})
afterEach(async () => {
  const errors: unknown[] = []
  try { await f?.close() } catch (error) { errors.push(error) }
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private history fixture cleanup failed')
})
const panel = () => document.querySelector<HTMLElement>('[data-mote-private-chat]')!
async function settle(check: () => void) { await vi.waitFor(async () => { await f.settle(); check() }, { timeout: 6000 }) }
async function click(text: string, within: ParentNode = panel()) {
  const node = [...within.querySelectorAll<HTMLElement>('button,summary')].find(node => node.textContent?.trim() === text || node.getAttribute('aria-label') === text)!
  expect(node, text).toBeTruthy(); expect((node as HTMLButtonElement).disabled).not.toBe(true)
  await act(async () => node.click()); await f.settle()
}
async function show() { await f.renderMotePanel(); await settle(() => expect(panel()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on')); await click('People & conversations'); await settle(() => expect(panel().querySelectorAll('[data-mote-chat-person]')).toHaveLength(2)) }
const person = (appId = application.appId) => [...panel().querySelectorAll<HTMLElement>('[data-mote-chat-person]')].find(row => row.querySelectorAll('code')[1]?.textContent === appId)!
function seed(id: string, actor = alice, hostId = 'local'): MoteChatGeneration {
  const generation: MoteChatGeneration = { generationId: 'generation-' + id, target: f.target(), application: actor.application,
    externalConversationId: 'private-' + actor.application.appId, actor, executionHostId: hostId, agentSessionId: id,
    createOperationId: 'create-' + id, phase: 'ready', createdAt: 1, lastActivityAt: 2 }
  history.insertGeneration({ sequence: 0, laneKey: JSON.stringify(actor), connectionId: 'private-bot', configurationRevision: 1,
    authorizedBy: { kind: 'user', id: 'original-user' }, generation, prepared: null, dispatched: true, binding: null, grant: null })
  return generation
}

it('preserves in-flight diagnosis across unrelated Profile renders while reading true scope and refresh changes', async () => {
  const originalCall = f.runtime.callConnectionHost, nextOwner = { hostId: 'next-host', runtimeId: 'next-runtime' }
  const reads: Array<{ target: MoteChatTarget; owner: ConnectionHostingTarget; release(issue: MoteChatDiagnosis['issues'][number]): Promise<void> }> = []
  f.runtime.callConnectionHost = async (owner, method, params) => {
    if (method !== 'space.mote.chat.diagnose') return originalCall(JSON.stringify(owner) === JSON.stringify(nextOwner) ? f.hostingTarget : owner, method, params)
    const input = params as { target: MoteChatTarget }
    return new Promise(resolve => reads.push({ target: input.target, owner, release: async issue => {
      const original = await originalCall(f.hostingTarget, method, params)
      resolve(parseMoteChatDiagnosis({ ...original, issues: [issue] }, input) as never)
    } }))
  }
  const activity = () => panel().querySelector<HTMLElement>('[aria-label="Private chat message activity"]')!
  const release = async (index: number, issue: MoteChatDiagnosis['issues'][number]) => {
    await act(async () => reads[index]!.release(issue)); await settle(() => expect(activity().getAttribute('aria-busy')).toBe('false'))
    expect(activity().textContent).toContain(issue)
  }
  await f.renderMotePanel(); await settle(() => expect(reads).toHaveLength(1))
  const originalPanel = panel(), originalActivity = activity()
  await f.renderMotePanel(); await f.renderMotePanel()
  expect(panel()).toBe(originalPanel); expect(activity()).toBe(originalActivity)
  expect(reads, 'Same target/Host parent renders must retain the original pending diagnosis').toHaveLength(1)
  expect(reads[0]).toMatchObject({ target: f.target(), owner: f.hostingTarget })
  await release(0, 'intake-unavailable')

  await click('Refresh private chat activity'); expect(reads).toHaveLength(2)
  await release(1, 'connection-unavailable')
  await f.renderMotePanel(0, false); expect(reads).toHaveLength(2)
  await f.renderMotePanel(); await settle(() => expect(reads).toHaveLength(3))
  await release(2, 'service-unavailable')
  const minutes = panel().querySelector<HTMLInputElement>('[aria-label="Conversation update interval in minutes"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(minutes, '47'); minutes.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Save chat settings'); await settle(() => expect(reads).toHaveLength(4))
  expect((await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration?.revision).toBe(2)
  await release(3, 'configuration-unavailable')

  await click('Refresh private chat activity'); expect(reads).toHaveLength(5)
  await f.renderMotePanel(1); await settle(() => expect(reads).toHaveLength(6))
  expect(reads[5]).toMatchObject({ target: f.target(1), owner: f.hostingTarget })
  await release(5, 'intake-unavailable')
  await act(async () => reads[4]!.release('target-changed')); await f.settle()
  expect(activity().textContent).toContain('intake-unavailable'); expect(activity().textContent).not.toContain('target-changed')
  await click('Refresh private chat activity'); expect(reads).toHaveLength(7)
  await act(async () => useAppStore.setState({ manualConnectionSelections: { lark: nextOwner } }))
  await click('Refresh'); await settle(() => expect(reads).toHaveLength(8))
  expect(reads[7]).toMatchObject({ target: f.target(1), owner: nextOwner })
  await release(7, 'service-unavailable')
  await act(async () => reads[6]!.release('target-changed')); await f.settle()
  expect(activity().textContent).toContain('service-unavailable'); expect(activity().textContent).not.toContain('target-changed')
  await f.renderMotePanel(1); expect(reads).toHaveLength(8)
  expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
})

it('reads exact-person generations through Profile IPC/Host and real Core inputs without a presentation or lifecycle', async () => {
  seed('earliest'); seed('middle'); seed('recent'); const selected = seed('original-agent'); seed('foreign-agent', other)
  const core = await ingressFixture(false); closes.push(() => core.close())
  const intake = await core.receive(); await core.ingress.dispatch(intake.ingress.ingressId)
  const controller = new RuntimeController(core.store, async () => core.client); closes.push(() => controller.dispose())
  controller.commit(await controller.prepare(composerConfig))
  const read = vi.spyOn(api.sessions, 'inputMailbox').mockImplementation((target, options) => {
    expect(target).toEqual({ hostId: 'local', agentSessionId: 'original-agent' })
    return controller.inputMailbox(target, options)
  })
  const submit = vi.spyOn(core.client, 'submitAgentPrompt'), rejoin = vi.spyOn(core.client, 'rejoinAgentInputWaiting')
  await show()
  expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.history')).toHaveLength(0)
  await click('Conversations', person())
  await settle(() => expect(person().querySelectorAll('[data-mote-chat-generation]')).toHaveLength(3))
  expect(person().textContent).toContain('original-agent'); expect(person().textContent).not.toContain('foreign-agent')
  expect(f.chatRequests.mock.calls.find(([method]) => method === 'space.mote.chat.history')).toEqual(['space.mote.chat.history', { target: f.target(), actor: alice, limit: 3 }, f.hostingTarget])
  await click('Earlier conversations', person()); await settle(() => expect(person().querySelectorAll('[data-mote-chat-generation]')).toHaveLength(4))
  expect(person().textContent).toContain('earliest')
  const row = person().querySelector<HTMLElement>(`[data-mote-chat-generation="${selected.generationId}"]`)!
  await click('View messages', row)
  await settle(() => expect(read).toHaveBeenCalled())
  expect(read.mock.calls[0]?.[0]).toEqual({ hostId: 'local', agentSessionId: 'original-agent' })
  await settle(() => expect(row.querySelector('[data-input-mailbox-key]')?.textContent).toContain('Original external body'))
  expect(row.textContent).toContain('Agent replies are in the original conversation')
  expect(useAppStore.getState().sessions).toHaveLength(0)
  const originalChoice = useAppStore.getState().workbenchSpaceSelection, defaults = await f.preferences.read({ kind: 'connection', target: f.target() })
  await click('Locate Agent original-agent in Focus', row)
  expect(useAppStore.getState().focusAgentReveal).toMatchObject({ hostId: 'local', agentSessionId: 'original-agent', pending: true })
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(originalChoice)
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).source).toEqual(defaults.source)
  expect(read).toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
  expect(core.inner.kernel.input).not.toHaveBeenCalled(); expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
})

it('keeps the original history on refresh failure and discards a late response after the Profile target changes', async () => {
  seed('kept-agent'); await show(); await click('Conversations', person())
  await settle(() => expect(person().textContent).toContain('kept-agent'))
  const forward = f.chatRequests.getMockImplementation()!
  f.chatRequests.mockImplementation(async (method, input, owner) => { if (method === 'space.mote.chat.history') throw Error('Controlled history unavailable'); return forward(method, input, owner) })
  await click('Refresh conversations', person()); await settle(() => expect(person().textContent).toContain('Previously read conversations are kept'))
  expect(person().textContent).toContain('kept-agent')
  let complete!: () => Promise<void>
  f.chatRequests.mockImplementation((method, input, owner) => method === 'space.mote.chat.history' ? new Promise(resolve => { complete = async () => resolve(await forward(method, input, owner)) }) : forward(method, input, owner))
  await click('Refresh conversations', person()); await settle(() => expect(complete).toBeTypeOf('function'))
  await f.renderMotePanel(1); await settle(() => expect(panel().dataset.motePrivateChat).toBe(f.scopes[1]!.topic.id))
  await act(async () => complete())
  expect(panel().textContent).not.toContain('kept-agent')
})

it('keeps an edited draft on its original hosting owner, then adopts a new owner only with its successful configuration read', async () => {
  await show()
  const input = panel().querySelector<HTMLInputElement>('[aria-label="Conversation update interval in minutes"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '47'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  const nextOwner = { hostId: 'another-host', runtimeId: 'another-runtime' }, originalCall = f.runtime.callConnectionHost
  const targets: unknown[] = []
  f.runtime.callConnectionHost = async (owner, method, params) => { targets.push(owner); return originalCall(owner, method, params) }
  await act(async () => useAppStore.setState({ manualConnectionSelections: { lark: nextOwner } }))
  await click('Refresh'); await settle(() => expect(panel().textContent).toContain('Your draft and original requests stay with original-host'))
  expect(targets.every(owner => JSON.stringify(owner) === JSON.stringify(f.hostingTarget))).toBe(true)
  await click('Save chat settings'); await settle(() => expect(panel().textContent).toContain('Original chat settings save confirmed'))
  const config = (await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!
  await click('Refresh'); await settle(() => expect(panel().textContent).toContain('original controlled hosting owner does not match'))
  expect(input.value).toBe('47'); expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on')
  f.runtime.callConnectionHost = async (owner, method, params) => {
    if (JSON.stringify(owner) === JSON.stringify(nextOwner)) {
      if (method === 'space.mote.chat.inspect') return { configuration: { ...config, revision: 1, values: { ...config.values, enabled: false, conversationIdleMs: 60000 } }, operation: null } as never
      return originalCall(f.hostingTarget, method, params)
    }
    return originalCall(owner, method, params)
  }
  await click('Refresh'); await settle(() => expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off'))
  expect(input.value).toBe('1')
  expect(f.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.diagnose').at(-1)?.[2]).toEqual(nextOwner)
  await act(async () => useAppStore.setState({ moteChatIntents: { 'history-policy': { method: 'space.mote.chat.configure', phase: 'may-have-dispatched', hostingTarget: f.hostingTarget,
    input: { operationId: 'history-policy', target: f.target(), expectedRevision: null, expectedConnectionRevision: 1,
      values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: true, connection: { connectionId: 'private-bot', application } } } } } }))
  await click('Check original request'); await settle(() => expect(panel().textContent).toContain('Current settings are kept'))
  expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off'); expect(input.value).toBe('1')
})

it('explains a typed interrupted original Run before observer details and never calls acceptance a completed reply', async () => {
  const original = await f.client.call('space.mote.chat.diagnose', { target: f.target() })
  const forward = f.chatRequests.getMockImplementation()!
  let status: 'waiting' | 'terminal-confirmed' | 'admitted' = 'waiting'
  f.chatRequests.mockImplementation(async (method, input, owner) => method !== 'space.mote.chat.diagnose' ? forward(method, input, owner) : parseMoteChatDiagnosis({ ...original,
    incoming: { more: false, rows: [{ key: 'a'.repeat(64), state: 'claimed', code: null, codeRecorded: false, preparation: 'ready', input: {
      status, observation: 'observed', controlState: status === 'waiting' ? 'enabled' : 'dispatch-authorized', receiptObservation: status === 'waiting' ? 'rejoin-needed' : 'closed',
      waiting: status === 'waiting' ? { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin' } : null,
      preparationReason: null, failureCode: status === 'waiting' ? 'STALE_AGENT_SESSION' : null,
      runtime: status === 'waiting' ? { target: 'original', state: 'interrupted', exitCode: null } : null } }] } }, { target: f.target() }))
  await show()
  const activity = () => panel().querySelector<HTMLElement>('[aria-label="Private chat message activity"]')!
  await settle(() => expect(activity().textContent).toContain('The original conversation was interrupted'))
  expect(activity().textContent).not.toContain('observer is not attached')
  status = 'terminal-confirmed'; await click('Refresh private chat activity'); await settle(() => expect(activity().textContent).toContain('Sent to the terminal'))
  expect(activity().textContent).toContain('has not yet confirmed')
  status = 'admitted'; await click('Refresh private chat activity'); await settle(() => expect(activity().textContent).toContain('Agent received the message'))
  expect(activity().textContent).toContain('A reply is a separate result')
  expect(f.chatAgentCalls).toEqual({ prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 })
})

it('does not show an old Host allowance acknowledgement as a save on the newly selected Host', async () => {
  await show(); await click('Edit allowance', person())
  const total = person().querySelector<HTMLInputElement>('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(total, '8'); total.dispatchEvent(new Event('input', { bubbles: true })) })
  const nextOwner = { hostId: 'another-host', runtimeId: 'another-runtime' }, originalCall = f.runtime.callConnectionHost
  const configuration = (await f.client.call('space.mote.chat.inspect', { target: f.target() })).configuration!
  let release!: () => Promise<void>
  f.runtime.callConnectionHost = async (owner, method, params) => {
    if (method === 'space.mote.chat.allocate') return new Promise(resolve => { release = async () => resolve(await originalCall(owner, method, params)) })
    if (JSON.stringify(owner) === JSON.stringify(nextOwner)) {
      if (method === 'space.mote.chat.inspect') return { configuration: { ...configuration, values: { ...configuration.values, enabled: false } }, operation: null } as never
      return originalCall(f.hostingTarget, method, params)
    }
    return originalCall(owner, method, params)
  }
  await click('Save allowance', person()); await settle(() => expect(release).toBeTypeOf('function'))
  await act(async () => useAppStore.setState({ manualConnectionSelections: { lark: nextOwner } }))
  await click('Refresh'); await settle(() => expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off'))
  await act(async () => release()); await settle(() => expect(Object.values(useAppStore.getState().moteChatIntents)).toHaveLength(0))
  expect(panel().textContent).not.toContain('Message allowance saved')
  expect(panel().querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('off')
  const saved = await f.client.call('space.mote.chat.audience', { target: f.target() })
  expect(saved.people.find(row => JSON.stringify(row.actor) === JSON.stringify(alice))?.total).toBe(8)
})

it('refreshes people without unmounting a loaded second-page conversation or allowance draft', async () => {
  const people = Array.from({ length: 22 }, (_, index) => ({ ...alice, userId: 'guest-' + String(index).padStart(2, '0') }))
  for (const actor of people) history.savePerson({ key: JSON.stringify([f.target().spaceId, application.domain, application.appId, actor.idType, actor.userId]), spaceId: f.target().spaceId,
    person: { actor, name: 'Guest', creator: false, revision: 1, total: 4, used: 1, remaining: 3 } })
  const guest = people.at(-1)!; seed('second-page-agent', guest)
  await f.renderMotePanel(); await settle(() => expect(panel()?.querySelector('[data-mote-chat-saved]')?.getAttribute('data-mote-chat-saved')).toBe('on'))
  await click('People & conversations'); await settle(() => expect(panel().querySelectorAll('[data-mote-chat-person]')).toHaveLength(20))
  expect(panel().querySelector('[data-mote-chat-person="guest-21"]')).toBeNull()
  await click('More people'); await settle(() => expect(panel().querySelectorAll('[data-mote-chat-person]')).toHaveLength(24))
  const row = panel().querySelector<HTMLElement>('[data-mote-chat-person="guest-21"]')!
  await click('Conversations', row); await settle(() => expect(row.textContent).toContain('second-page-agent'))
  await click('Edit allowance', row)
  const total = row.querySelector<HTMLInputElement>('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(total, '19'); total.dispatchEvent(new Event('input', { bubbles: true })) })
  const before = f.chatRequests.mock.calls.length
  await click('Refresh people'); await settle(() => expect(f.chatRequests.mock.calls.length).toBeGreaterThan(before))
  expect(panel().querySelector('[data-mote-chat-person="guest-21"]')).toBe(row)
  expect(row.querySelector('input')).toBe(total); expect(total.value).toBe('19')
  expect(row.querySelector('details')?.open).toBe(true); expect(row.textContent).toContain('second-page-agent')
  expect(panel().querySelectorAll('[data-mote-chat-person]')).toHaveLength(24)
  expect(f.chatRequests.mock.calls.slice(before).filter(([method]) => method === 'space.mote.chat.audience')).toHaveLength(1)
  expect(f.chatRequests.mock.calls.some(([method]) => method === 'space.mote.chat.allocate')).toBe(false)
})
