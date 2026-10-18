// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { AgentConnectorDialog } from '../src/renderer/src/components/AgentConnectorDialog'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const f = connectorJourneyFixture()
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function render(mode: 'create' | 'existing' | 'details' = 'existing') {
  const session = f.session
  if (session.kind !== 'agent') throw Error('Original Agent required')
  await f.dom.render(<AgentConnectorDialog original={{ name: 'Original Mote Agent', session, target: { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' } } }} mode={mode} onClose={() => { void f.dom.render(null) }} returnFocus={() => null} />)
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  await vi.waitFor(() => expect(document.querySelector('[data-connection-observation]')).not.toBeNull())
}
async function toggle(label: string) {
  const input = [...document.querySelectorAll('label')].find(node => node.textContent?.trim() === label)?.querySelector('input')!
  expect(input, label).not.toBeNull(); await act(async () => input.click())
}
async function connect() {
  await render(); await f.fill('Existing group ID', 'original-room')
  await toggle('Share new conversation content with this group.')
  await f.button('Connect group'); await ready('Group saved')
  return (await f.services.connections.bindings!.list({})).bindings[0]!
}

it('new and existing group defaults are distinct and unsent drafts survive remount without consent or access grants', async () => {
  await render('create')
  await f.fill('Group name', 'Unsent dedicated group')
  await f.fill('Member ID type', 'open_id'); await f.fill('Invite member IDs', 'ou_invited')
  await f.dom.render(null); await render('create')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Group name"]')?.value).toBe('Unsent dedicated group')
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Invite member IDs"]')?.value).toBe('ou_invited')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Existing group"]')!.click())
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Existing group ID"]'), document.querySelector('[role="dialog"]')?.textContent).not.toBeNull())
  await f.fill('Existing group ID', 'unsent-existing')
  expect(document.querySelector<HTMLElement>('[aria-label="Group input scope"]')?.dataset.value).toBe('mentions-and-replies')
  await toggle('Share new conversation content with this group.')
  await f.dom.render(null); await render('existing')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Existing group ID"]')?.value).toBe('unsent-existing')
  expect([...document.querySelectorAll('label')].find(node => node.textContent?.trim() === 'Share new conversation content with this group.')?.querySelector('input')?.checked).toBe(false)
  expect(f.calls.filter(call => ['connection.bind', 'connection.room.create', 'connection.grant'].includes(call.method))).toEqual([])
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="New group"]')!.click())
  await f.button('Create group'); await ready('Group created')
  expect(document.querySelector<HTMLElement>('[aria-label="Group input scope"]')?.dataset.value).toBe('all-messages')
  expect(document.querySelector<HTMLElement>('[aria-label="Group sharing content"]')?.dataset.value).toBe('future-shared-conversation')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
}, 20_000)

it('pause and resume use exact lifecycle methods, permission-only members do not count as request access, and clearing access revokes it', async () => {
  const binding = await connect()
  await f.fill('Member access ID type', 'open_id'); await f.fill('Member access ID', 'ou_original')
  await toggle('Answer questions'); await f.button('Approve this member'); await ready('Answers')
  expect(document.querySelector('[aria-label="Group member access"]')?.textContent).toContain('No members approved')
  await toggle('Answer questions'); await f.button('Save member access'); await ready('Access revoked')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).grants[0]).toMatchObject({ state: 'revoked', capabilities: [] })
  await f.button('Pause sync'); await ready('Sync paused')
  await f.button('Resume sync'); await ready('Connection saved')
  const saved = (await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding
  expect(saved).toMatchObject({ state: 'active', revision: 3, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(f.calls.filter(call => call.method === 'connection.binding.resume')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.binding.relink')).toHaveLength(0)
  await f.button('Disconnect group'); await ready('Disconnect this group?')
  expect((await f.services.connections.bindings!.list({})).bindings).toHaveLength(1)
  await f.button('Confirm disconnect'); await ready('Group disconnected')
  expect((await f.services.connections.bindings!.list({})).bindings).toEqual([])
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding).toMatchObject({ state: 'detached', revision: 4 })
  expect(document.querySelector('[aria-label="Disconnected group"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Group connection status"]')).toBeNull()
  await f.original.unchanged()
}, 25_000)

it('a lost detach response survives reopening and only inspects its original operation', async () => {
  const binding = await connect()
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    const result = await f.forward(method, input)
    if (method === 'connection.binding.detach') throw Error('Original detach response lost')
    return result
  })
  await f.button('Disconnect group'); await f.button('Confirm disconnect'); await ready('Setup is not confirmed')
  const intent = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.binding.detach')!
  expect(intent?.phase).toBe('may-have-dispatched')
  await f.dom.render(null); await render('details'); await ready('Group disconnected')
  expect(f.calls.filter(call => call.method === 'connection.binding.detach')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.binding.inspect' && 'operationId' in (call.input as object)).some(call => (call.input as { operationId: string }).operationId === intent.input.operationId)).toBe(true)
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding.state).toBe('detached')
  expect(Object.values(useAppStore.getState().connectorRoomIntents).some(value => value.input.operationId === intent.input.operationId)).toBe(false)
  await f.original.unchanged()
}, 25_000)
