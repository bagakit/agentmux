// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import type { Editor } from '@tiptap/core'
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'

const f = connectorJourneyFixture(), target = { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' } }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
const input = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')! as HTMLElement & { editor: Editor }
async function bindExisting() {
  await f.menu('Bind existing group chat'); await f.fill('Existing group ID', 'existing-exact-group')
  const box = document.querySelector<HTMLInputElement>('.agent-connector-check input')!
  await act(async () => box.click()); await f.button('Connect group')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Sharing on'))
  await f.button('Close')
  await wait(() => expect(document.querySelector('.connector-sharing')?.textContent).toContain('Shared group · existing-exact-group'))
  return (await f.services.connections.bindings!.list({})).bindings[0]!
}

it('original Composer reflects the exact Binding while its input, draft, selection, focus and IME remain owned by the existing editor', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await f.mount(); const editor = input(); expect(editor).not.toBeNull(); const rich = editor.editor
  const binding = await bindExisting()
  await act(async () => { editor.focus(); rich.commands.setTextSelection({ from: 6, to: 14 }); editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })) })
  const selected = rich.state.selection.toJSON(), originalDraft = useAppStore.getState().agentComposerDrafts['original-agent']
  expect(rich.view.composing).toBe(true)
  await api.connections.call('connection.binding.pause', { operationId: 'pause-from-original-owner', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(document.querySelector('.connector-sharing')?.textContent).toContain('Sharing paused · existing-exact-group'))
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
  await wait(() => expect(document.querySelectorAll('.connector-sharing__group')).toHaveLength(2))
  const reads = f.calls.filter(call => call.method === 'connection.binding.ls').length, history = vi.mocked(api.sessions.historyPage).mock.calls.length
  const editor = input(), originalDraft = useAppStore.getState().agentComposerDrafts['original-agent']
  await act(async () => useAppStore.setState(state => ({ sessions: [state.sessions[0]!, ...Array.from({ length: 250 }, (_, index) => composerSession('unrelated-' + index))] })))
  await act(async () => {})
  expect(f.calls.filter(call => call.method === 'connection.binding.ls')).toHaveLength(reads)
  expect(vi.mocked(api.sessions.historyPage)).toHaveBeenCalledTimes(history)
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => { if (method === 'connection.binding.ls') throw new Error('Exact read unavailable'); return f.forward<M>(method, params) })
  await act(async () => { editor.focus(); invalidateConnectorTarget(target) })
  await wait(() => expect(document.querySelector('.connector-sharing')?.textContent).toContain('Sharing status unconfirmed'))
  expect(document.querySelector('.connector-sharing')?.textContent).toContain('Last known group · existing-exact-group')
  expect(input()).toBe(editor); expect(document.activeElement).toBe(editor); expect(editor.getAttribute('contenteditable')).toBe('true')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(originalDraft)
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('the Composer group link opens original details and observes bounded delivery without sending or retrying', async () => {
  await f.mount(); const binding = await bindExisting()
  const before = f.calls.filter(call => ['connection.room.create', 'connection.bind', 'connection.grant'].includes(call.method)).length
  await act(async () => document.querySelector<HTMLButtonElement>('.connector-sharing__group')!.click())
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Shared group details'))
  await f.button('Check delivery')
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delivery not confirmed'))
  expect(vi.mocked(api.connections.call).mock.calls.filter(([method]) => method === 'connection.delivery.ls').at(-1)?.[1]).toEqual({ connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision, limit: 5 })
  expect(f.calls.filter(call => ['connection.room.create', 'connection.bind', 'connection.grant'].includes(call.method))).toHaveLength(before)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('a known Composer audience selects its exact application when the Session has multiple connected groups', async () => {
  await f.mount(); await bindExisting()
  const first = (await f.services.connections.list()).connections[0]!.config
  await api.connections.call('connection.configure', { operationId: 'another-application', expectedRevision: null, connection: { ...first, connectionId: 'another-connection', application: { ...first.application, appId: 'another-app' } } })
  const other = await api.connections.call('connection.bind', { ...f.original.input, operationId: 'bind-another-application', bindingId: 'another-binding', connectionId: 'another-connection', externalConversationId: 'another-exact-group' })
  expect(other.state).toBe('applied')
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(document.querySelectorAll('.connector-sharing__group')).toHaveLength(4))
  const selected = [...document.querySelectorAll<HTMLButtonElement>('.connector-sharing__group')].find(node => node.textContent?.includes('another-exact-group'))!
  expect(selected.getAttribute('aria-label')).toContain('another-app')
  await act(async () => selected.click())
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('another-connection'))
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Sharing on'))
  const inspected = f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)!
  expect(inspected.input).toEqual({ bindingId: 'another-binding', revision: 1 })
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)
