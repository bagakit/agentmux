// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import type { Editor } from '@tiptap/core'
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { moteClick } from './fixtures/mote-app'
import { openConnectedGroup, openConnectionsMenu } from './helpers/connector-header-navigation'
import { composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'
import { observeConnectorService, connectorServiceScope } from '../src/renderer/src/lib/connector-service-observation'

const f = connectorJourneyFixture(), target = { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' } }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
beforeEach(() => {
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (selector) { return selector === ':popover-open' ? false : matches.call(this, selector) })
})
const input = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')! as HTMLElement & { editor: Editor }


const region = (id = 'original-region') => document.querySelector<HTMLElement>('[data-workbench-region-id="' + id + '"]')!
const trigger = (id = 'original-region', channel = 'other') => region(id).querySelector<HTMLElement>('[data-channel-entry="' + channel + '"]')!
const menu = () => document.querySelector<HTMLElement>('.connector-header-menu')!
const group = (id = 'existing-exact-group') => [...menu().querySelectorAll<HTMLElement>('.connector-header-menu__item')].find(node => node.title.split(' · ').includes(id))!
const writes = () => f.calls.filter(call => /configure|\.bind$|\.relink$|\.pause$|\.grant$|\.create$|\.retry$/.test(call.method)).length
const noInputSharing = () => {
  expect(document.querySelector('.conversation-sharing-notice')).toBeNull()
  expect(document.querySelector('[data-agent-composer] [data-channel-entry]')).toBeNull()
}
async function closeMenu() {
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await wait(() => expect(menu()).toBeNull())
}
async function openGroup(id = 'existing-exact-group', regionId = 'original-region') {
  await openConnectionsMenu(regionId, 'other')
  await wait(() => expect(group(id)).toBeDefined())
  expect(menu().getAttribute('aria-label')).toContain('Conversation sync')
  return group(id)
}
async function bindExisting() {
  await f.journey('existing'); await f.fill('Existing group ID', 'existing-exact-group')
  await moteClick(document.querySelector<HTMLButtonElement>('[aria-label="Group sharing content"]')!)
  let replyOnly!: HTMLElement
  await wait(() => { replyOnly = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="future-native-user-facing"]')!; expect(replyOnly).not.toBeNull() })
  await moteClick(replyOnly)
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection saved'))
  await f.button('Close')
  await wait(() => expect(trigger()?.title).toContain('existing-exact-group'))
  return (await f.services.connections.bindings!.list({})).bindings[0]!
}

it('the visible Session header reads original global sync policy without creating a second input surface or writes', async () => {
  expect((await api.connections.call('connection.bind', f.original.input)).state).toBe('applied')
  const configured = await api.connections.call('connection.service.configure', { operationId: 'visible-sync-off', expectedRevision: 0, service: { enabled: false } }, f.hostingTarget)
  expect(configured.service.enabled).toBe(false)
  const before = writes()
  await f.mount()
  await wait(() => {
    expect(useAppStore.getState().connectorServiceObservation[connectorServiceScope(f.hostingTarget)]?.state?.enabled).toBe(false)
    expect(trigger().title).toContain('Conversation sync')
    expect(trigger('other-region').title).toContain('Conversation sync')
  })
  noInputSharing()
  expect(f.calls.some(call => call.method === 'connection.service.get' && Object.keys(call.input as object).length === 0 && call.result)).toBe(true)
  expect(document.querySelector('[role="menu"], [role="dialog"]')).toBeNull()
  expect(writes()).toBe(before); expect(input().getAttribute('contenteditable')).toBe('true')
  await f.original.unchanged()
}, 25_000)

it('actual SessionPane exposes exact replies-only scope in its original header popover and leaves Message Tool for input', async () => {
  await f.mount(); const binding = await bindExisting(), before = writes()
  const item = await openGroup()
  expect(item.querySelector('small')?.textContent).toBe('Agent replies only')
  expect(item.querySelector('small')?.title).toContain('Messages you write in AgentMux are excluded')
  expect(item.getAttribute('aria-label')).toContain('Agent replies only')
  for (const fact of [binding.externalConversationId, binding.application.appId]) expect(item.title).toContain(fact)
  expect(item.closest('details')).toBeNull()
  noInputSharing()
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding.scope.publication).toBe('future-native-user-facing')
  expect(writes()).toBe(before); expect(input().getAttribute('contenteditable')).toBe('true')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('header scope distinguishes replies-only and full conversation independently from off, paused and unknown observations', async () => {
  await f.mount(); const binding = await bindExisting()
  expect((await openGroup()).querySelector('small')?.textContent).toBe('Agent replies only')
  await closeMenu()
  const off = await api.connections.call('connection.service.configure', { operationId: 'sync-off', expectedRevision: 0, service: { enabled: false } })
  await act(async () => observeConnectorService(off.service, api.connections.call, f.hostingTarget))
  await wait(() => expect(useAppStore.getState().connectorServiceObservation[connectorServiceScope(f.hostingTarget)]?.state?.enabled).toBe(false))
  const broader = await api.connections.call('connection.binding.relink', { ...f.original.input, operationId: 'broader-scope', bindingId: binding.bindingId, expectedRevision: binding.revision,
    connectionId: binding.connectionId, externalConversationId: binding.externalConversationId, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(broader.state).toBe('applied')
  await act(async () => invalidateConnectorTarget(target))
  const full = await openGroup()
  await wait(() => expect(group().querySelector('small')?.textContent).toBe('Conversation messages'))
  expect(full.querySelector('small')?.title).toContain('new user messages and public Agent replies')
  expect(full.closest('details')).toBeNull()
  await closeMenu()
  await api.connections.call('connection.binding.pause', { operationId: 'pause-sharing', bindingId: binding.bindingId, expectedRevision: 2 })
  await act(async () => invalidateConnectorTarget(target))
  const before = writes()
  expect((await openGroup()).querySelector('small')?.textContent).toBe('Conversation messages')
  await wait(() => expect(menu().querySelector('[data-problem-kind="sharing-paused"]')).not.toBeNull())
  expect(menu().textContent).not.toContain('Delivery confirmed')
  expect(writes()).toBe(before); noInputSharing()
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
  await f.original.unchanged()
}, 25_000)

it('original input keeps draft, focus, selection, IME and pending receipts across header refresh and Terminal/InApp views', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await f.mount(); const binding = await bindExisting(), editor = input(), rich = editor.editor
  const pending = { operationId: 'original-pending', runId: f.session.control.run.runId, text: 'Retained original pending input', status: 'deferred' as const, promptCondition: null, errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' }
  await act(async () => {
    useAppStore.setState({ agentSteerQueues: { 'original-agent': [pending] } })
    editor.focus(); rich.commands.setTextSelection({ from: 6, to: 14 })
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))
  })
  const selected = rich.state.selection.toJSON(), originalDraft = useAppStore.getState().agentComposerDrafts['original-agent'], identity = structuredClone(f.session.control)
  await api.connections.call('connection.binding.pause', { operationId: 'pause-original-owner', bindingId: binding.bindingId, expectedRevision: binding.revision })
  const before = writes()
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.ls' && call.result).at(-1)?.result).toMatchObject({ bindings: [expect.objectContaining({ bindingId: binding.bindingId, state: 'paused' })] }))
  for (const mode of ['activity', 'terminal'] as const) {
    await act(async () => useAppStore.getState().setViewMode('original-agent', mode, { focus: false }))
    expect(input()).toBe(editor); expect(input().editor).toBe(rich)
    expect(document.activeElement).toBe(editor); expect(rich.view.composing).toBe(true)
    expect(rich.state.selection.toJSON()).toEqual(selected)
    expect(f.session.control).toEqual(identity)
    expect(document.querySelector('.composer-pending:not([hidden])')?.getAttribute('data-operation-id')).toBe(pending.operationId)
    expect(useAppStore.getState().agentSteerQueues['original-agent']).toEqual([pending])
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(originalDraft)
    noInputSharing()
  }
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })))
  expect(submit).not.toHaveBeenCalled(); expect(writes()).toBe(before)
  await act(async () => { editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })); rich.commands.insertContent('继续') })
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toContain('继续')
  await f.original.unchanged()
}, 25_000)

it('unrelated Sessions add no sharing reads and exact read failure retains header audience without blocking healthy input', async () => {
  await f.mount(); await bindExisting()
  const reads = f.calls.filter(call => call.method === 'connection.binding.ls').length, history = vi.mocked(api.sessions.historyPage).mock.calls.length
  const editor = input(), originalDraft = useAppStore.getState().agentComposerDrafts['original-agent']
  await act(async () => useAppStore.setState(state => ({ sessions: [state.sessions[0]!, ...Array.from({ length: 250 }, (_, index) => composerSession('unrelated-' + index))] })))
  expect(f.calls.filter(call => call.method === 'connection.binding.ls')).toHaveLength(reads)
  expect(vi.mocked(api.sessions.historyPage)).toHaveBeenCalledTimes(history)
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], owner?: Parameters<typeof f.forward>[2]): Promise<ConnectionResultMap[M]> => { if (method === 'connection.binding.ls') throw new Error('Exact read unavailable'); return f.forward<M>(method, params, owner) })
  const before = writes()
  await act(async () => { editor.focus(); invalidateConnectorTarget(target) })
  await wait(() => expect(trigger().title).toContain('Group check unavailable'))
  expect(trigger().title).toContain('existing-exact-group')
  expect(input()).toBe(editor); expect(document.activeElement).toBe(editor); expect(editor.getAttribute('contenteditable')).toBe('true')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(originalDraft)
  expect((await openGroup()).querySelector('small')?.textContent).toBe('Agent replies only')
  expect(writes()).toBe(before); noInputSharing(); await f.original.unchanged()
}, 25_000)

it('the original header recheck converges both views of the same Session while preserving input and pending state', async () => {
  await f.mount(); await bindExisting()
  const editor = input(), draft = useAppStore.getState().agentComposerDrafts['original-agent']
  let failed = true
  const pending: (() => void)[] = [], targets: unknown[] = []
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], owner?: Parameters<typeof f.forward>[2]): Promise<ConnectionResultMap[M]> => {
    if (method === 'connection.binding.ls') { targets.push(structuredClone(params)); if (!failed) await new Promise<void>(done => pending.push(done)); if (failed) throw new Error('Original audience read unavailable') }
    return f.forward<M>(method, params, owner)
  })
  await act(async () => { editor.focus(); invalidateConnectorTarget(target) })
  await wait(() => { expect(trigger().title).toContain('Group check unavailable'); expect(trigger('other-region').title).toContain('Group check unavailable') })
  targets.length = 0; failed = false
  const before = writes()
  try {
    await openConnectionsMenu('original-region', 'other')
    await wait(() => expect(pending.length).toBeGreaterThan(0))
    expect(targets).toEqual(targets.map(() => ({ executionHostId: 'local', agentSessionId: 'original-agent' })))
    await act(async () => pending.forEach(release => release()))
    await wait(() => { expect(trigger().title).not.toContain('Group check unavailable'); expect(trigger('other-region').title).not.toContain('Group check unavailable') })
    expect(group().querySelector('small')?.textContent).toBe('Agent replies only')
    expect(input()).toBe(editor); expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(draft)
    expect(writes()).toBe(before); noInputSharing(); await f.original.unchanged()
  } finally { await act(async () => pending.forEach(release => release())) }
}, 25_000)

it('the header opens original details while Message Tool has no sharing strip and delivery inspection never sends or retries', async () => {
  await f.mount(); const binding = await bindExisting(), before = writes()
  await openConnectedGroup(binding.externalConversationId, 'original-region', 'other')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Join this group'))
  await f.button('Check group activity')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Could not check recent sends'))
  expect(vi.mocked(api.connections.call).mock.calls.filter(([method]) => method === 'connection.diagnose').at(-1)?.[1]).toEqual({ executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  expect(f.calls.some(call => call.method === 'connection.delivery.ls' || call.method === 'connection.delivery.retry')).toBe(false)
  expect(writes()).toBe(before); noInputSharing()
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('exact header audiences preserve application identity and hiding a platform does not create another input entry', async () => {
  await f.mount(); await bindExisting()
  const first = (await f.services.connections.list()).connections[0]!.config
  await api.connections.call('connection.configure', { operationId: 'another-application', expectedRevision: null, connection: { ...first, connectionId: 'another-connection', application: { ...first.application, appId: 'another-app' } } })
  expect((await api.connections.call('connection.bind', { ...f.original.input, operationId: 'bind-another-application', bindingId: 'another-binding', connectionId: 'another-connection', externalConversationId: 'another-exact-group' })).state).toBe('applied')
  await act(async () => {
    invalidateConnectorTarget(target)
    useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, channelHeaderVisibility: { feishu: false } } } }))
  })
  expect(document.querySelector('[data-channel-entry="feishu"]')).toBeNull()
  expect(trigger('original-region', 'discord')).not.toBeNull()
  const before = writes(), item = await openGroup('another-exact-group')
  expect(item.title).toContain('another-app')
  expect(item.querySelector('small')?.textContent).toBe('Agent replies only')
  noInputSharing()
  await moteClick(item)
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('another-connection'))
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)?.result).toBeDefined())
  const inspected = f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)!
  expect(inspected.input).toEqual({ bindingId: 'another-binding' })
  expect(inspected.result).toMatchObject({ binding: { bindingId: 'another-binding', revision: 1, externalConversationId: 'another-exact-group', application: { appId: 'another-app' } } })
  expect(writes()).toBe(before); await f.original.unchanged()
}, 25_000)
