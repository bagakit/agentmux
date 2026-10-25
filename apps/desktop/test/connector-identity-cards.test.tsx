// @vitest-environment happy-dom
import { act } from 'react'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { copyConnectorIdentity } from './helpers/connector-identity-copy'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => {
  // The Mote directory belongs to the original local owner; its RPC remains real.
  f = await moteBotUi({ hostId: 'local' })
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
async function library() { await f.render(0, true); await click('[data-mote-directory]'); await ready(`[data-mote-identity="${f.scopes[0]!.topic.id}"]`) }
async function create() {
  await library()
  await vi.waitFor(async () => { await f.settle(); expect(card().dataset.identityState).toBe('unbound') })
  await act(async () => card().querySelector<HTMLButtonElement>('.connector-mote-card__identity')!.click())
  await f.click('Sign in & continue')
  await vi.waitFor(() => expect(f.beginCount).toBe(1), { timeout: 3500 })
  await ready('[data-mote-enrollment-action="confirm-account"]')
  expect(f.creationCount).toBe(0)
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const summary = document.querySelector<HTMLElement>('.connector-account-summary')!
  expect(summary).not.toBeNull()
  expect(summary.querySelector('img')).toBeNull()
  await copyConnectorIdentity(summary, 'Copy person name', 'Original account')
  await copyConnectorIdentity(summary, 'Copy tenant name', 'Original enterprise')
  await copyConnectorIdentity(summary, 'Copy Account ID', 'mote-user-1')
  await copyConnectorIdentity(summary, 'Copy Tenant ID', 'mote-tenant')
  expect(f.creationCount).toBe(0)
  const forward = f.connectionCalls.getMockImplementation()!
  const held: Array<() => void> = []
  let holdConfirmed = true
  f.connectionCalls.mockImplementation(async (method, input) => {
    const value = await forward(method, input)
    if (holdConfirmed && method === 'connection.enrollment.inspect' && value.operation?.authentication?.stage === 'confirmed')
      await new Promise<void>(resolve => held.push(resolve))
    return value
  })
  await f.click('Confirm this account'); expect(f.creationCount).toBe(0)
  // Force the real background observer to overlap the explicit confirmation read.
  // The explicit result finishes first; the observer returns after its effect was cancelled.
  await vi.waitFor(async () => { await f.settle(); expect(held.length).toBe(2) }, { timeout: 6000 })
  holdConfirmed = false
  await act(async () => { held[0]!(); await new Promise(resolve => setTimeout(resolve, 20)) })
  await act(async () => { held[1]!(); await new Promise(resolve => setTimeout(resolve, 20)) })
  f.connectionCalls.mockImplementation(forward)
  const account = f.parentCalls.mock.calls.findLast(([method, input]) => method === 'space.mote.connection.advance' && input.enrollment?.decision.kind === 'confirm-account')
  expect(account).toBeTruthy()
  const observed = await f.client.call('space.mote.connection.inspect', { operationId: account![1].operationId })
  expect(observed.operation?.enrollment?.authentication?.stage, JSON.stringify(observed.operation)).toBe('confirmed')
  await f.click('Create, configure & publish')
  await vi.waitFor(async () => { await f.settle(); expect(document.body.textContent).toContain('Original save confirmed') }, { timeout: 8000 })
  await f.click('Back to bot profile'); await ready('[data-mote-identity-unbind]')
}

it('opens the identity library and the original Mote detail without accessing the vault; the global plus creates a general identity', async () => {
  const secure = vi.spyOn(ConnectionSecrets.prototype, 'assertAvailable')
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
  await f.click('Back to bots'); await click('[data-enrollment-new]')
  expect(document.body.textContent).toContain('Create a bot')
  expect(document.querySelector('[data-mote-identity-panel]')).toBeNull()
  expect(f.parentCalls.mock.calls.some(([method]) => method === 'space.mote.connection.create')).toBe(false)
  expect(secure).not.toHaveBeenCalled()
})

it('one contextual action creates with the exact saved Mote name and avatar, then unbinds only its default through the original writer', async () => {
  const savedProfile = await f.input('original-saved-profile-observation')
  await create()
  const input = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
  expect(input.source).toEqual(savedProfile.source)
  expect(input.source.target).toEqual(f.target())
  expect(input.desired).toEqual(savedProfile.desired)
  expect(input.desired.name).toBe('Saved public name')
  const operation = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  expect(operation.snapshot.name).toBe('Saved public name')
  expect(operation.snapshot.avatarSha256).toBe(createHash('sha256').update(Buffer.from(savedProfile.desired.avatar.pngDataUrl.slice('data:image/png;base64,'.length), 'base64')).digest('hex'))
  await f.click('Manage bot application'); await f.click('Back to Mote bot'); await ready('[data-mote-identity-unbind]')
  await f.settle(); expect(f.beginCount).toBe(1)
  const before = (await f.client.call('connection.ls', {})).connections
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection).toEqual(operation.connection)
  await click('[data-mote-identity-unbind]')
  await vi.waitFor(async () => expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection).toBeNull())
  expect(f.saves.mock.calls.at(-1)![0].values).toEqual({ connection: null })
  expect((await f.client.call('connection.ls', {})).connections).toEqual(before)
  await f.click('Back to Motes')
  await vi.waitFor(async () => { await f.settle(); expect(card().dataset.identityState).toBe('unbound') })
  expect(card().textContent).toContain('No bot linked'); expect(f.creationCount).toBe(1)
})

it('a replacement keeps the old identity until the same new application is saved, without deleting the old application', async () => {
  await create()
  const old = (await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection!
  await f.click('Create a replacement identity'); await f.click('Prepare replacement')
  await click('[data-mote-bot-create]'); await ready('[data-mote-bot-code]')
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection).toEqual(old)
  expect(f.creationCount).toBe(1)
  await ready('[data-mote-enrollment-action="confirm-account"]'); await f.click('Confirm this account'); await f.click('Create, configure & publish')
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
  await vi.waitFor(async () => { await f.settle(); expect(card().textContent).toContain('Bot not confirmed') })
  expect(card().querySelector('[data-mote-card-action="create"]')).toBeNull(); expect(f.beginCount).toBe(0)
})
