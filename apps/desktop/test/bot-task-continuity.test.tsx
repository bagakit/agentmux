// @vitest-environment happy-dom
import { act } from 'react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxRpcService } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { botTaskSelectionKey } from '../src/renderer/src/lib/bot-task-selection'
import { setBotTaskSelection, useAppStore } from '../src/renderer/src/store'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { moteProfileWeb } from './fixtures/mote-profile-web'
import iconUrl from '../resources/icon-512.png'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { await f?.close() })
const route = (index = 0) => ({ section: 'lark' as const, moteLarkOrigin: { target: f.target(index), topicId: f.motes[index]!.id, moteName: f.scopes[index]!.topic.title } })
async function ready(check: () => void) { await vi.waitFor(async () => { await f.settle(); check() }, { timeout: 10_000 }) }
async function click(selector: string) {
  let button!: HTMLButtonElement
  await ready(() => { button = document.querySelector(selector)!; expect(button, selector).not.toBeNull(); expect(button.disabled).toBe(false) })
  await act(async () => button.click()); await f.settle()
}
function originalDetails() {
  return [...document.querySelectorAll('.mote-bot-setup .bot-profile-details')].find(node => node.querySelector('summary')?.textContent === 'Original setup details')
}
async function original(id: string) { await ready(() => expect(originalDetails()?.textContent).toContain(id)) }
const moteKey = (index = 0) => botTaskSelectionKey({ kind: 'mote', target: f.target(index) })
const effects = () => ({ http: f.registration.mock.calls.length, parent: f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.create' || method === 'space.mote.connection.sync' || method === 'space.mote.connection.advance').length, child: f.connectionCalls.mock.calls.filter(([method]) => method.endsWith('.begin') || method.endsWith('.advance')).length })
async function awayAndBack() {
  await click('button[data-settings-target="inapp-conversation"]')
  expect(document.querySelector('.mote-bot-setup')).toBeNull()
  expect(document.querySelector('[data-enrollment-code]')).toBeNull()
  await click('button[data-settings-target="lark"]')
}
async function failCreation() {
  const transport = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => String(url).includes('/manifest/upsert_by_template') ? new Response(null, { status: 502 }) : transport(url, input))
}
async function createFailedMote() {
  await f.renderSettings(route())
  await f.click('Create a bot for this Mote')
  await click('[data-mote-enrollment-action="confirm-account"]')
  await click('[data-mote-enrollment-action="create"]')
  const input = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as { operationId: string }
  await original(input.operationId)
  await ready(() => expect(document.querySelector('.mote-details__issue')?.textContent || document.body.textContent).toContain('not confirmed'))
  let parent = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  await vi.waitFor(async () => { parent = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!; expect(parent.enrollment?.creation?.create).toBe('unknown') }, { timeout: 5000 })
  return parent
}

it('restores the exact failed creation after real Settings navigation and presentation rehydration without replay', async () => {
  await failCreation()
  const parent = await createFailedMote(), before = effects()
  const stage = document.querySelector('[data-bot-journey-stage]')!.getAttribute('data-bot-journey-stage')
  expect(useAppStore.getState().botTaskSelections[moteKey()]).toBe(parent.operationId)
  await awayAndBack(); await original(parent.operationId)
  expect(document.querySelector('[data-bot-journey-stage]')!.getAttribute('data-bot-journey-stage')).toBe(stage)
  expect(effects()).toEqual(before)
  const key = useAppStore.persist.getOptions().name
  await ready(() => expect(JSON.parse(window.localStorage.getItem(key)!).state.botTaskSelections?.[moteKey()]).toBe(parent.operationId))
  const saved = window.localStorage.getItem(key)!
  await act(async () => useAppStore.setState({ botTaskSelections: {} }))
  window.localStorage.setItem(key, saved)
  await f.remountSettings(route()); await original(parent.operationId)
  expect(useAppStore.getState().botTaskSelections[moteKey()]).toBe(parent.operationId)
  expect((await f.cli('inspect', { operationId: parent.operationId })).operation!.enrollment!.creation!.create).toBe('unknown')
  expect(effects()).toEqual(before)
  expect(Object.values(useAppStore.getState().botTaskSelections)).toEqual([parent.operationId])
  expect(JSON.stringify(useAppStore.getState().botTaskSelections)).not.toMatch(/qrPayload|account|pngDataUrl|cookie|private-mote/iu)
}, 30_000)

it('restores the original profile update and unknown write after navigation and remount without another management action', async () => {
  await f.close()
  const native = moteProfileWeb(); f = await moteBotUi({ native })
  const input = await f.input('profile-source')
  await f.client.call('space.mote.connection.create', input); await confirmAndCreateMote(f, input.operationId)
  native.fail('/base_info/')
  await f.renderSettings(route()); await f.click('Sync Mote profile')
  await click('[data-mote-profile-action="confirm-account"]')
  await ready(() => expect(document.querySelector('[data-console-profile-progress] [aria-current="step"]')?.getAttribute('data-step')).toBe('3'))
  await ready(() => expect(document.querySelector('[data-profile-result]')?.getAttribute('data-state')).toBe('attention'))
  const parentId = (f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.sync')![1] as { operationId: string }).operationId
  const childId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task'), before = effects()
  await awayAndBack()
  await ready(() => expect(document.querySelector('[data-console-profile-task]')?.getAttribute('data-console-profile-task')).toBe(childId))
  await f.remountSettings(route())
  await ready(() => { expect(document.querySelector('[data-console-profile-task]')?.getAttribute('data-console-profile-task')).toBe(childId); expect(document.querySelector('[data-profile-result]')?.getAttribute('data-state')).toBe('attention') })
  expect(useAppStore.getState().botTaskSelections[moteKey()]).toBe(parentId)
  expect(effects()).toEqual(before)
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(native.submitted).toBe(false)
}, 30_000)

it('directly restores the selected older ID outside the history page despite unavailable current source and capabilities', async () => {
  const input = await f.input('selected-original')
  await f.client.call('space.mote.connection.create', input)
  await f.renderSettings(route()); await f.click('Previous bot operations')
  await click('[data-mote-bot-operation="selected-original"]'); await original(input.operationId)
  for (let index = 0; index < 26; index++) await f.client.call('space.mote.connection.create', { ...input, operationId: 'newer-original-' + index })
  expect((await f.cli('ls', { target: f.target(), limit: 25 })).operations.some(item => item.operationId === input.operationId)).toBe(false)
  vi.spyOn(api.files, 'readPublic').mockRejectedValue(new Error('Controlled current source unavailable'))
  const read = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, value) => { if (method === 'connection.enrollment.ls') throw new Error('Controlled creation capability unavailable'); return read(method, value) })
  const handler = f.handlers.get('moteConnections:call')!
  let arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.handlers.set('moteConnections:call', async (event, method, value) => { const result = await handler(event, method, value); if (method === 'space.mote.connection.inspect' && value.operationId === input.operationId) { arrive(); await held } return result })
  const before = effects()
  try {
    await f.remountSettings(route()); await arrived
    expect(document.querySelector('[data-bot-task-reading]')?.textContent).toContain('Reading the original saved result')
    expect(document.querySelector('[data-bot-task-reading] svg')).not.toBeNull()
    expect(document.querySelector('.mote-bot-task__content')?.textContent).toContain(input.operationId)
    expect(document.querySelector('.mote-bot-task__content')?.textContent).not.toContain('could not be read')
    expect(document.querySelector('[data-mote-bot-code]')).toBeNull()
    expect(effects()).toEqual(before)
  } finally { await act(async () => release()) }
  await original(input.operationId)
  await ready(() => expect(document.querySelector('[data-mote-bot-code] svg')).not.toBeNull())
  expect(f.parentCalls.mock.calls.some(([method, value]) => method === 'space.mote.connection.inspect' && (value as { operationId?: string }).operationId === input.operationId)).toBe(true)
  expect(useAppStore.getState().botTaskSelections[moteKey()]).toBe(input.operationId)
  expect(effects()).toEqual(before)
}, 45_000)

it('keeps a retained unadmitted input selected after remount and checks its original ID without sending it again', async () => {
  f.parentCalls.mockImplementation(async (method, input) => { if (method === 'space.mote.connection.create') throw new Error('Controlled failure before admission'); return f.forward(method, input) })
  await f.renderSettings(route()); await f.click('Create a bot for this Mote')
  await ready(() => expect(document.body.textContent).toContain('Controlled failure before admission'))
  const id = (f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as { operationId: string }).operationId
  expect((await f.client.call('space.mote.connection.inspect', { operationId: id })).operation).toBeNull()
  const before = effects()
  await f.remountSettings(route())
  await ready(() => expect(document.querySelector('.mote-bot-task__content')?.textContent).toContain('The result is not confirmed. Your original request is retained.'))
  expect(useAppStore.getState().botTaskSelections[moteKey()]).toBe(id)
  expect(document.querySelector('[data-mote-bot-create]')).toBeNull()
  expect(document.body.textContent).not.toContain('Controlled failure before admission')
  await f.click('Check original result')
  await ready(() => expect(document.body.textContent).toContain('No recorded result was found'))
  expect(effects()).toEqual(before)
}, 30_000)

it('keeps an unknown locator visible when neither an admitted parent nor retained input is available', async () => {
  setBotTaskSelection({ kind: 'mote', target: f.target() }, 'unavailable-original')
  await f.renderSettings(route())
  await ready(() => { expect(document.querySelector('.mote-bot-task__content')?.textContent).toContain('unavailable-original'); expect(document.body.textContent).toContain('Its identifier is kept; no new setup was started.') })
  expect(document.querySelector('[data-mote-bot-create]')).toBeNull()
  const before = effects()
  await f.click('Check original result')
  await ready(() => expect(document.body.textContent).toContain('No recorded result was found'))
  expect(effects()).toEqual(before)
  await f.click('Back to bot profile')
  await ready(() => expect(document.querySelector('[data-mote-bot-create]')).not.toBeNull())
  expect(useAppStore.getState().botTaskSelections[moteKey()]).toBeUndefined()
}, 30_000)

it('does not read a different Mote private child from an incorrect presentation locator', async () => {
  const input = await f.input('other-mote-original', 1), parent = await f.client.call('space.mote.connection.create', input)
  setBotTaskSelection({ kind: 'mote', target: f.target() }, input.operationId)
  const before = effects()
  await f.renderSettings(route())
  await ready(() => expect(document.body.textContent).toContain('This original request belongs to another Mote'))
  expect(document.querySelector('[data-mote-bot-code]')).toBeNull()
  expect(f.connectionCalls.mock.calls.some(([method, value]) => method === 'connection.enrollment.inspect' && (value as { operationId?: string }).operationId === parent.enrollmentOperationId)).toBe(false)
  setBotTaskSelection({ kind: 'mote', target: f.target(1) }, input.operationId)
  await f.renderSettings(route(1)); await original(input.operationId)
  await ready(() => expect(document.querySelector('[data-mote-bot-code] svg')).not.toBeNull())
  expect(effects()).toEqual(before)
}, 30_000)

it('keeps the original safe locator when the private child belongs to a different actor', async () => {
  const service = new AgentMuxRpcService({ moteConnections: f.parent, connections: f.connections.connections })
  const input = await f.input('other-actor-original'), parent = await service.call('space.mote.connection.create', input, { principal: { kind: 'device', id: 'other-device' } })
  await expect(f.client.call('connection.enrollment.inspect', { operationId: parent.enrollmentOperationId! })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  setBotTaskSelection({ kind: 'mote', target: f.target() }, input.operationId)
  const handler = f.handlers.get('connections:call')!
  let arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.handlers.set('connections:call', async (event, method, value) => {
    try { return await handler(event, method, value) }
    catch (error) { if (method === 'connection.enrollment.inspect' && value.operationId === parent.enrollmentOperationId) { arrive(); await held } throw error }
  })
  const before = effects()
  try {
    await f.renderSettings(route()); await arrived
    expect(document.querySelector('[data-bot-task-reading] svg')).not.toBeNull()
    expect(document.querySelector('.mote-details__issue')).toBeNull()
    expect(document.querySelector('[data-mote-bot-code]')).toBeNull()
  } finally { await act(async () => release()) }
  await original(input.operationId)
  await ready(() => expect(document.querySelector('.mote-details__issue')).not.toBeNull())
  expect(document.querySelector('[data-mote-bot-code]')).toBeNull()
  expect(document.querySelector('.mote-bot-auth-actions button')).toBeNull()
  expect(document.body.textContent).not.toContain('Original account')
  expect(useAppStore.getState().botTaskSelections[moteKey()]).toBe(input.operationId)
  expect(effects()).toEqual(before)
}, 30_000)

it('ignores a late original Mote read after Settings moves to another exact target', async () => {
  const a = await f.input('selected-mote-a'), b = await f.input('selected-mote-b', 1)
  await f.client.call('space.mote.connection.create', a); await f.client.call('space.mote.connection.create', b)
  setBotTaskSelection({ kind: 'mote', target: f.target() }, a.operationId); setBotTaskSelection({ kind: 'mote', target: f.target(1) }, b.operationId)
  const handler = f.handlers.get('moteConnections:call')!
  let arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.handlers.set('moteConnections:call', async (event, method, input) => { const value = await handler(event, method, input); if (method === 'space.mote.connection.inspect' && input.operationId === a.operationId) { arrive(); await held } return value })
  const before = effects()
  try {
    await f.renderSettings(route()); await arrived
    await f.renderSettings(route(1)); await original(b.operationId)
  } finally { await act(async () => release()) }
  await f.settle()
  expect(originalDetails()?.textContent).toContain(b.operationId)
  expect(originalDetails()?.textContent).not.toContain(a.operationId)
  expect(useAppStore.getState().botTaskSelections[moteKey(1)]).toBe(b.operationId)
  expect(effects()).toEqual(before)
}, 30_000)

it('restores the selected general enrollment through actual Settings navigation and remount using only original reads', async () => {
  const transport = f.registration.getMockImplementation()!, asset = await readFile(resolve('apps/desktop/resources/icon-512.png'))
  f.registration.mockImplementation(async (url, input) => String(url) === iconUrl ? new Response(new Uint8Array(asset)) : String(url).includes('/manifest/upsert_by_template') ? new Response(null, { status: 502 }) : transport(url, input))
  await f.renderSettings(); await f.click('Create a general identity'); await click('[data-enrollment-create]')
  await click('[data-enrollment-action="confirm-account"]'); await click('[data-enrollment-action="create"]')
  await ready(() => expect(document.querySelector('.connector-editor-title')?.textContent).toBe('Bot creation is not confirmed'))
  const id = document.querySelector('[data-enrollment-operation]')!.getAttribute('data-enrollment-operation')!
  const original = (await f.client.call('connection.enrollment.inspect', { operationId: id })).operation!
  expect(original.creation?.create).toBe('unknown')
  const before = effects()
  await awayAndBack()
  await ready(() => { expect(document.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(id); expect(document.querySelector('.connector-editor-title')?.textContent).toBe('Bot creation is not confirmed') })
  await f.remountSettings()
  await ready(() => { expect(document.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(id); expect(document.querySelector('.connector-editor-title')?.textContent).toBe('Bot creation is not confirmed') })
  expect(useAppStore.getState().botTaskSelections.enrollment).toBe(id)
  expect(effects()).toEqual(before)
}, 30_000)

it('keeps a general enrollment locator whose original result cannot be read out of the new creation form', async () => {
  setBotTaskSelection({ kind: 'enrollment' }, 'unavailable-general-original')
  const handler = f.handlers.get('connections:call')!
  let arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.handlers.set('connections:call', async (event, method, value) => { const result = await handler(event, method, value); if (method === 'connection.enrollment.inspect' && value.operationId === 'unavailable-general-original') { arrive(); await held } return result })
  try {
    await f.renderSettings(); await arrived
    expect(document.querySelector('[data-bot-task-reading] svg')).not.toBeNull()
    expect(document.querySelector('[data-enrollment-unavailable]')?.textContent).not.toContain('could not be read')
    expect(document.querySelector('[data-enrollment-create]')).toBeNull()
  } finally { await act(async () => release()) }
  await ready(() => expect(document.querySelector('[data-enrollment-unavailable]')?.textContent).toContain('unavailable-general-original'))
  await ready(() => expect(document.querySelector('[data-enrollment-unavailable]')?.textContent).toContain('could not be read'))
  expect(document.querySelector('[data-enrollment-create]')).toBeNull()
  const before = effects()
  await f.click('Read stored result')
  await ready(() => expect(document.querySelector('[data-enrollment-unavailable]')?.textContent).toContain('could not be read'))
  expect(effects()).toEqual(before)
  await f.click('All bot setups')
  await ready(() => expect(document.querySelector('[aria-label="New bot name"]')).not.toBeNull())
  expect(useAppStore.getState().botTaskSelections.enrollment).toBeUndefined()
}, 30_000)

it('reads fresh permitted general account actions again after departure instead of retaining a private UI view', async () => {
  const transport = f.registration.getMockImplementation()!, asset = await readFile(resolve('apps/desktop/resources/icon-512.png'))
  f.registration.mockImplementation(async (url, input) => String(url) === iconUrl ? new Response(new Uint8Array(asset)) : transport(url, input))
  await f.renderSettings(); await f.click('Create a general identity'); await click('[data-enrollment-create]')
  await ready(() => expect(document.querySelector('[data-enrollment-action="confirm-account"]')).not.toBeNull())
  const id = document.querySelector('[data-enrollment-operation]')!.getAttribute('data-enrollment-operation')!, before = effects()
  await awayAndBack()
  await ready(() => { expect(document.querySelector('[data-enrollment-action="confirm-account"]')).not.toBeNull(); expect(document.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(id) })
  await f.remountSettings()
  await ready(() => { expect(document.querySelector('[data-enrollment-action="confirm-account"]')).not.toBeNull(); expect(document.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(id) })
  expect(effects()).toEqual(before)
  expect(f.connectionCalls.mock.calls.filter(([method, input]) => method === 'connection.enrollment.inspect' && (input as { operationId?: string }).operationId === id).length).toBeGreaterThan(1)
}, 30_000)
