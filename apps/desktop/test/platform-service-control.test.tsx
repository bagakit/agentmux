// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { ConnectorHeaderLinks } from '../src/renderer/src/components/ConnectorHeaderLinks'
import { ConnectorServiceControl } from '../src/renderer/src/components/settings/ConnectorServiceControl'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { readConnectorService, selectConnectorServiceObservation } from '../src/renderer/src/lib/connector-service-observation'

let f: Awaited<ReturnType<typeof moteBotUi>> | undefined
const cleanups: Array<() => Promise<void>> = []
const facts: Record<string, unknown> = {}
afterEach(async () => {
  try {
    if (process.env.PLATFORM_CONTROL_FACTS) {
      const path = resolve(process.env.PLATFORM_CONTROL_FACTS)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, JSON.stringify({ boundary: 'Real Settings controls and header through trusted Main IPC, public Unix Core and ConnectionHost. Hosting transport, DOM and platform leaves controlled; no live platform or installed App claim.', facts }, null, 2) + '\n')
    }
  } finally {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    await f?.close(); f = undefined
  }
})
const wait = async (assert: () => void) => vi.waitFor(async () => { await act(async () => {}); assert() }, { timeout: 8000 })
async function mount(node: React.ReactNode) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createClientUiRoot(element)
  cleanups.push(async () => { await act(async () => root.unmount()); element.remove() })
  const render = async (next: React.ReactNode) => { await act(async () => root.render(next)) }
  await render(node)
  return { element, render }
}
const platform = { adapterId: 'feishu', title: 'Lark' }
const other = { adapterId: 'discord', title: 'Discord' }
async function fixture() {
  f = await moteBotUi({ generic: true })
  f.hostingTarget.hostId = 'local'
  useAppStore.setState({ connectorServiceObservation: {}, connectorServiceIntents: {}, agentComposerDrafts: { 'platform-original-agent': 'Keep this unsent text' } })
  return f
}
function header(version = 0, visible = true) {
  return <SettingsNavigation.Provider value={f!.navigation}><ConnectorHeaderLinks bindings={[]} issue="" checking={false} retainedSetup={false} syncEnabled={false}
    nameVersion={version} visible={visible} hostingTarget={f!.hostingTarget} onOpen={() => {}} onConnect={() => {}} onMenuOpen={() => {}} /></SettingsNavigation.Provider>
}
const entries = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>('[data-channel-entry]')].map(element => element.dataset.channelEntry)
const control = () => document.querySelector<HTMLElement>('[data-adapter-service="feishu"]')!
const status = (node: HTMLElement) => node.querySelector<HTMLElement>('[data-connector-service-state]')?.dataset.connectorServiceState
async function click(node: HTMLElement, selector: string) { await act(async () => node.querySelector<HTMLElement>(selector)!.click()) }
const saves = () => f!.connectionCalls.mock.calls.filter(([method]) => method === 'connection.service.configure')

it('saves automatic messages in real Settings without changing header visibility, management or drafts', async () => {
  await fixture()
  await f!.renderSettings()
  const view = await mount(header())
  await wait(() => expect(status(control())).toBe('on'))
  await wait(() => expect(entries(view.element)).toEqual(['feishu', 'discord']))
  expect(saves()).toHaveLength(0)
  const original = await f!.client.call('connection.service.get', {})
  const before = await f!.client.call('connection.ls', {})
  await click(control(), '[aria-label="Enable Lark automatic messages"]')
  expect(control().textContent).toContain('Unsaved change')
  expect(entries(view.element)).toContain('feishu')
  await click(control(), '[data-connector-service-save]')
  await wait(() => expect(status(control())).toBe('off'))
  await wait(() => expect(entries(view.element), 'pausing automatic messages does not hide its entry').toEqual(['feishu', 'discord']))
  const [method, input, owner] = saves()[0]!
  expect(method).toBe('connection.service.configure')
  expect(input).toMatchObject({ adapterId: 'feishu', expectedRevision: 0, service: { enabled: false } })
  expect(owner).toEqual(f!.hostingTarget)
  const intent = useAppStore.getState().connectorServiceIntents[(input as { operationId: string }).operationId]!
  expect(intent.input).toEqual(input); expect(intent.hostingTarget).toEqual(owner)
  const receipt = await f!.client.call('connection.service.inspect', { operationId: intent.input.operationId })
  expect(receipt.operation?.service).toEqual({ adapterId: 'feishu', enabled: false, revision: 1 })
  expect(await f!.client.call('connection.service.get', { adapterId: 'discord' })).toEqual({ adapterId: 'discord', enabled: true, revision: 0 })
  expect(await f!.client.call('connection.service.get', {})).toEqual(original)
  expect(await f!.client.call('connection.ls', {})).toEqual(before)
  expect(document.querySelector('[data-connection-hosting]')).not.toBeNull()
  expect(control().textContent).toContain('Bots, groups and history are kept')
  expect(useAppStore.getState().agentComposerDrafts['platform-original-agent']).toBe('Keep this unsent text')
  expect(saves()).toHaveLength(1)
  facts.settings = { method, input, owner, receipt, globalUnchanged: true, botsUnchanged: true, header: entries(view.element), retainedDraft: true }
})

it('keeps a lost-ACK request and an unsaved platform choice on their original scopes', async () => {
  await fixture()
  const call = f!.runtime.callConnectionHost.bind(f!.runtime)
  let lose = true
  vi.spyOn(f!.runtime, 'callConnectionHost').mockImplementation(async (target, method, input) => {
    const result = await call(target, method, input)
    if (method === 'connection.service.configure' && lose) { lose = false; throw Error('Controlled lost original ACK') }
    return result
  })
  const view = await mount(<ConnectorServiceControl active hostingTarget={f!.hostingTarget} platform={platform} />)
  await wait(() => expect(status(view.element)).toBe('on'))
  await click(view.element, '[aria-label="Enable Lark automatic messages"]')
  await view.render(<ConnectorServiceControl active hostingTarget={f!.hostingTarget} platform={other} />)
  await wait(() => expect(status(view.element)).toBe('on'))
  expect(view.element.textContent).not.toContain('Unsaved change')
  await view.render(<ConnectorServiceControl active hostingTarget={f!.hostingTarget} platform={platform} />)
  expect(view.element.querySelector<HTMLInputElement>('[aria-label="Enable Lark automatic messages"]')?.checked).toBe(false)
  await click(view.element, '[data-connector-service-save]')
  await wait(() => expect(view.element.textContent).toContain('save reply is unconfirmed'))
  const [intent] = Object.values(useAppStore.getState().connectorServiceIntents)
  expect(intent!.input.adapterId).toBe('feishu')
  await click(view.element, `[aria-label="Check original service request ${intent!.input.operationId}"]`)
  await wait(() => expect(view.element.textContent).toContain('Original request confirmed: Off'))
  expect(status(view.element), 'historical receipt does not replace current policy').toBe('on')
  await click(view.element, '.connector-service-control__refresh')
  await wait(() => expect(status(view.element)).toBe('off'))
  expect(saves()).toHaveLength(1)
  expect(await f!.client.call('connection.service.get', { adapterId: 'discord' })).toEqual({ adapterId: 'discord', enabled: true, revision: 0 })
  facts.lostAck = { intent, inspectCount: f!.connectionCalls.mock.calls.filter(([method]) => method === 'connection.service.inspect').length, configureCount: saves().length, otherUnchanged: true, originalDraftRetained: true }
})

it('keeps unknown and wrong-scope policy visible and does not read from hidden headers', async () => {
  await fixture()
  const call = f!.runtime.callConnectionHost.bind(f!.runtime)
  let wrong = true
  vi.spyOn(f!.runtime, 'callConnectionHost').mockImplementation(async (target, method, input) => {
    if (method === 'connection.service.get' && (input as { adapterId?: string }).adapterId === 'feishu' && wrong) return { adapterId: 'discord', enabled: false, revision: 1 } as any
    return call(target, method, input)
  })
  const view = await mount(header())
  await wait(() => expect(selectConnectorServiceObservation(useAppStore.getState().connectorServiceObservation, f!.hostingTarget, 'feishu')?.issue).toBeTruthy())
  expect(entries(view.element)).toEqual(['feishu', 'discord'])
  await view.render(header(1, false))
  const count = f!.connectionCalls.mock.calls.length
  await view.render(header(2, false))
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  expect(f!.connectionCalls).toHaveBeenCalledTimes(count)
  wrong = false
  await act(async () => readConnectorService(() => true, f!.hostingTarget, 'feishu'))
  expect(selectConnectorServiceObservation(useAppStore.getState().connectorServiceObservation, f!.hostingTarget, 'feishu')?.state).toEqual({ adapterId: 'feishu', enabled: true, revision: 0 })
  expect(saves()).toHaveLength(0)
  facts.unknown = { entries: entries(view.element), wrongScopeRejected: true, hiddenReads: 0, writes: 0 }
})

it('ignores a late platform response after the visible control changes scope', async () => {
  await fixture()
  await f!.client.call('connection.service.configure', { adapterId: 'feishu', operationId: 'platform-initial-off', expectedRevision: 0, service: { enabled: false } })
  const call = f!.runtime.callConnectionHost.bind(f!.runtime)
  let release!: () => void, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f!.runtime, 'callConnectionHost').mockImplementation(async (target, method, input) => {
    const result = await call(target, method, input)
    if (method === 'connection.service.get' && (input as { adapterId?: string }).adapterId === 'feishu') { started = true; await held }
    return result
  })
  const view = await mount(<ConnectorServiceControl active hostingTarget={f!.hostingTarget} platform={platform} />)
  await wait(() => expect(started).toBe(true))
  await view.render(<ConnectorServiceControl active hostingTarget={f!.hostingTarget} platform={other} />)
  await wait(() => expect(status(view.element)).toBe('on'))
  release(); await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  expect(status(view.element)).toBe('on')
  expect(view.element.querySelector<HTMLInputElement>('[aria-label="Enable Discord automatic messages"]')?.checked).toBe(true)
  expect(selectConnectorServiceObservation(useAppStore.getState().connectorServiceObservation, f!.hostingTarget, 'discord')?.state).toEqual({ adapterId: 'discord', enabled: true, revision: 0 })
  expect(saves()).toHaveLength(0)
  facts.late = { lateAdapter: 'feishu', visibleAdapter: 'discord', visibleEnabled: true, writes: 0 }
})
