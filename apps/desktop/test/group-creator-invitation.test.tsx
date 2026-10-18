// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { useAppStore } from '../src/renderer/src/store'
import type { RoomCreateInput, RoomProvisioningOperation } from '@agentmux/core/connections'

let appResponse: unknown, holdCreator: Promise<void> | null, memberUnknown: boolean, alternateApp: string | null, creationUnknown: boolean
const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'native-bot', app_name: 'The selected bot' } }
  if (request.url?.includes('/application/v6/applications/')) {
    if (alternateApp && request.url.endsWith('/' + alternateApp)) return { code: 0, data: { app: { app_id: alternateApp, creator_id: 'alternate-creator' } } }
    if (holdCreator) await holdCreator; return appResponse
  }
  if (request.url?.endsWith('/chats') && request.method?.toUpperCase() === 'POST') { if (creationUnknown) throw Error('Controlled unknown creation'); return { code: 0, data: { chat_id: 'oc_' + request.params!.uuid } } }
  if (request.url?.endsWith('/members') && request.method?.toUpperCase() === 'POST') {
    if (memberUnknown) throw Error('Controlled unknown member response')
    return { code: 0, data: {} }
  }
  if (request.url?.endsWith('/members') || request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Created group', chat_status: 'normal', chat_mode: 'group' } }
} })
beforeEach(() => { appResponse = { code: 0, data: { app: { app_id: f.config.application.appId, creator_id: 'creator-open-id' } } }; holdCreator = null; memberUnknown = false; alternateApp = null; creationUnknown = false })
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const choice = () => dialog().querySelector<HTMLInputElement>('[aria-label="Invite this bot’s creator"]')
const createButton = () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Create group')!
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
async function open() { await f.mount(); await f.journey('create') }
const requests = () => f.calls.filter(call => call.method === 'connection.room.create')
const memberRequests = () => f.platformCalls.filter(call => call.url?.endsWith('/members') && call.method?.toUpperCase() === 'POST')
async function created() { await ready(() => expect(requests().at(-1)?.result).toMatchObject({ creation: { state: 'created' } })) }

it('deduplicates the exact native creator in the frozen public create intent and retains its original membership receipt', async () => {
  await open(); await ready(() => expect(choice()?.checked).toBe(true)); await ready(() => expect(createButton().disabled).toBe(false))
  await f.fill('Member ID type', 'open_id'); await f.fill('Invite member IDs', 'creator-open-id\nother-open-id')
  await f.button('Create group'); await created()
  const input = requests()[0]!.input as RoomCreateInput, operation = requests()[0]!.result as RoomProvisioningOperation
  expect(input.members).toEqual([{ idType: 'open_id', userId: 'creator-open-id' }, { idType: 'open_id', userId: 'other-open-id' }])
  expect(memberRequests()).toHaveLength(1)
  expect(memberRequests()[0]).toMatchObject({ params: { member_id_type: 'open_id' }, data: { id_list: ['creator-open-id', 'other-open-id'] } })
  expect(operation.membership).toMatchObject({ state: 'settled', results: input.members.map(member => ({ member, state: 'joined' })) })
  expect((await f.cli(['room', 'inspect', '--operation-id', input.operationId])).operation).toEqual(operation)
  expect(f.calls.filter(call => ['connection.bind', 'connection.grant'].includes(call.method))).toEqual([])
  await f.button('Close'); await f.journey('create'); await ready(() => expect(dialog().textContent).toContain('2 of 2 invitations confirmed'))
  expect(useAppStore.getState().connectorRoomIntents[input.operationId]!.input).toEqual(input)
  expect(requests()).toHaveLength(1); expect(memberRequests()).toHaveLength(1)
}, 30000)

it('an explicit opt-out creates without inviting the confirmed creator', async () => {
  await open(); await ready(() => expect(choice()?.checked).toBe(true)); await ready(() => expect(createButton().disabled).toBe(false))
  await act(async () => choice()!.click()); expect(choice()!.checked).toBe(false)
  await f.button('Create group'); await created()
  expect((requests()[0]!.input as RoomCreateInput).members).toEqual([]); expect(memberRequests()).toEqual([])
}, 25000)

it('pending default invitation waits for identity, while explicit opt-out freezes an empty intent before a late creator response', async () => {
  let release!: () => void; holdCreator = new Promise<void>(resolve => { release = resolve })
  try {
    await open(); await ready(() => expect(dialog().textContent).toContain('Checking this bot’s creator'))
    expect(choice()!.checked).toBe(true); expect(createButton().disabled).toBe(true)
    await act(async () => choice()!.click()); expect(createButton().disabled).toBe(false)
    await f.button('Create group'); await created()
    const input = requests()[0]!.input as RoomCreateInput
    expect(input.members).toEqual([])
    await act(async () => { release(); await Promise.resolve() })
    await ready(() => expect(f.calls.some(call => call.method === 'connection.profile.get' && call.result)).toBe(true))
    expect(useAppStore.getState().connectorRoomIntents[input.operationId]!.input).toEqual(input)
    expect(memberRequests()).toEqual([])
  } finally { release() }
}, 25000)

it.each(['missing-permission', 'foreign-application', 'missing-creator'] as const)('unavailable creator %s stays explicit without blocking ordinary group creation', async unavailable => {
  appResponse = unavailable === 'missing-permission' ? { code: 210508 } : { code: 0, data: { app: { app_id: unavailable === 'foreign-application' ? 'another-application' : f.config.application.appId, ...(unavailable === 'foreign-application' ? { creator_id: 'foreign-person' } : {}) } } }
  await open(); await ready(() => expect(dialog().textContent).toContain('No creator invitation will be sent'))
  expect(choice()).toBeNull(); expect(createButton().disabled).toBe(false)
  if (unavailable === 'missing-permission') expect([...dialog().querySelectorAll('button')].some(button => button.textContent === 'Review bot permissions')).toBe(true)
  await f.button('Create group'); await created()
  expect((requests()[0]!.input as RoomCreateInput).members).toEqual([]); expect(memberRequests()).toEqual([])
}, 25000)

it('an unknown invitation retains the created group and original member outcome without replay or Agent grants', async () => {
  memberUnknown = true; await open(); await ready(() => expect(createButton().disabled).toBe(false))
  await f.button('Create group'); await created()
  const request = requests()[0]!, input = request.input as RoomCreateInput
  expect(request.result).toMatchObject({ creation: { state: 'created' }, membership: { state: 'settled', results: [{ member: { idType: 'open_id', userId: 'creator-open-id' }, state: 'unknown' }] } })
  expect(dialog().textContent).toContain('0 of 1 invitations confirmed')
  await f.button('Close'); await f.journey('create'); await ready(() => expect(dialog().textContent).toContain('0 of 1 invitations confirmed'))
  await f.button('Check status'); await ready(() => expect(dialog().textContent).toContain('0 of 1 invitations confirmed'))
  expect((await f.cli(['room', 'inspect', '--operation-id', input.operationId])).operation).toEqual(request.result)
  expect(memberRequests()).toHaveLength(1); expect(requests()).toHaveLength(1)
  expect(f.calls.filter(call => ['connection.bind', 'connection.grant'].includes(call.method))).toEqual([])
}, 25000)


it('changing the selected application cannot use a late creator from the previous bot', async () => {
  let release!: () => void; holdCreator = new Promise<void>(resolve => { release = resolve })
  alternateApp = 'cli_alternate_creator'
  try {
    const original = (await f.services.connections.inspect({ connectionId: f.config.connectionId })).connection!
    await f.forward('connection.configure', { operationId: 'alternate-creator-save', expectedRevision: null,
      connection: { ...original.config, connectionId: 'alternate-creator-connection', application: { ...original.config.application, appId: alternateApp }, label: 'Alternate bot' } })
    await f.mount()
    const more = document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] .agent-region-header__more')!
    await act(async () => { more.focus(); more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await ready(() => expect([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.trim() === 'Connect group…')).toBe(true))
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Connect group…')!.click())
    await ready(() => expect(dialog()?.querySelector('[aria-label="Group application"]')).not.toBeNull())
    const trigger = dialog().querySelector<HTMLElement>('[aria-label="Group application"]')!
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await ready(() => expect(document.querySelector('[role="menuitemradio"][data-value="' + f.config.connectionId + '"]')).not.toBeNull())
    await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="' + f.config.connectionId + '"]')!.click())
    await act(async () => dialog().querySelector<HTMLElement>('[aria-label="New group"]')!.click())
    await ready(() => expect(dialog().textContent).toContain('Checking this bot’s creator'))
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await ready(() => expect(document.querySelector('[role="menuitemradio"][data-value="alternate-creator-connection"]')).not.toBeNull())
    await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="alternate-creator-connection"]')!.click())
    await ready(() => expect(dialog().textContent).toContain('alternate-creator'))
    await act(async () => { release(); await Promise.resolve() })
    await ready(() => expect(f.calls.filter(call => call.method === 'connection.profile.get' && call.result)).toHaveLength(2))
    expect(dialog().textContent).not.toContain('creator-open-id')
    await f.button('Create group'); await created()
    expect(requests()[0]!.input).toMatchObject({ connectionId: 'alternate-creator-connection', members: [{ idType: 'open_id', userId: 'alternate-creator' }] })
  } finally { release() }
}, 25000)


it('an unknown original create displays each frozen invitee with its own ID namespace', async () => {
  creationUnknown = true; await open(); await ready(() => expect(createButton().disabled).toBe(false))
  await f.fill('Member ID type', 'union_id'); await f.fill('Invite member IDs', 'manual-union-id')
  await f.button('Create group'); await ready(() => expect(dialog().textContent).toContain('Creation not confirmed'))
  const input = requests()[0]!.input as RoomCreateInput
  expect(input.members).toEqual([{ idType: 'open_id', userId: 'creator-open-id' }, { idType: 'union_id', userId: 'manual-union-id' }])
  const form = dialog().querySelector('[aria-label="New dedicated group"]')!
  expect(form.textContent).toContain('open_id · creator-open-id'); expect(form.textContent).toContain('union_id · manual-union-id')
  expect(form.querySelector('[aria-label="Member ID type"]')).toBeNull()
  expect(memberRequests()).toEqual([])
}, 25000)
