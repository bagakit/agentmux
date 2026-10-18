// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { ConnectionRecord, RoomCreateInput, RoomProvisioningOperation } from '@agentmux/core/connections'

let loseFirstCreation = false, creations = 0
const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/chats') && request.method?.toUpperCase() === 'POST') {
    if (++creations === 1 && loseFirstCreation) throw new Error('Controlled lost original group response')
    return { code: 0, data: { chat_id: 'oc_' + request.params!.uuid } }
  }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Same group name', chat_status: 'normal', chat_mode: 'group' } }
} })
beforeEach(() => { loseFirstCreation = false; creations = 0 })
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const writes = () => f.calls.filter(call => ['connection.room.create', 'connection.bind', 'connection.binding.relink', 'connection.grant'].includes(call.method))
async function openChoice(regionId = 'original-region') {
  const trigger = document.querySelector<HTMLElement>('[data-workbench-region-id="' + regionId + '"] .agent-region-header__more')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  let item: HTMLElement | undefined
  await ready(() => { item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Connect group…'); expect(item).toBeDefined() })
  await act(async () => item!.click())
  await ready(() => expect(dialog()).not.toBeNull())
  await ready(() => expect(f.calls.some(call => call.method === 'connection.ls' && call.result)).toBe(true))
}
async function openBotOptions() {
  const trigger = dialog().querySelector<HTMLElement>('[aria-label="Group application"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await ready(() => expect(document.querySelector('[role="menuitemradio"][data-value=""]')).not.toBeNull())
}
async function pickBot(id: string) {
  await openBotOptions()
  const option = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="' + id + '"]')!
  expect(option).not.toBeNull(); expect(option.getAttribute('aria-disabled')).not.toBe('true')
  await act(async () => option.click())
}
async function newGroup() { await act(async () => dialog().querySelector<HTMLButtonElement>('[aria-label="New group"]')!.click()) }
async function share() {
  await ready(() => expect(dialog().getAttribute('aria-busy')).toBe('false'))
  await act(async () => dialog().querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await ready(() => expect(dialog().textContent).toContain('Group saved'))
}
async function configure(connectionId: string, change: Partial<ConnectionRecord['config']>) {
  const record = (await f.services.connections.inspect({ connectionId })).connection
  const base = record?.config ?? (await f.services.connections.inspect({ connectionId: f.config.connectionId })).connection!.config
  return await f.forward('connection.configure', { operationId: 'configure-' + connectionId + '-' + (record?.revision ?? 'new'), expectedRevision: record?.revision ?? null,
    connection: { ...base, ...change, connectionId } })
}
async function distinctSessions() {
  const current = (await f.original.store.readMetadata('original-agent'))!
  const transcript = join(f.original.root, 'independent.jsonl')
  await writeFile(transcript, (await readFile(f.original.transcript, 'utf8')).replaceAll('original-native', 'independent-native'))
  const next = { ...f.original.session, agentSessionId: 'independent-agent', run: { runId: 'independent-ended-run' }, nativeHandle: { ...f.original.session.nativeHandle!, kind: 'provider' as const, providerId: 'claude', sessionId: 'independent-native', transcriptPath: transcript } }
  await f.original.store.compareAndSwap(null, next)
  await f.original.change(graph => { graph.regions.find(region => region.regionId === 'other-region')!.agentSessionId = next.agentSessionId })
  const state = useAppStore.getState(), tab = state.tabs['ui-tab']!
  useAppStore.setState({ sessions: [...state.sessions, { ...composerSession(next.agentSessionId, 'claude'), label: f.session.label, workspacePath: f.original.root, nativeHandle: next.nativeHandle }],
    tabs: { ...state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions, 'other-region': { ...tab.regions['other-region']!, kind: 'agent', sessionId: next.agentSessionId } } } },
    agentComposerDrafts: { ...state.agentComposerDrafts, [next.agentSessionId]: 'Independent original draft' } })
  return { current, next }
}

it('two distinct same-name Sessions create separate native groups with the same bot and reopen their exact bindings', async () => {
  const original = await distinctSessions(); await f.mount()
  const results: RoomProvisioningOperation[] = []
  for (const regionId of ['original-region', 'other-region']) {
    await f.journey('create', regionId); await f.fill('Group name', 'Same group name'); await f.button('Create group')
    await ready(() => expect(dialog().textContent).toContain('Your group is selected'))
    const created = f.calls.filter(call => call.method === 'connection.room.create').at(-1)!
    results.push(created.result as RoomProvisioningOperation)
    await share(); await f.button('Close')
  }
  expect(results.map(result => result.input.agentSessionId)).toEqual(['original-agent', 'independent-agent'])
  expect(new Set(results.map(result => result.operationId)).size).toBe(2)
  expect(new Set(results.map(result => 'attemptId' in result.creation && result.creation.attemptId)).size).toBe(2)
  const nativeCreates = f.platformCalls.filter(call => call.url?.endsWith('/chats') && call.method?.toUpperCase() === 'POST')
  expect(nativeCreates).toHaveLength(2)
  for (const [index, result] of results.entries()) {
    expect(result.creation.state).toBe('created'); if (result.creation.state !== 'created') throw Error('Expected confirmed original create')
    expect(nativeCreates[index]!.params!.uuid).toBe(result.creation.attemptId)
    const listed = await f.cli(['binding', 'ls', '--host', 'local', '--session', result.input.agentSessionId])
    expect(listed.bindings).toHaveLength(1)
    expect(listed.bindings[0]).toMatchObject({ agentSessionId: result.input.agentSessionId, externalConversationId: result.creation.externalConversationId })
    await f.journey('details', index ? 'other-region' : 'original-region')
    await ready(() => expect(dialog().querySelector('.agent-connector-group-identity small')?.getAttribute('title')).toBe(result.creation.state === 'created' ? result.creation.externalConversationId : ''))
    expect(dialog().querySelector('.agent-connector-group-identity small')?.textContent).toContain('Group · ')
    expect(dialog().textContent).toContain('Session · ' + result.input.agentSessionId)
    await f.button('Close')
  }
  expect((await f.original.store.readMetadata('original-agent'))).toEqual(original.current)
  expect((await f.original.store.readMetadata('independent-agent'))).toEqual(original.next)
  expect(useAppStore.getState().agentComposerDrafts).toMatchObject({ 'original-agent': 'Keep the original draft 中', 'independent-agent': 'Independent original draft' })
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(2)
}, 30_000)

it('an unknown creation on one Session cannot occupy another Session with the same bot and name', async () => {
  await distinctSessions(); loseFirstCreation = true; await f.mount()
  await f.journey('create'); await f.button('Create group'); await ready(() => expect(dialog().textContent).toContain('Creation not confirmed'))
  const original = Object.values(useAppStore.getState().connectorRoomIntents)[0]!
  expect(original.method).toBe('connection.room.create')
  await f.button('Close'); await f.journey('create', 'other-region')
  expect(dialog().textContent).not.toContain('Creation not confirmed')
  expect(dialog().textContent).not.toContain(original.input.operationId)
  await f.button('Create group'); await ready(() => expect(dialog().textContent).toContain('Your group is selected')); await share()
  expect(f.calls.filter(call => call.method === 'connection.room.create').map(call => (call.input as RoomCreateInput).agentSessionId)).toEqual(['original-agent', 'independent-agent'])
  expect(useAppStore.getState().connectorRoomIntents[original.input.operationId]).toEqual(original)
  await f.button('Close'); await f.journey('details'); await ready(() => expect(dialog().textContent).toContain('Creation not confirmed'))
  await f.button('Check status'); await ready(() => expect(dialog().textContent).toContain('Creation not confirmed'))
  expect(creations).toBe(2)
  expect((await f.cli(['binding', 'ls', '--host', 'local', '--session', 'original-agent'])).bindings).toEqual([])
  expect((await f.cli(['binding', 'ls', '--host', 'local', '--session', 'independent-agent'])).bindings).toHaveLength(1)
}, 30_000)

it('fresh same-name choices exclude a disabled bot and visibly identify duplicate application connections', async () => {
  await configure('same-application-alternative', { label: f.config.label })
  await configure('other-application', { label: f.config.label, application: { ...f.config.application, appId: 'cli_fedcba9876543210' } })
  await configure('disabled-application', { label: 'Disabled bot', enabled: false })
  await f.mount(); await openChoice(); await openBotOptions()
  expect(document.querySelector('[role="menuitemradio"][data-value="disabled-application"]')).toBeNull()
  const first = document.querySelector('[role="menuitemradio"][data-value="' + f.config.connectionId + '"]')!, second = document.querySelector('[role="menuitemradio"][data-value="same-application-alternative"]')!
  expect(first.textContent).not.toBe(second.textContent)
  expect(first.textContent).toContain('Connection'); expect(second.textContent).toContain('Connection')
  await act(async () => (second as HTMLElement).click())
  const identity = dialog().querySelector('.agent-connector-source__identity')!
  expect(identity.textContent).toContain('Connection')
  expect(identity.querySelector('small')?.getAttribute('title')).toContain('same-application-alternative')
  expect(identity.querySelector('small')?.getAttribute('title')).toContain(f.config.application.appId)
  expect(writes()).toEqual([])
  await newGroup(); await f.button('Create group'); await ready(() => expect(dialog().textContent).toContain('Your group is selected'))
  expect((f.calls.find(call => call.method === 'connection.room.create')!.input as RoomCreateInput).connectionId).toBe('same-application-alternative')
}, 25_000)

it('a confirmed disable after selection prevents a new create while retaining the form and settings recovery', async () => {
  let unavailable = false
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    if (unavailable && method === 'connection.binding.ls') throw Error('Controlled binding observation unavailable')
    return f.forward(method, input)
  })
  await f.mount(); unavailable = true; await openChoice()
  await ready(() => expect(dialog().textContent).toContain('Controlled binding observation unavailable'))
  await pickBot(f.config.connectionId); await newGroup(); await f.fill('Group name', 'Keep this original group draft')
  await configure(f.config.connectionId, { enabled: false }); unavailable = false
  await f.button('Refresh'); await ready(() => expect(dialog().textContent).toContain('This bot is disabled'))
  const create = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Create group')!
  expect(create.disabled).toBe(true); await act(async () => create.click())
  expect(writes()).toEqual([])
  expect(dialog().querySelector<HTMLInputElement>('[aria-label="Group name"]')?.value).toBe('Keep this original group draft')
  await f.button('Open bot settings')
  expect(f.settings).toHaveBeenLastCalledWith({ sessionId: 'original-agent', hostId: 'local', agentSessionId: 'original-agent', connectionId: f.config.connectionId })
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
}, 25_000)

it('a bot disabled after the form snapshot is rejected by its original owner with a clear unsent result', async () => {
  await f.mount(); await f.journey('create'); await configure(f.config.connectionId, { enabled: false })
  await f.button('Create group')
  await ready(() => expect(dialog().textContent).toContain('No group was created'))
  const submitted = f.calls.find(call => call.method === 'connection.room.create')!
  expect(submitted.result).toMatchObject({ creation: { state: 'not-applied', reason: 'connection-unavailable' } })
  expect(creations).toBe(0)
  expect(useAppStore.getState().connectorRoomIntents[(submitted.input as RoomCreateInput).operationId]).toBeDefined()
  await f.button('Check status'); await ready(() => expect(dialog().textContent).toContain('Group not created'))
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1)
  await f.button('Open bot settings')
  expect(f.settings.mock.calls.at(-1)?.[0]).toMatchObject({ connectionId: f.config.connectionId })
}, 25_000)
