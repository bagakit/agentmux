// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MOTE_CHAT_DEFAULT_VALUES } from '@agentmux/core/mote-chat'
import type { ConnectionRecord } from '@agentmux/core/connections'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
const states: Record<string, ConnectionRecord['initialSetup']> = {
  'completed-identity': { state: 'complete' }, 'unfinished-identity': { state: 'incomplete' }, 'unknown-identity': { state: 'unconfirmed' }
}
beforeEach(async () => {
  f = await moteBotUi()
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => f.topics.list(f.workspace))
  await act(async () => { await useAppStore.getState().refreshScratchTopics(f.workspace.id, true) })
  for (const connectionId of [...Object.keys(states), 'paused-identity']) {
    await f.client.call('connection.configure', { operationId: 'save-' + connectionId, expectedRevision: null,
      connection: { connectionId, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'app-' + connectionId },
        label: 'Same bot name', enabled: connectionId !== 'paused-identity', credentialRef: 'controlled-retained-credential' } })
  }
  const call = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => {
    const result = await call(method, input)
    return method === 'connection.ls' && 'connections' in result ? { ...result, connections: result.connections.map((record: ConnectionRecord) => {
      const initialSetup = states[record.config.connectionId]
      return initialSetup ? { ...record, initialSetup } : record
    }) } : result
  })
})
afterEach(async () => { await f?.close() })
async function ready(check: () => void) { await vi.waitFor(async () => { await f.settle(); check() }, { timeout: 8000 }) }
const identity = (id: string) => document.querySelector<HTMLElement>(`[data-connection="${id}"]`)!
async function saveDefault(connectionId: string) {
  const input = { kind: 'connection' as const, target: f.target() }
  const baseline = moteConnectionBaseline(await f.preferences.read(input))!
  expect((await f.preferences.save({ ...input, operationId: 'choose-' + connectionId, baseline,
    values: { connection: { connectionId, application: { domain: 'open.feishu.cn', appId: 'app-' + connectionId } } } })).status).toBe('saved')
}

it('keeps exact app, setup and current paused traffic distinct for same-name identities using one Mote metadata reading', async () => {
  await saveDefault('completed-identity')
  await f.client.call('space.mote.chat.configure', { operationId: 'save-private-chat-association', target: f.target(), expectedRevision: null, expectedConnectionRevision: 1,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, connection: { connectionId: 'completed-identity', application: { domain: 'open.feishu.cn', appId: 'app-completed-identity' } } } })
  const policy = await f.client.call('connection.service.get', {})
  await f.client.call('connection.service.configure', { operationId: 'pause-automatic-traffic', expectedRevision: policy.revision, service: { enabled: false } })
  await f.render(0, true)
  await ready(() => expect(identity('completed-identity')?.querySelector('[data-identity-motes]')?.textContent).toContain('Saved public name · new groups'))
  await ready(() => expect(identity('completed-identity')?.querySelector('[data-identity-motes]')?.textContent).toContain('Saved public name · private chat paused'))
  for (const id of ['completed-identity', 'unfinished-identity']) {
    expect(identity(id).textContent).toContain('app-' + id)
    expect(identity(id).querySelector('[data-identity-sync]')?.textContent).toBe('Automatic chat sync is paused')
  }
  expect(identity('completed-identity').querySelector('[data-identity-setup]')?.textContent).toBe('Setup complete')
  expect(identity('unfinished-identity').querySelector('[data-identity-setup]')?.textContent).toBe('Setup incomplete')
  // The default Mote discovered by initialization is outside this fixture's spatial catalog.
  // Its unknown reference must remain unknown instead of becoming an absence assertion.
  expect(identity('unfinished-identity').querySelector('[data-identity-motes]')?.textContent).toBe('Mote associations not confirmed')
  const reads = vi.mocked(api.motePreferences.read).mock.calls.length
  expect(reads).toBe(document.querySelectorAll('[data-mote-identity]').length)
  await act(async () => identity('unfinished-identity').querySelector<HTMLButtonElement>('button')!.click())
  await ready(() => expect(document.querySelector('[aria-label="Saved identity facts"]')).not.toBeNull())
  const details = document.querySelector('[aria-label="Saved identity facts"]')!
  expect(details.textContent).toContain('app-unfinished-identity')
  expect(details.textContent).toContain('Setup incomplete')
  expect(details.textContent).toContain('Automatic chat sync is paused')
  expect(vi.mocked(api.motePreferences.read).mock.calls).toHaveLength(reads)
})

it('keeps a failed Mote reading unknown instead of claiming no association or offering a replacement identity', async () => {
  await saveDefault('completed-identity')
  const read = vi.mocked(api.motePreferences.read).getMockImplementation()!
  vi.mocked(api.motePreferences.read).mockImplementation(async input => {
    if (input.target.spaceId === f.target(1).spaceId) throw Error('Controlled original preference read gap')
    return read(input)
  })
  await f.render(0, true)
  await ready(() => expect(identity('completed-identity')?.textContent).toContain('Saved public name · new groups · other associations not confirmed'))
  expect(identity('unfinished-identity').querySelector('[data-identity-motes]')?.textContent).toBe('Mote associations not confirmed')
  const unknownMote = document.querySelector(`[data-mote-identity="${f.scopes[1]!.topic.id}"]`)!
  expect(unknownMote.textContent).toContain('Identity not confirmed')
  expect(unknownMote.querySelector('[data-mote-card-action="create"]')).toBeNull()
})

it('excludes explicitly incomplete and disabled identities from the Mote choice while keeping unknown setup selectable', async () => {
  await f.open()
  await ready(() => expect(document.querySelector('[aria-label="Mote chat bot"]')).not.toBeNull())
  await act(async () => document.querySelector<HTMLElement>('.mote-bot-existing > summary')!.click())
  const trigger = document.querySelector<HTMLElement>('[aria-label="Mote chat bot"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await ready(() => expect(document.querySelectorAll('[role="menuitemradio"]').length).toBeGreaterThan(3))
  for (const id of ['unfinished-identity', 'paused-identity']) {
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes('app-' + id))!
    expect(option, id).toBeTruthy(); expect(option.getAttribute('aria-disabled'), id).toBe('true')
  }
  const unknown = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes('app-unknown-identity'))!
  expect(unknown.getAttribute('aria-disabled')).not.toBe('true')
  await act(async () => unknown.click())
  await f.click('Use this bot')
  await ready(() => expect(document.querySelector('.mote-connection-dialog')).toBeNull())
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection?.connectionId).toBe('unknown-identity')
})

it('confirms the exact local identity and Mote impact before deleting only that identity through the real public owner', async () => {
  await saveDefault('completed-identity'); await f.render(0, true)
  await ready(() => expect(identity('completed-identity')?.textContent).toContain('Saved public name · new groups'))
  await act(async () => identity('completed-identity').querySelector<HTMLButtonElement>('button')!.click())
  await f.click('Remove from AgentMux')
  const confirmation = document.querySelector<HTMLElement>('.confirmation-dialog')!
  expect(confirmation.textContent).toContain('app-completed-identity')
  expect(confirmation.textContent).toContain('Referenced by Saved public name · new groups')
  expect(confirmation.textContent).toContain('remote bot application, Motes, conversations and original operation history are kept')
  expect(f.connectionCalls.mock.calls.some(([method]) => method === 'connection.delete')).toBe(false)
  await f.click('Cancel')
  expect((await f.client.call('connection.inspect', { connectionId: 'completed-identity' })).connection).not.toBeNull()
  await f.click('Remove from AgentMux'); await f.click('Remove identity')
  await ready(() => expect(document.body.textContent).toContain('Identity removed from AgentMux.'))
  expect(identity('completed-identity')).toBeNull()
  expect((await f.client.call('connection.inspect', { connectionId: 'completed-identity' })).connection).toBeNull()
  expect((await f.client.call('connection.inspect', { connectionId: 'unfinished-identity' })).connection).not.toBeNull()
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection?.connectionId).toBe('completed-identity')
  expect(f.creationCount).toBe(0)
})

it('recovers a lost deletion reply after Settings remount even when the deleted identity is absent from the current list', async () => {
  await f.render(0, true); await ready(() => expect(identity('completed-identity')).not.toBeNull())
  await act(async () => identity('completed-identity').querySelector<HTMLButtonElement>('button')!.click())
  await f.click('Remove from AgentMux')
  const call = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => {
    const result = await call(method, input)
    if (method === 'connection.delete') throw Error('Controlled lost original local deletion acknowledgement')
    return result
  })
  await f.click('Remove identity'); await ready(() => expect(document.body.textContent).toContain('Removal result not confirmed.'))
  const input = f.connectionCalls.mock.calls.find(([method]) => method === 'connection.delete')![1]
  if (!('operationId' in input)) throw Error('The actual deletion input must retain its operation ID')
  expect(input.operationId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  await f.remountSettings()
  await ready(() => expect(document.querySelector('[aria-label="Original identity removals"]')).not.toBeNull())
  expect(identity('completed-identity')).toBeNull()
  await f.click('Review identity removal'); await f.click('Check original removal')
  await ready(() => expect(document.body.textContent).toContain('The original identity removal is confirmed.'))
  expect(f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.delete')).toHaveLength(1)
  expect(f.connectionCalls.mock.calls.some(([method, value]) => method === 'connection.delete.inspect' && 'operationId' in value && value.operationId === input.operationId)).toBe(true)
  expect(document.querySelector('[aria-label="Original identity removals"]')).toBeNull()
})
