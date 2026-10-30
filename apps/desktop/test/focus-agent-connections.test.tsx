// @vitest-environment happy-dom
import { act, useState } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { FocusContextMenu } from '../src/renderer/src/components/FocusContextMenu'
import { AgentConnections } from '../src/renderer/src/components/AgentConnections'
import { agentContextForSession, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'

const f = connectorJourneyFixture({ retired: false })
const target = { executionHostId: 'local', agentSessionId: 'original-agent' }
const select = vi.fn()
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
async function ready(text: string) { await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text)) }
function context() { return agentContextForSession(f.session, undefined, 'Original Focus Agent', useAppStore.getState().config!.workspaces[0], null) }
function SessionMenu({ source }: { source: FocusContext }) {
  const [open, setOpen] = useState(false)
  return <FocusContextMenu context={source} open={open} onOpenChange={setOpen} onRename={() => {}} onRestoreFocus={() => {}}><button data-focus-source>Original Focus source</button></FocusContextMenu>
}
async function openFocus(mode: 'create' | 'existing' | 'details' = 'existing') {
  const trigger = document.querySelector<HTMLElement>('[data-focus-source], .focus-context[data-session-id]')!
  expect(trigger, 'real Focus menu trigger').not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
  let connections: HTMLElement | undefined
  await wait(() => { connections = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Connections'); expect(connections, 'shared Connections slot').toBeDefined() })
  await act(async () => { connections!.focus(); connections!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  const label = mode === 'details' ? 'Shared group details' : 'Connect group…'
  let action: HTMLElement | undefined
  await wait(() => { action = [...document.querySelectorAll<HTMLElement>('[data-connector-menu-group] [role="menuitem"]')].find(node => node.textContent?.trim() === label); expect(action, 'original connector contribution').toBeDefined() })
  await act(async () => action!.click())
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value, document.querySelector('[role="dialog"]')?.textContent).toBe(f.config.connectionId))
  const choice = document.querySelector<HTMLButtonElement>('[aria-label="New group"]')
  if (mode === 'create' && choice) await act(async () => choice.click())
}
async function consent() { await wait(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false')); await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click()) }
function noAnchor(input: unknown) { expect(input).not.toHaveProperty('regionAnchor'); expect(input).toMatchObject(target) }

it('Focus consumes the original creator and binding owner with canonical Session identity and no Region', async () => {
  const original = f.session
  if (original.kind !== 'agent') throw Error('Expected original Agent')
  // A client presentation alias and same-label foreign host cannot replace the canonical source.
  const session = { ...original, id: 'focus-presentation-alias' }
  const foreign = { ...original, id: 'foreign-presentation', hostId: 'foreign-host', control: { ...original.control, hostId: 'foreign-host' } }
  useAppStore.setState({ sessions: [foreign, session], tabs: {}, layouts: {} })
  const source = agentContextForSession(session, undefined, 'Original Focus Agent', useAppStore.getState().config!.workspaces[0], null)
  const surface = { tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts, drafts: useAppStore.getState().agentComposerDrafts }
  await f.dom.render(<FocusContextRow context={source} selected={false} onSelect={select} />)
  await openFocus('create'); expect(f.original.create).not.toHaveBeenCalled()
  await f.button('Create group'); await ready('Group created')
  const create = f.calls.find(call => call.method === 'connection.room.create')!
  noAnchor(create.input)
  const intent = useAppStore.getState().connectorRoomIntents[(create.input as { operationId: string }).operationId]!
  expect(intent.target).toEqual(target); expect(intent.input).toEqual(create.input); expect(intent.phase).toBe('may-have-dispatched')
  await consent(); await f.button('Connect group'); await ready('Group linked')
  const bind = f.calls.find(call => call.method === 'connection.bind')!
  noAnchor(bind.input)
  const [binding] = (await f.services.connections.bindings!.list({})).bindings
  expect(binding).toMatchObject({ ...target, externalConversationId: 'created-room' }); expect(binding).not.toHaveProperty('regionAnchor')
  expect(f.original.create).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(surface.tabs); expect(useAppStore.getState().layouts).toBe(surface.layouts); expect(useAppStore.getState().agentComposerDrafts).toEqual(surface.drafts)
  await f.original.unchanged()
})

it('Focus keeps a lost create receipt inspect-only across inactivity and original intent rehydration', async () => {
  useAppStore.setState({ tabs: {}, layouts: {} })
  const source = context()
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { const value = await f.forward(method, input); if (method === 'connection.room.create') throw Error('Controlled response loss after acceptance'); return value })
  const render = (active: boolean) => f.dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><SessionMenu source={source} /></WorkbenchPresentationContext.Provider>)
  await render(true); await openFocus('create'); await f.button('Create group'); await ready('Setup is not confirmed')
  const [intent] = Object.values(useAppStore.getState().connectorRoomIntents)
  expect(intent?.target).toEqual(target); expect(intent?.phase).toBe('may-have-dispatched')
  const persisted = localStorage.getItem('agentmux-workbench-v1')!
  await render(false); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useAppStore.getState().connectorRoomIntents[intent!.input.operationId]).toEqual(intent)
  await f.dom.render(null); useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted); await useAppStore.persist.rehydrate()
  await render(true); await openFocus('create'); await ready('Group created')
  await f.button('Check status'); await ready('Group created')
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.room.inspect').every(call => (call.input as { operationId: string }).operationId === intent!.input.operationId)).toBe(true)
  expect(Object.keys(useAppStore.getState().connectorRoomIntents)).toEqual([intent!.input.operationId]); expect(f.original.create).toHaveBeenCalledTimes(1)
  await f.original.unchanged()
})

it('Focus rejects only the changed original subject instead of borrowing a same-presentation foreign Session', async () => {
  const source = context(), original = f.session
  if (original.kind !== 'agent') throw Error('Expected original Agent')
  const report = vi.spyOn(useAppStore.getState(), 'reportError')
  await f.dom.render(<SessionMenu source={source} />)
  // The live projection changed behind the original card; presentation id alone grants no target.
  useAppStore.setState({ sessions: [{ ...original, hostId: 'foreign-host', control: { ...original.control, hostId: 'foreign-host' } }] })
  const trigger = document.querySelector<HTMLElement>('[data-focus-source]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
  let root: HTMLElement | undefined
  await wait(() => { root = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Connections'); expect(root).toBeDefined() })
  await act(async () => { root!.focus(); root!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  let action: HTMLElement | undefined
  await wait(() => { action = [...document.querySelectorAll<HTMLElement>('[data-connector-menu-group] [role="menuitem"]')].find(node => node.textContent?.trim() === 'Connect group…'); expect(action).toBeDefined() })
  await act(async () => action!.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(report).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ kind: 'indeterminate', subject: source.control }))
  expect(f.calls.some(call => ['connection.room.create', 'connection.bind'].includes(call.method))).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
})

it('closed Focus cards add no global subscribers, service reads or unrelated-update fan-out', async () => {
  const source = context(), subscribe = useAppStore.subscribe
  let listeners = 0, notifications = 0
  vi.spyOn(useAppStore, 'subscribe').mockImplementation(listener => { listeners++; const release = subscribe((...args) => { notifications++; listener(...args) }); return () => { listeners--; release() } })
  const render = (active: boolean) => f.dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><SessionMenu source={source} /></WorkbenchPresentationContext.Provider>)
  await render(true)
  expect(listeners).toBe(0); expect(api.connections.hostingTarget).not.toHaveBeenCalled()
  await act(async () => { for (let index = 0; index < 200; index++) useAppStore.setState({ agentNames: { unrelated: String(index) } }) })
  expect(notifications).toBe(0); expect(f.calls).toEqual([])
  await openFocus('existing'); expect(listeners).toBeGreaterThan(0)
  await render(false)
  expect(listeners).toBe(0); expect(document.querySelector('[role="dialog"]')).toBeNull()
  const reads = f.calls.length, hosting = vi.mocked(api.connections.hostingTarget).mock.calls.length
  await act(async () => { for (let index = 0; index < 200; index++) useAppStore.setState({ agentNames: { unrelated: String(index) } }) })
  expect(f.calls).toHaveLength(reads); expect(api.connections.hostingTarget).toHaveBeenCalledTimes(hosting)
})

it('the original Region menu keeps its confirmed anchor on the same public creator', async () => {
  await f.mount(); await f.journey('create'); await f.button('Create group'); await ready('Group created')
  expect(f.calls.find(call => call.method === 'connection.room.create')?.input).toMatchObject({ ...target, regionAnchor: { regionId: 'original-region' } })
  await f.original.unchanged()
})

it('the original Region owner refuses its changed anchored target without changing the Agent or draft', async () => {
  await f.mount(); await f.journey('create')
  await f.original.change(graph => { graph.regions.find(region => region.regionId === 'original-region')!.agentSessionId = 'replacement-agent' })
  await f.button('Create group'); await ready('target-changed')
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
  expect(f.calls.find(call => call.method === 'connection.room.create')?.input).toMatchObject({ ...target, regionAnchor: { regionId: 'original-region' } })
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
})

it('Session-only AgentConnections opens original saved binding details without a historical Region', async () => {
  await f.dom.render(<SessionMenu source={context()} />)
  await openFocus(); await f.fill('Existing group ID', 'existing-session-group'); await consent(); await f.button('Connect group'); await ready('Group linked'); await f.button('Close')
  const [binding] = (await f.services.connections.bindings!.list({})).bindings
  expect(binding).toBeDefined(); expect(binding).not.toHaveProperty('regionAnchor')
  const session = f.session
  if (session.kind !== 'agent') throw Error('Expected original Agent')
  await f.dom.render(<AgentConnections session={session} visible />)
  let trigger: HTMLElement | null = null
  await wait(() => { trigger = document.querySelector<HTMLElement>('[data-channel-entry="other"]'); expect(trigger, 'original unknown-channel header').not.toBeNull() })
  await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  let item: HTMLElement | undefined
  await wait(() => { item = [...document.querySelectorAll<HTMLElement>('.connector-header-menu__item')].find(node => node.getAttribute('aria-label')?.includes('existing-session-group')); expect(item, 'original binding entry').toBeDefined() })
  await act(async () => item!.click()); await ready('Group linked')
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.binding.inspect').some(call => (call.input as { bindingId: string }).bindingId === binding!.bindingId)).toBe(true)
  await f.original.unchanged()
})
