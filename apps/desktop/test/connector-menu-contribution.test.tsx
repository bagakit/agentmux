// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { ConnectionServiceConfigure, ConnectionServiceOperation } from '@agentmux/core/connections'
import { moteConnectionJourney } from './fixtures/mote-connection-journey'
import { moteClick, settleMoteApp } from './fixtures/mote-app'
import { defaultAgent } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { readConnectorService } from '../src/renderer/src/lib/connector-service-observation'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

let f: Awaited<ReturnType<typeof moteConnectionJourney>>
const runtimeEvidence: unknown[] = []
const evidence = (scenario: string, facts: unknown) => { runtimeEvidence.push({ scenario, facts }) }
afterAll(async () => { if (process.env.AGENTMUX_CONNECTOR_MENU_RECEIPT) await writeFile(process.env.AGENTMUX_CONNECTOR_MENU_RECEIPT, JSON.stringify({ schema: 'agentmux.connector-menu-consumer.v1', scope: 'Mounted App, Settings and both original menus through trusted IPC, public Core, default ConnectionHost and compiled CLI; controlled I/O only', scenarios: runtimeEvidence }, null, 2) + '\n') })
beforeEach(async () => { f = await moteConnectionJourney(); useAppStore.setState({ connectorServiceIntents: {}, connectorServiceObservation: null }) })
afterEach(async () => { await f?.dispose() })
const groupLabel = 'Agent Conversation Connector'
const master = () => document.querySelector<HTMLInputElement>('[aria-label="Enable Agent Conversation Connector"]')!
const policy = () => document.querySelector<HTMLElement>('[data-connector-service-state]')!
const original = (id: string) => document.querySelector<HTMLElement>(`[data-service-operation="${id}"]`)!
const writes = () => f.connections.mock.calls.filter(([method]) => method === 'connection.service.configure').map(([, input]) => input as ConnectionServiceConfigure)
const groups = () => [...document.querySelectorAll<HTMLElement>('[data-connector-menu-group]')]
async function waitFor(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }) }
async function closeMenu() {
  const menu = document.querySelector<HTMLElement>('[role="menu"]')
  if (menu) await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await settleMoteApp()
}
async function openMenu(kind: 'header' | 'region') {
  await closeMenu()
  const selector = '[data-workbench-region-id="default-region"]'
  const element = document.querySelector<HTMLElement>(kind === 'header' ? selector + ' .agent-region-header__more' : selector)!
  expect(element, kind).not.toBeNull()
  await act(async () => {
    element.focus()
    element.dispatchEvent(kind === 'header'
      ? new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      : new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }))
  })
  await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  await settleMoteApp()
  return document.querySelector<HTMLElement>(kind === 'header' ? '.agent-region-menu' : '.region-context-menu')!
}
async function menuAction(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === label)
  expect(item, label).toBeDefined(); await moteClick(item!)
}
async function openSettings() {
  await openMenu('header')
  await menuAction('Chat application settings')
  await waitFor(() => expect(policy()?.dataset.connectorServiceState).toBe('on'))
}
async function closeSettings() {
  const close = document.querySelector<HTMLElement>('[aria-label="Close settings"]')!
  expect(close).not.toBeNull(); await moteClick(close)
}
async function settingsFromApp() {
  await closeMenu()
  const settings = document.querySelector<HTMLElement>('[aria-label="Settings"]')!
  expect(settings).not.toBeNull(); await moteClick(settings)
  const nav = document.querySelector<HTMLElement>('nav [data-settings-target="chat-connections"]')!
  expect(nav).not.toBeNull(); await moteClick(nav)
  await waitFor(() => expect(document.querySelector('[data-connector-service]')).not.toBeNull())
}
async function toggle() { expect(master()).not.toBeNull(); await moteClick(master()) }
async function save() { await f.button('Save changes') }
async function cli(args: string[], input?: unknown) {
  const output = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.root, 'public.sock'), 'connection', 'service', ...args], objectCliEnvironment(f.root), input ? JSON.stringify(input) : undefined)
  expect(output.code, output.stdout + output.stderr).toBe(0)
  return JSON.parse(output.stdout).result
}

it('uses the mounted App and Settings master to withdraw and restore one complete group in both original menus', async () => {
  const bot = (await f.services.connections.list()).connections.find(record => record.config.connectionId === 'robot-b')!
  await f.services.connections.configure({ operationId: 'pause-original-bot', expectedRevision: bot.revision, connection: { ...bot.config, enabled: false } })
  await f.mount()
  for (const kind of ['header', 'region'] as const) {
    const menu = await openMenu(kind)
    expect(groups()).toHaveLength(1)
    expect(groups()[0]!.getAttribute('role')).toBe('group')
    expect(groups()[0]!.textContent).toContain(groupLabel)
    expect(menu.querySelectorAll('[data-connector-menu-separator]')).toHaveLength(1)
    expect(groups()[0]!.querySelectorAll('[role="menuitem"]')).toHaveLength(4)
  }
  const before = useAppStore.getState(), bots = (await f.services.connections.list()).connections.map(record => record.config)
  await openSettings(); await toggle()
  const forward = f.connections.getMockImplementation()!
  f.connections.mockImplementation(async (method, input) => {
    if (method === 'connection.service.configure') {
      expect(useAppStore.getState().connectorServiceIntents[(input as ConnectionServiceConfigure).operationId]).toEqual({ input, phase: 'may-have-dispatched' })
    }
    return await forward(method, input)
  })
  await save(); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('off'))
  const input = writes()[0]!
  expect(input).toMatchObject({ expectedRevision: 0, service: { enabled: false } })
  expect(await cli(['get'])).toEqual({ enabled: false, revision: 1 })
  const receipt = await cli(['inspect', '--operation-id', input.operationId])
  expect(receipt.operation).toEqual({ operationId: input.operationId, expectedRevision: 0, status: 'configured', service: { enabled: false, revision: 1 } })
  await closeSettings()
  for (const kind of ['header', 'region'] as const) {
    const menu = await openMenu(kind)
    expect(groups()).toHaveLength(0)
    expect(menu.textContent).not.toMatch(/Agent Conversation Connector|group chat|Shared group details|Chat application settings|Enable a chat application/)
    expect(menu.querySelector('[data-connector-menu-separator]')).toBeNull()
    expect(menu.lastElementChild?.getAttribute('role')).not.toBe('separator')
    expect(menu.textContent).toContain('Copy Agent Link')
  }
  expect((await f.services.connections.list()).connections.map(record => record.config)).toEqual(bots)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(f.app.launch).not.toHaveBeenCalled(); expect(f.app.stop).not.toHaveBeenCalled(); expect(f.app.send).not.toHaveBeenCalled()
  expect(f.connections.mock.calls.some(([method]) => /room\.create|enrollment\.(begin|poll)|binding\.(relink|pause)/.test(method))).toBe(false)
  await cli(['configure', '--input', '-'], { operationId: 'explicit-service-on', expectedRevision: 1, service: { enabled: true } })
  for (const kind of ['header', 'region'] as const) { await openMenu(kind); expect(groups()).toHaveLength(1); expect(groups()[0]!.textContent).toContain('Create group chat') }
  expect((await f.services.connections.list()).connections.find(record => record.config.connectionId === 'robot-b')!.config.enabled).toBe(false)
  evidence('mounted-settings-two-menus', { input, originalReceipt: receipt.operation, current: await cli(['get']), preservedBots: (await f.services.connections.list()).connections.map(record => ({ connectionId: record.config.connectionId, enabled: record.config.enabled })), preservedAgent: defaultAgent.control })
})

it('keeps an unknown save as its exact original request across remount and current reads, then queries its historical receipt', async () => {
  await f.mount(); await openSettings(); await toggle()
  const forward = f.connections.getMockImplementation()!
  f.connections.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'connection.service.configure') throw new Error('Controlled lost service acknowledgement')
    return result
  })
  await save(); await waitFor(() => expect(document.body.textContent).toContain('The save reply is unconfirmed'))
  const input = structuredClone(writes()[0]!)
  expect(useAppStore.getState().connectorServiceIntents[input.operationId]).toEqual({ input, phase: 'may-have-dispatched' })
  const persisted = JSON.parse(window.localStorage.getItem(useAppStore.persist.getOptions().name)!).state
  expect(persisted.connectorServiceIntents).toEqual({ [input.operationId]: { input, phase: 'may-have-dispatched' } })
  expect(persisted.connectorServiceObservation).toBeUndefined()
  await moteClick(original(input.operationId).querySelector<HTMLButtonElement>('button')!)
  await waitFor(() => expect(original(input.operationId).textContent).toContain('Original request confirmed: Off at revision 1'))
  expect(policy().dataset.connectorServiceState).toBe('on')
  expect(useAppStore.getState().connectorServiceObservation?.state).toEqual({ enabled: true, revision: 0 })
  await f.button('Refresh status'); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('off'))
  expect(original(input.operationId).textContent).toContain('Original request confirmed: Off at revision 1')
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().connectorServiceIntents[input.operationId]?.input).toEqual(input)
  f.connections.mockImplementation(forward)
  await f.app.remount()
  const settings = document.querySelector<HTMLElement>('[aria-label="Settings"]')
  expect(settings).not.toBeNull(); await moteClick(settings!)
  const nav = document.querySelector<HTMLElement>('nav [data-settings-target="chat-connections"]')!
  expect(nav).not.toBeNull(); await moteClick(nav)
  await waitFor(() => expect(original(input.operationId)).not.toBeNull())
  expect(writes()).toHaveLength(1)
  expect(original(input.operationId).textContent).toContain('The original request result is unconfirmed')
  await moteClick(original(input.operationId).querySelector<HTMLButtonElement>('button')!)
  await waitFor(() => expect(original(input.operationId).textContent).toContain('Original request confirmed: Off at revision 1'))
  await toggle(); await save(); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('on'))
  expect(writes()[1]).toMatchObject({ expectedRevision: 1, service: { enabled: true } })
  expect(writes()[1]!.operationId).not.toBe(input.operationId)
  await toggle()
  await moteClick(original(input.operationId).querySelector<HTMLButtonElement>('button')!)
  expect(master().checked).toBe(false)
  expect(policy().dataset.connectorServiceState).toBe('on')
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation.service).toEqual({ enabled: false, revision: 1 })
  expect(useAppStore.getState().connectorServiceIntents[input.operationId]?.input).toEqual(input)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  evidence('retained-original-request', { input, retained: useAppStore.getState().connectorServiceIntents[input.operationId], receipt: await cli(['inspect', '--operation-id', input.operationId]), current: await cli(['get']), configureInputs: writes() })
})

it('requires an explicit fresh revision for a new choice after an unknown save while retaining the original input', async () => {
  await f.mount(); await openSettings(); await toggle()
  const forward = f.connections.getMockImplementation()!
  let lost = false
  f.connections.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'connection.service.configure' && !lost) { lost = true; throw new Error('Controlled original save reply gap') }
    return result
  })
  await save(); await waitFor(() => expect(document.body.textContent).toContain('The save reply is unconfirmed'))
  const originalInput = structuredClone(writes()[0]!)
  const saveButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save changes')!
  expect(saveButton().disabled).toBe(true)
  await f.button('Refresh status'); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('off'))
  await toggle(); expect(master().checked).toBe(true)
  expect(saveButton().disabled).toBe(true)
  expect(writes()).toHaveLength(1)
  await f.button('Review latest setting'); expect(master().checked).toBe(true)
  await save(); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('on'))
  expect(writes()).toHaveLength(2)
  expect(writes()[1]).toMatchObject({ expectedRevision: 1, service: { enabled: true } })
  expect(writes()[1]!.operationId).not.toBe(originalInput.operationId)
  expect(useAppStore.getState().connectorServiceIntents[originalInput.operationId]?.input).toEqual(originalInput)
})

it('checks an inspected receipt against the retained full input rather than the operation ID alone', async () => {
  const input = { operationId: 'original-input-collision', expectedRevision: 0, service: { enabled: false } }
  await f.client.call('connection.service.configure', { ...input, service: { enabled: true } })
  useAppStore.setState({ connectorServiceIntents: { [input.operationId]: { input, phase: 'may-have-dispatched' } } })
  await f.mount(); await openSettings()
  await moteClick(original(input.operationId).querySelector<HTMLButtonElement>('button')!)
  await waitFor(() => expect(original(input.operationId).textContent).toContain('Connector service data does not describe the original policy or operation'))
  expect(original(input.operationId).textContent).toContain('The original request result is unconfirmed')
  expect(original(input.operationId).textContent).not.toContain('Original request confirmed')
  expect(useAppStore.getState().connectorServiceIntents[input.operationId]?.input).toEqual(input)
  expect(policy().dataset.connectorServiceState).toBe('on')
  expect(writes()).toHaveLength(0)
})

it('does not let an earlier service read restore On after the service Off receipt', async () => {
  await f.mount(); await openSettings()
  const old = await cli(['get'])
  const forward = f.connections.getMockImplementation()!
  let release!: (value: unknown) => void, held = false
  f.connections.mockImplementation(async (method, input) => {
    if (method === 'connection.service.get' && !held) { held = true; return await new Promise(resolve => { release = resolve }) as never }
    return await forward(method, input)
  })
  await f.button('Refresh status'); expect(held).toBe(true)
  await toggle(); await save(); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('off'))
  await act(async () => release(old)); await settleMoteApp()
  expect(policy().dataset.connectorServiceState).toBe('off')
  expect(master().checked).toBe(false)
  await closeSettings()
  for (const kind of ['header', 'region'] as const) { await openMenu(kind); expect(groups()).toHaveLength(0) }
})

it('does not publish a late service read from a menu opening that has already closed', async () => {
  const forward = f.connections.getMockImplementation()!
  let release!: (value: unknown) => void, held = false
  f.connections.mockImplementation(async (method, input) => {
    if (method === 'connection.service.get' && !held) { held = true; return await new Promise(resolve => { release = resolve }) as never }
    return await forward(method, input)
  })
  await f.mount(); await openMenu('header'); expect(held).toBe(true)
  expect(groups()[0]!.textContent).toContain('Connector settings')
  expect(groups()[0]!.textContent).not.toContain('Create group chat')
  await closeMenu()
  await act(async () => release({ enabled: true, revision: 0 })); await settleMoteApp()
  expect(useAppStore.getState().connectorServiceObservation?.state).toBeNull()
  await openMenu('region'); expect(groups()[0]!.textContent).toContain('Create group chat')
})

it('keeps a later explicit selection when an earlier configure acknowledgement arrives late', async () => {
  await f.mount(); await openSettings(); await toggle()
  const forward = f.connections.getMockImplementation()!
  let release!: () => void, committed = false
  f.connections.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'connection.service.configure' && !committed) {
      committed = true
      await new Promise<void>(resolve => { release = resolve })
    }
    return result
  })
  await save(); await waitFor(() => expect(committed).toBe(true))
  await toggle(); expect(master().checked).toBe(true)
  await act(async () => release()); await settleMoteApp()
  await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('off'))
  expect(master().checked).toBe(true)
  await f.button('Review latest setting')
  expect(master().checked).toBe(true)
  await save(); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('on'))
  expect(writes()).toHaveLength(2)
  expect(writes()[1]).toMatchObject({ expectedRevision: 1, service: { enabled: true } })
})

it('keeps the newer current revision when an older configure receipt is returned after another explicit writer', async () => {
  await f.mount(); await openSettings(); await toggle()
  const forward = f.connections.getMockImplementation()!
  let release!: () => void, receipt: ConnectionServiceOperation | undefined
  f.connections.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'connection.service.configure') {
      receipt = result as ConnectionServiceOperation
      await new Promise<void>(resolve => { release = resolve })
    }
    return result
  })
  await save(); await waitFor(() => expect(receipt).toBeDefined())
  await cli(['configure', '--input', '-'], { operationId: 'newer-independent-writer', expectedRevision: 1, service: { enabled: true } })
  await f.button('Refresh status'); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('on'))
  await act(async () => release()); await settleMoteApp()
  expect(policy().dataset.connectorServiceState).toBe('on')
  expect(useAppStore.getState().connectorServiceObservation?.state).toEqual({ enabled: true, revision: 2 })
  expect(original(receipt!.operationId).textContent).toContain('Original request confirmed: Off at revision 1')
})

it('keeps a confirmed original receipt when the outstanding configure reply later fails', async () => {
  await f.mount(); await openSettings(); await toggle()
  const forward = f.connections.getMockImplementation()!
  let release!: () => void, committed = false
  f.connections.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'connection.service.configure') {
      committed = true; await new Promise<void>(resolve => { release = resolve })
      throw new Error('Controlled late configure reply gap')
    }
    return result
  })
  await save(); await waitFor(() => expect(committed).toBe(true))
  const input = writes()[0]!
  await moteClick(original(input.operationId).querySelector<HTMLButtonElement>('button')!)
  await waitFor(() => expect(original(input.operationId).textContent).toContain('Original request confirmed: Off at revision 1'))
  await act(async () => release()); await settleMoteApp()
  expect(original(input.operationId).textContent).toContain('Original request confirmed: Off at revision 1')
  expect(original(input.operationId).textContent).toContain('Controlled late configure reply gap')
  expect(original(input.operationId).textContent).not.toContain('The original request result is unconfirmed')
  evidence('inspect-confirmed-before-lost-configure-reply', { input, originalReceipt: (await cli(['inspect', '--operation-id', input.operationId])).operation })
})

it.each(['absent', 'failed'] as const)('keeps the original ACK when an earlier %s inspect completes afterward', async condition => {
  await f.mount(); await openSettings(); await toggle()
  const forward = f.connections.getMockImplementation()!
  let releaseWrite!: () => void, releaseRead!: () => void, waitingWrite = false, waitingRead = false
  f.connections.mockImplementation(async (method, input) => {
    if (method === 'connection.service.configure') { waitingWrite = true; await new Promise<void>(resolve => { releaseWrite = resolve }) }
    const result = await forward(method, input)
    if (method === 'connection.service.inspect') {
      expect(result).toEqual({ operation: null })
      waitingRead = true; await new Promise<void>(resolve => { releaseRead = resolve })
      if (condition === 'failed') throw new Error('Controlled late original lookup gap')
    }
    return result
  })
  await save(); await waitFor(() => expect(waitingWrite).toBe(true))
  const input = writes()[0]!
  await moteClick(original(input.operationId).querySelector<HTMLButtonElement>('button')!)
  await waitFor(() => expect(waitingRead).toBe(true))
  await act(async () => releaseWrite())
  await waitFor(() => expect(original(input.operationId).textContent).toContain('Original request confirmed: Off at revision 1'))
  await act(async () => releaseRead()); await settleMoteApp()
  expect(original(input.operationId).textContent).toContain('Original request confirmed: Off at revision 1')
  expect(original(input.operationId).textContent).not.toContain('No receipt found for this original request')
  expect(policy().dataset.connectorServiceState).toBe('off')
})

it('keeps accurate unknown management and last-confirmed menu groups without changing individual bot preferences', async () => {
  const database = f.services.database!, prepare = database.prepare.bind(database)
  let unavailable = true
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    if (unavailable && sql.startsWith('SELECT enabled,revision FROM connection_service_policy')) throw new Error('Private controlled service read fault')
    return prepare(sql)
  })
  await f.mount(); await settingsFromApp()
  await waitFor(() => expect(document.body.textContent).toContain('Connector service policy storage is unconfirmed'))
  expect(policy().dataset.connectorServiceState).toBe('unconfirmed')
  expect(master()).toBeNull()
  expect(document.querySelectorAll('[data-connection]')).toHaveLength(2)
  expect(document.querySelector('[data-enrollment-new]')).not.toBeNull()
  unavailable = false; await f.button('Refresh status'); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('on'))
  await closeSettings()
  for (const kind of ['header', 'region'] as const) { await openMenu(kind); expect(groups()[0]!.textContent).toContain('Create group chat') }
  unavailable = true
  for (const kind of ['header', 'region'] as const) {
    await openMenu(kind)
    expect(groups()[0]!.textContent).toContain('Create group chat')
    expect(groups()[0]!.textContent).toContain('keeping the last confirmed policy')
  }
  unavailable = false
  await cli(['configure', '--input', '-'], { operationId: 'known-off', expectedRevision: 0, service: { enabled: false } })
  await openMenu('header'); expect(groups()).toHaveLength(0)
  unavailable = true
  for (const kind of ['header', 'region'] as const) { await openMenu(kind); expect(groups()).toHaveLength(0) }
  await settingsFromApp(); await waitFor(() => expect(policy().textContent).toBe('Last confirmed: Off'))
  expect(document.querySelectorAll('[data-connection]')).toHaveLength(2)
  const retainedBots = (await f.services.connections.list()).connections
  expect(retainedBots).toHaveLength(2)
  expect(retainedBots.every(record => record.config.enabled)).toBe(true)
  expect(f.app.stop).not.toHaveBeenCalled(); expect(f.app.launch).not.toHaveBeenCalled()
  evidence('actual-policy-read-fault-isolation', { policy: useAppStore.getState().connectorServiceObservation?.state, issue: useAppStore.getState().connectorServiceObservation?.issue, retainedBots: retainedBots.map(record => ({ connectionId: record.config.connectionId, enabled: record.config.enabled })) })
})

it('contributes the settings path while On without an enabled bot and hides that entire contribution while Off', async () => {
  const bots = (await f.services.connections.list()).connections
  expect(bots).toHaveLength(2)
  for (const bot of bots) await f.services.connections.configure({ operationId: 'pause-' + bot.config.connectionId, expectedRevision: bot.revision, connection: { ...bot.config, enabled: false } })
  await f.mount()
  for (const kind of ['header', 'region'] as const) {
    await openMenu(kind)
    expect(groups()).toHaveLength(1)
    expect(groups()[0]!.textContent).toContain(groupLabel)
    expect([...groups()[0]!.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())).toEqual(['Enable a chat application'])
  }
  await menuAction('Enable a chat application'); await waitFor(() => expect(master()).not.toBeNull())
  await toggle(); await save(); await waitFor(() => expect(policy().dataset.connectorServiceState).toBe('off'))
  await closeSettings()
  for (const kind of ['header', 'region'] as const) { await openMenu(kind); expect(groups()).toHaveLength(0) }
  const retainedBots = (await f.services.connections.list()).connections
  expect(retainedBots).toHaveLength(2)
  expect(retainedBots.every(record => !record.config.enabled)).toBe(true)
})

it('keeps the original group dialog, manually chosen bot and draft mounted when the current service becomes Off', async () => {
  await f.mount(); await openMenu('header'); await menuAction('Create group chat')
  await waitFor(() => expect(document.querySelector('[aria-label="Group name"]')).not.toBeNull())
  await f.choose('Robot B', 'Group application')
  const name = document.querySelector<HTMLInputElement>('[aria-label="Group name"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Original unsent group draft')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const dialog = document.querySelector<HTMLElement>('.agent-connector-dialog')!, before = useAppStore.getState()
  // An independent writer changes the real owner. The same production projection used by Settings reads it.
  await cli(['configure', '--input', '-'], { operationId: 'off-with-original-dialog', expectedRevision: 0, service: { enabled: false } })
  await act(async () => { await readConnectorService() })
  expect(document.querySelector('.agent-connector-dialog')).toBe(dialog)
  expect(document.querySelector<HTMLInputElement>('[aria-label="Group name"]')!.value).toBe('Original unsent group draft')
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')!.dataset.value).toBe('robot-b')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(f.connections.mock.calls.some(([method]) => method === 'connection.room.create' || method === 'connection.bind')).toBe(false)
  await f.button('Close group setup')
  await openMenu('header'); expect(groups()).toHaveLength(0)
  expect(f.app.stop).not.toHaveBeenCalled(); expect(f.app.launch).not.toHaveBeenCalled()
})
