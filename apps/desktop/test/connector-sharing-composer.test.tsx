// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
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
const input = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')! as HTMLElement & { editor: Editor }

it('the visible workface reads its original global sync policy without opening a management menu', async () => {
  expect((await api.connections.call('connection.bind', f.original.input)).state).toBe('applied')
  const configured = await api.connections.call('connection.service.configure', { operationId: 'visible-sharing-sync-off', expectedRevision: 0, service: { enabled: false } }, f.hostingTarget)
  expect(configured.service.enabled).toBe(false)
  const before = f.calls.length
  await f.mount()
  await wait(() => {
    expect(document.querySelectorAll('.conversation-sharing-notice')).toHaveLength(2)
    for (const notice of document.querySelectorAll('.conversation-sharing-notice')) {
      expect(notice.textContent).toContain('Automatic sync off')
      expect(notice.textContent).not.toMatch(/unconfirmed|Checking sync/u)
      expect(notice.querySelectorAll('.conversation-sharing-notice__status')).toHaveLength(1)
    }
  })
  expect(f.calls.slice(before).some(call => call.method === 'connection.service.get' && Object.keys(call.input as object).length === 0 && call.result)).toBe(true)
  expect(document.querySelector('[role="menu"], [role="dialog"]')).toBeNull()
  expect(f.calls.slice(before).some(call => ['connection.service.configure', 'connection.bind', 'connection.grant', 'connection.delivery.retry'].includes(call.method))).toBe(false)
  expect(input().getAttribute('contenteditable')).toBe('true')
  await f.original.unchanged()
}, 25_000)

async function bindExisting(waitForNotice = true) {
  await f.journey('existing'); await f.fill('Existing group ID', 'existing-exact-group')
  const content = document.querySelector<HTMLButtonElement>('[aria-label="Group sharing content"]')!
  expect(content).not.toBeNull()
  await moteClick(content)
  let replyOnly!: HTMLElement
  await wait(() => { replyOnly = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent === 'Agent replies and questions')!; expect(replyOnly).toBeDefined() })
  await moteClick(replyOnly)
  const box = document.querySelector<HTMLInputElement>('.agent-connector-check input')!
  await act(async () => box.click()); await f.button('Connect group')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection saved'))
  await f.button('Close')
  if (waitForNotice) await wait(() => expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Agent replies → existing-exact-group'))
  return (await f.services.connections.bindings!.list({})).bindings[0]!
}

it('the actual SessionPane injects read-only sharing scope while all connection management stays outside the input surface', async () => {
  await f.mount()
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.ls' && call.result).length).toBeGreaterThan(0))
  expect(document.querySelector('.conversation-sharing-notice')).toBeNull()
  const binding = await bindExisting(false)
  await wait(() => expect(document.querySelectorAll('.conversation-sharing-notice__audience')).toHaveLength(2))
  const notice = document.querySelector('.conversation-sharing-notice')!
  expect(notice.querySelector('.conversation-sharing-notice__label')).toBeNull()
  expect(notice.querySelector('img, svg')).not.toBeNull()
  expect(notice.textContent).toContain('Agent replies → existing-exact-group')
  expect(notice.querySelector('.conversation-sharing-notice__audience')?.getAttribute('aria-label')).toContain('Only Agent replies and questions')
  expect(notice.querySelectorAll('button, a, input, select, [role="button"]')).toHaveLength(0)
  const audience = notice.querySelector<HTMLElement>('.conversation-sharing-notice__audience')!
  expect(audience.tagName).toBe('SPAN')
  for (const fact of [binding.externalConversationId, binding.application.domain, binding.application.appId]) expect(audience.title).toContain(fact)
  expect(input().getAttribute('contenteditable')).toBe('true')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding.scope.publication).toBe('future-native-user-facing')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('input sharing context distinguishes reply-only and new-content scope from confirmed off, paused and source-unknown policy', async () => {
  await f.mount(); const binding = await bindExisting()
  const off = await api.connections.call('connection.service.configure', { operationId: 'input-context-sync-off', expectedRevision: 0, service: { enabled: false } })
  await act(async () => observeConnectorService(off.service, api.connections.call, f.hostingTarget))
  expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Automatic sync off')
  expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Agent replies → existing-exact-group')
  const broader = await api.connections.call('connection.binding.relink', { ...f.original.input, operationId: 'input-context-broader-scope', bindingId: binding.bindingId, expectedRevision: binding.revision,
    connectionId: binding.connectionId, externalConversationId: binding.externalConversationId, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(broader.state).toBe('applied')
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Conversation → existing-exact-group'))
  await act(async () => useAppStore.setState({ connectorServiceObservation: { [connectorServiceScope(f.hostingTarget)]: { source: (async () => { throw Error('Other endpoint') }) as typeof api.connections.call,
    generation: 1, state: { enabled: true, revision: 5 }, issue: '' } } }))
  expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Checking sync…')
  await api.connections.call('connection.binding.pause', { operationId: 'input-context-pause', bindingId: binding.bindingId, expectedRevision: 2 })
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Sharing paused'))
  expect(document.querySelector('.conversation-sharing-notice')?.textContent).not.toMatch(/Sync on|Delivered|Delivery confirmed/u)
  expect(document.querySelectorAll('.conversation-sharing-notice :is(button, a, input, select)')).toHaveLength(0)
  expect(input().getAttribute('contenteditable')).toBe('true')
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
  await f.original.unchanged()
}, 25_000)

it('original Composer reflects the exact Binding while its input, draft, selection, focus and IME remain owned by the existing editor', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await f.mount(); const editor = input(); expect(editor).not.toBeNull(); const rich = editor.editor
  const binding = await bindExisting()
  await act(async () => { editor.focus(); rich.commands.setTextSelection({ from: 6, to: 14 }); editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })) })
  const selected = rich.state.selection.toJSON(), originalDraft = useAppStore.getState().agentComposerDrafts['original-agent']
  expect(rich.view.composing).toBe(true)
  await api.connections.call('connection.binding.pause', { operationId: 'pause-from-original-owner', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Sharing paused'))
  expect(input()).toBe(editor); expect(input().editor).toBe(rich)
  expect(rich.state.selection.toJSON()).toEqual(selected); expect(document.activeElement).toBe(editor); expect(rich.view.composing).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(originalDraft)
  expect(editor.getAttribute('contenteditable')).toBe('true')
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })))
  expect(submit).not.toHaveBeenCalled()
  await act(async () => { editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })); rich.commands.insertContent('继续') })
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toContain('继续')
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('unrelated Sessions do not expand sharing reads and a failed exact read retains its prior audience without blocking healthy input', async () => {
  await f.mount(); await bindExisting()
  await wait(() => expect(document.querySelectorAll('.conversation-sharing-notice__audience')).toHaveLength(2))
  const reads = f.calls.filter(call => call.method === 'connection.binding.ls').length, history = vi.mocked(api.sessions.historyPage).mock.calls.length
  const editor = input(), originalDraft = useAppStore.getState().agentComposerDrafts['original-agent']
  await act(async () => useAppStore.setState(state => ({ sessions: [state.sessions[0]!, ...Array.from({ length: 250 }, (_, index) => composerSession('unrelated-' + index))] })))
  await act(async () => {})
  expect(f.calls.filter(call => call.method === 'connection.binding.ls')).toHaveLength(reads)
  expect(vi.mocked(api.sessions.historyPage)).toHaveBeenCalledTimes(history)
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => { if (method === 'connection.binding.ls') throw new Error('Exact read unavailable'); return f.forward<M>(method, params) })
  await act(async () => { editor.focus(); invalidateConnectorTarget(target) })
  await wait(() => expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Group check unavailable'))
  expect(document.querySelector('.conversation-sharing-notice')?.textContent).toContain('Agent replies → existing-exact-group')
  expect(input()).toBe(editor); expect(document.activeElement).toBe(editor); expect(editor.getAttribute('contenteditable')).toBe('true')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(originalDraft)
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('the exact header refresh converges all input notices for the same target while keeping the original draft and metadata failure non-blocking', async () => {
  await f.mount(); await bindExisting()
  const region = document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"]')!
  const neighbor = document.querySelector<HTMLElement>('[data-workbench-region-id="other-region"]')!
  const editor = input(), draft = useAppStore.getState().agentComposerDrafts['original-agent']
  let failed = true
  const pending: (() => void)[] = [], targets: unknown[] = []
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    if (method === 'connection.binding.ls') {
      targets.push(structuredClone(params))
      if (!failed) await new Promise<void>(done => pending.push(done))
      if (failed) throw new Error('Original audience read unavailable')
    }
    return f.forward<M>(method, params)
  })
  await act(async () => { editor.focus(); invalidateConnectorTarget(target) })
  await wait(() => {
    expect(region.querySelector('.conversation-sharing-notice')?.textContent).toContain('Group check unavailable')
    expect(neighbor.querySelector('.conversation-sharing-notice')?.textContent).toContain('Group check unavailable')
  })
  expect(document.querySelectorAll('.conversation-sharing-notice :is(button, a, input, select)')).toHaveLength(0)
  targets.length = 0; failed = false
  try {
    await openConnectionsMenu()
    await wait(() => expect(pending.length).toBeGreaterThan(0))
    expect(targets.length).toBeGreaterThan(0)
    expect(targets).toEqual(targets.map(() => ({ executionHostId: 'local', agentSessionId: 'original-agent' })))
    expect(region.querySelector('.conversation-sharing-notice')?.textContent).toContain('Group check unavailable')
    await act(async () => pending.forEach(release => release()))
    await wait(() => {
      expect(region.querySelector('.conversation-sharing-notice')?.textContent).not.toContain('Group check unavailable')
      expect(neighbor.querySelector('.conversation-sharing-notice')?.textContent).not.toContain('Group check unavailable')
    })
    expect(region.querySelector('.conversation-sharing-notice')?.textContent).toContain('Agent replies → existing-exact-group')
    expect(input()).toBe(editor); expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(draft)
    expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
    expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
  } finally { await act(async () => pending.forEach(release => release())) }
}, 25_000)

it('the Agent header opens original details while the input sharing notice stays read-only and delivery inspection never sends or retries', async () => {
  await f.mount(); const binding = await bindExisting()
  const before = f.calls.filter(call => ['connection.room.create', 'connection.bind', 'connection.grant'].includes(call.method)).length
  expect(document.querySelectorAll('.conversation-sharing-notice :is(button, a, input, select)')).toHaveLength(0)
  await openConnectedGroup(binding.externalConversationId, 'original-region', 'other')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Join this group'))
  await f.button('Check group activity')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Could not check recent sends'))
  expect(vi.mocked(api.connections.call).mock.calls.filter(([method]) => method === 'connection.diagnose').at(-1)?.[1]).toEqual({ executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  const diagnosis = await api.connections.call('connection.diagnose', { executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  expect(diagnosis).toMatchObject({ groups: { value: { items: [{ target: { bindingId: binding.bindingId, bindingRevision: binding.revision, externalConversationId: binding.externalConversationId }, limit: 5, outgoing: { value: null, issue: 'read-unavailable' } }] } } })
  expect(f.calls.some(call => call.method === 'connection.delivery.ls')).toBe(false)
  expect(f.calls.filter(call => ['connection.room.create', 'connection.bind', 'connection.grant'].includes(call.method))).toHaveLength(before)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('the read-only input audiences keep exact application identity and the header opens the selected original group', async () => {
  await f.mount(); await bindExisting()
  const first = (await f.services.connections.list()).connections[0]!.config
  await api.connections.call('connection.configure', { operationId: 'another-application', expectedRevision: null, connection: { ...first, connectionId: 'another-connection', application: { ...first.application, appId: 'another-app' } } })
  const other = await api.connections.call('connection.bind', { ...f.original.input, operationId: 'bind-another-application', bindingId: 'another-binding', connectionId: 'another-connection', externalConversationId: 'another-exact-group' })
  expect(other.state).toBe('applied')
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(document.querySelectorAll('.conversation-sharing-notice__audience')).toHaveLength(4))
  const selected = [...document.querySelectorAll<HTMLElement>('.conversation-sharing-notice__audience')].find(node => node.textContent?.includes('another-exact-group'))!
  expect(selected.title).toContain('another-app')
  expect(selected.tagName).toBe('SPAN')
  expect(document.querySelectorAll('.conversation-sharing-notice :is(button, a, input, select)')).toHaveLength(0)
  await openConnectedGroup('another-exact-group', 'original-region', 'other')
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('another-connection'))
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection saved'))
  const inspected = f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)!
  expect(inspected.input).toEqual({ bindingId: 'another-binding' })
  expect(inspected.result).toMatchObject({ binding: { bindingId: 'another-binding', revision: 1, externalConversationId: 'another-exact-group', application: { appId: 'another-app' } } })
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)
