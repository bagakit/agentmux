// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment'
import { enrollmentInitialWeb } from '../../../packages/connectors/test/fixtures/connection-enrollment-initial'
import { moteConnectionJourney } from './fixtures/mote-connection-journey'
import { moteClick, settleMoteApp } from './fixtures/mote-app'

let f: Awaited<ReturnType<typeof moteConnectionJourney>>
afterEach(async () => { await f?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function managedIdentity(unknownEffect: string | null) {
  f = await moteConnectionJourney({ encryption: enrollmentEncryption() })
  const web = enrollmentInitialWeb({ unknownEffect })
  vi.stubGlobal('fetch', web.fetch)
  let view = await f.client.call('connection.enrollment.begin', { operationId: 'managed-original', connectionId: 'managed-bot', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'AMUX identity',
    preset: { name: 'AMUX identity', description: 'Saved Mote description', avatar: { pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' } }, initialPublication: { version: '1.0.0', notes: 'Enable AMUX conversations.' } })
  async function advance(kind: string) {
    const action = view.actions.find(item => item.kind === kind)!
    expect(action).toBeDefined()
    view = await f.client.call('connection.enrollment.advance', { operationId: view.operation!.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
  }
  while (view.operation!.authentication?.stage !== 'account') {
    const next = view.challenge?.nextPollAt ?? 0
    if (next > Date.now()) await new Promise(done => setTimeout(done, next - Date.now()))
    await advance('continue-authentication')
  }
  await advance('confirm-account'); await advance('create')
  expect(view.operation!.configuration).toBe('configured')
  const record = (await f.client.call('connection.inspect', { connectionId: 'managed-bot' })).connection!
  return { web, view, record }
}

async function saveDefault(record: { config: { connectionId: string; application: { domain: string; appId: string } } }) {
  const current = await f.read()
  const saved = await f.client.call('space.mote.preferences.save', { kind: 'connection', operationId: 'choose-managed', target: f.target(), baseline: moteConnectionBaseline(current)!,
    values: { connection: { connectionId: record.config.connectionId, application: record.config.application } } })
  expect(saved.status, JSON.stringify(saved)).toBe('saved')
}

async function openAgentGroup() {
  const trigger = document.querySelector<HTMLElement>('[data-workbench-region-id="default-region"] .agent-region-header__more')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  let create: HTMLElement | undefined
  await vi.waitFor(() => { create = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Connect group…'); expect(create).toBeDefined() })
  await moteClick(create!)
}

async function openMoteBots() {
  const row = document.querySelector<HTMLElement>('[data-mote-connection="' + f.motes[0]!.id + '"] .mote-connection__row')!
  expect(row).not.toBeNull()
  const preferences = row.closest<HTMLDetailsElement>('.mote-profile__preferences')!
  expect(preferences).not.toBeNull()
  if (!preferences.open) await moteClick(preferences.querySelector('summary')!)
  await moteClick(row)
  await vi.waitFor(() => expect(document.querySelector('.mote-connection-dialog [aria-label="Mote chat bot"]')).not.toBeNull())
}

it('keeps an unfinished original bot out of new-group choices while retaining its local Mote preference and exact setup recovery', async () => {
  const { web, record } = await managedIdentity('/event/switch/')
  expect(record.initialSetup).toEqual({ state: 'incomplete' })
  await saveDefault(record)
  const before = web.requests.length
  await f.mount(); await openAgentGroup()
  await vi.waitFor(() => expect(document.querySelector('[data-incomplete-application]')?.textContent).toContain('AMUX identity · Setup incomplete'))
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('')
  await moteClick(document.querySelector<HTMLElement>('[aria-label="Group application"]')!)
  expect([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].some(node => node.textContent?.includes('AMUX identity'))).toBe(false)
  expect([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].some(node => node.textContent?.includes('Robot A'))).toBe(true)
  await moteClick([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes('Robot A'))!)
  expect((await f.read()).values?.connection?.connectionId).toBe('managed-bot')
  expect(web.requests).toHaveLength(before)
  await f.button('Continue setup')
  await vi.waitFor(() => expect(document.querySelector('.agent-connector-dialog')).toBeNull())
  await vi.waitFor(() => expect(f.connections.mock.calls.some(([method, input]) => method === 'connection.inspect' && 'connectionId' in input && input.connectionId === 'managed-bot')).toBe(true))
  expect(web.requests).toHaveLength(before)
  expect(f.app.launch).not.toHaveBeenCalled(); expect(f.app.stop).not.toHaveBeenCalled()
}, 30_000)

it('offers the original completed bot through the actual Agent menu with untested authentication and keeps its local choice when automatic service is paused', async () => {
  const { web, record } = await managedIdentity(null)
  expect(record.initialSetup).toEqual({ state: 'complete' })
  await saveDefault(record)
  const before = web.requests.length
  await f.mount(); await openAgentGroup()
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('managed-bot'))
  const details = document.querySelector<HTMLDetailsElement>('[data-connection-observation]')!
  await moteClick(details.querySelector('summary')!)
  expect(details.textContent).toContain('Initial setup was completed')
  expect(document.querySelector('[data-incomplete-application]')).toBeNull()
  await f.button('Close group setup')
  await f.client.call('connection.service.configure', { operationId: 'pause-group-service', expectedRevision: 0, service: { enabled: false } })
  await openMoteBots(); await f.choose('AMUX identity')
  expect(document.querySelector('.mote-connection-dialog')?.textContent).toContain('Incoming paused')
  expect(document.querySelector('.mote-connection-dialog')?.textContent).toContain('Initial setup was completed')
  expect(web.requests).toHaveLength(before)
}, 30_000)

it('shows the recorded setup gap in the Mote chooser without adding a gate to saving a local default', async () => {
  const { web } = await managedIdentity('/event/switch/')
  const before = web.requests.length
  await f.mount(); await openMoteBots(); await f.choose('AMUX identity')
  expect(document.querySelector('.mote-connection-dialog')?.textContent).toContain('Setup incomplete')
  await f.button('Use this bot')
  await settleMoteApp()
  expect((await f.read()).values?.connection?.connectionId).toBe('managed-bot')
  expect(web.requests).toHaveLength(before)
}, 30_000)
