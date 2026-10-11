// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => {
  f = await moteBotUi()
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => f.topics.list(f.workspace))
  await act(async () => { await useAppStore.getState().refreshScratchTopics(f.workspace.id, true) })
})
afterEach(async () => { await f?.close() })
const card = () => document.querySelector<HTMLElement>(`[data-mote-identity="${f.scopes[0]!.topic.id}"]`)!
async function ready(selector: string) {
  await vi.waitFor(async () => { await f.settle(); expect(document.querySelector(selector), selector + '\n' + document.body.textContent).not.toBeNull() }, { timeout: 8000 })
}
async function click(selector: string) {
  await ready(selector)
  await act(async () => {
    const node = document.querySelector<HTMLButtonElement>(selector)!
    expect(node.disabled).not.toBe(true)
    node.click()
  })
}
async function library() { await f.render(0, true); await ready('[data-mote-card-action="create"]') }
async function create() {
  await library(); await act(async () => card().querySelector<HTMLButtonElement>('[data-mote-card-action="create"]')!.click())
  await vi.waitFor(() => expect(f.beginCount).toBe(1), { timeout: 3500 })
  await ready('[data-mote-enrollment-action="confirm-account"]')
  expect(f.creationCount).toBe(0)
  await f.click('Confirm this account'); expect(f.creationCount).toBe(0)
  await f.click('Create this bot')
  await vi.waitFor(async () => { await f.settle(); expect(document.body.textContent).toContain('Original save confirmed') }, { timeout: 8000 })
  await f.click('Back to bot profile'); await ready('[data-mote-identity-unbind]')
}

it('opens the identity library and the original Mote detail without accessing the vault; the global plus creates a general identity', async () => {
  const secure = vi.spyOn(DesktopConnectorSecrets.prototype, 'assertAvailable')
  await library()
  expect(card().dataset.identityState).toBe('unbound')
  expect(card().textContent).toContain('Saved public name')
  expect(f.parentCalls.mock.calls.some(([method]) => method === 'space.mote.connection.create')).toBe(false)
  expect(secure).not.toHaveBeenCalled()
  await act(async () => card().querySelector<HTMLButtonElement>('.connector-mote-card__identity')!.click())
  await ready('[data-mote-identity-panel]')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await vi.waitFor(async () => { await f.settle(); expect(document.body.textContent).toContain('Saved public name') })
  expect(f.beginCount).toBe(0); expect(secure).not.toHaveBeenCalled()
  await f.click('All identities'); await click('[data-enrollment-new]')
  expect(document.body.textContent).toContain('New general identity')
  expect(document.querySelector('[data-mote-identity-panel]')).toBeNull()
  expect(f.parentCalls.mock.calls.some(([method]) => method === 'space.mote.connection.create')).toBe(false)
  expect(secure).not.toHaveBeenCalled()
})

it('one contextual action creates with the exact saved Mote name and avatar, then unbinds only its default through the original writer', async () => {
  await create()
  const input = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
  expect(input.source.target).toEqual(f.target()); expect(input.avatar).toBe('include-saved')
  const operation = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  expect(operation.snapshot.name).toBe('Saved public name'); expect(operation.snapshot.avatarSha256).toMatch(/^[a-f0-9]{64}$/)
  await f.click('Manage bot application'); await f.click('Back to Mote identity'); await ready('[data-mote-identity-unbind]')
  await f.settle(); expect(f.beginCount).toBe(1)
  const before = (await f.client.call('connection.ls', {})).connections
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection).toEqual(operation.connection)
  await click('[data-mote-identity-unbind]')
  await vi.waitFor(async () => expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection).toBeNull())
  expect(f.saves.mock.calls.at(-1)![0].values).toEqual({ connection: null })
  expect((await f.client.call('connection.ls', {})).connections).toEqual(before)
  await f.click('All identities'); await ready('[data-mote-card-action="create"]')
  expect(card().dataset.identityState).toBe('unbound'); expect(f.creationCount).toBe(1)
})

it('a replacement keeps the old identity until the same new application is saved, without deleting the old application', async () => {
  await create()
  const old = (await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection!
  await f.click('Create a replacement identity'); await f.click('Prepare replacement')
  await click('[data-mote-bot-create]'); await ready('[data-mote-bot-code]')
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection).toEqual(old)
  expect(f.creationCount).toBe(1)
  await ready('[data-mote-enrollment-action="confirm-account"]'); await f.click('Confirm this account'); await f.click('Create this bot')
  await vi.waitFor(async () => expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection?.application.appId).not.toBe(old.application.appId), { timeout: 8000 })
  expect((await f.client.call('connection.ls', {})).connections.some(item => item.config.connectionId === old.connectionId)).toBe(true)
  expect(f.saves.mock.calls.some(([input]) => input.kind === 'connection' && input.values.connection === null)).toBe(false)
})

it('keeps unavailable original identity and unknown reads out of the unbound creation choices', async () => {
  const input = { kind: 'connection' as const, target: f.target() }, baseline = moteConnectionBaseline(await f.preferences.read(input))!
  const original = { connectionId: 'saved-unavailable-identity', application: { domain: 'open.feishu.cn', appId: 'original-unavailable-app' } }
  await f.client.call('connection.configure', { operationId: 'configure-original-identity', expectedRevision: null, connection: { ...original, adapterId: 'feishu', label: 'Original identity', credentialRef: 'original-retained-ref', enabled: false } })
  expect((await f.preferences.save({ ...input, operationId: 'save-original-unavailable-identity', baseline, values: { connection: original } })).status).toBe('saved')
  const originalConnections = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, value) => { const result = await originalConnections(method, value); return method === 'connection.ls' ? { ...result, connections: [] } as typeof result : result })
  await f.render(0, true); await ready('[data-mote-identity]')
  await vi.waitFor(async () => { await f.settle(); expect(card().dataset.identityState).toBe('bound') })
  expect(card().querySelector('[data-mote-card-action="create"]')).toBeNull()
  expect((await f.preferences.read(input)).values?.connection).toEqual(original)
  const forward = vi.mocked(api.motePreferences.read).getMockImplementation()!
  vi.mocked(api.motePreferences.read).mockImplementation(async value => { if (value.target.spaceId === input.target.spaceId) throw Error('Controlled metadata observation gap'); return forward(value) })
  await f.click('Refresh')
  await vi.waitFor(async () => { await f.settle(); expect(card().textContent).toContain('Identity not confirmed') })
  expect(card().querySelector('[data-mote-card-action="create"]')).toBeNull(); expect(f.beginCount).toBe(0)
})
