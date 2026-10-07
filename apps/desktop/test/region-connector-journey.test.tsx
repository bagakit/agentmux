// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const f = connectorJourneyFixture()
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function consent() { const box = document.querySelector<HTMLInputElement>('.agent-connector-check input')!; expect(box).not.toBeNull(); await act(async () => box.click()) }

it('the original Agent menu creates a dedicated group through actual IPC/Core/Host, then independently confirms sharing and reuses the same Binding in another Region', async () => {
  await f.mount(); expect(f.original.create).not.toHaveBeenCalled()
  await f.menu('Create group chat'); await ready('Create group chat')
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
  const invite = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Invite people (optional)')!
  expect(invite.open).toBe(false)
  expect(document.querySelector('[aria-label="Group name"]')?.closest('details')).toBeNull()
  expect(document.querySelector('[aria-label="Group name"]')).toBe(document.activeElement)
  expect([...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent === 'Create group')?.closest('footer')).not.toBeNull()
  expect([...document.querySelectorAll('[role="dialog"] button')].some(node => node.textContent === 'Refresh')).toBe(false)
  await f.fill('Member ID type', 'account_id'); await f.fill('Invite member IDs', 'member/甲\nmember/乙')
  await f.button('Create group'); await ready('Group created')
  expect(f.original.create).toHaveBeenCalledTimes(1); expect(f.original.addMembers).toHaveBeenCalledTimes(1)
  expect((await f.services.connections.bindings!.list({})).bindings).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('existing private context')
  await consent(); await f.button('Connect group'); await ready('Sharing on')
  const [binding] = (await f.services.connections.bindings!.list({})).bindings
  for (const label of ['Change connected group', 'Manage member access', 'Connection details']) {
    const section = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === label)!
    expect(section.open, label + ' begins folded').toBe(false)
  }
  expect(document.querySelector('[role="dialog"] code')?.closest('details')?.open).toBe(false)
  expect(binding).toMatchObject({ executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: 'created-room', scope: { input: 'mentions-and-replies' } })
  expect((await f.services.connections.bindings!.inspect({ bindingId: binding!.bindingId })).grants).toHaveLength(0)
  await f.button('Close'); await f.menu('Create group chat', 'other-region'); await ready('Sharing on')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connected group')
  expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Create group')).toBe(false)
  expect(f.original.create).toHaveBeenCalledTimes(1)
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(1)
  const created = f.calls.find(call => call.method === 'connection.room.create')!
  expect((await f.cli(['room', 'inspect', '--operation-id', (created.input as { operationId: string }).operationId])).operation).toEqual(created.result)
  expect((await f.cli(['binding', 'inspect', '--binding', binding!.bindingId])).binding).toEqual(binding)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('an unknown original create stays inspect-only across closing, reopening and explicit observation', async () => {
  f.original.create.mockResolvedValue({ kind: 'unknown' })
  await f.mount(); await f.menu('Create group chat'); await f.button('Create group'); await ready('Creation not confirmed')
  const [original] = Object.values(useAppStore.getState().connectorRoomIntents)
  await f.button('Close'); await f.menu('Create group chat'); await ready('Creation not confirmed')
  await f.button('Check status'); await ready('Creation not confirmed')
  // An accidental fresh-create button is exercised, so withdrawal cannot hide behind Core dedup.
  const fresh = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === 'Create group')
  if (fresh) { await act(async () => fresh.click()); await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.create').length).toBeGreaterThan(1)) }
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.room.inspect').every(call => (call.input as { operationId: string }).operationId === original!.input.operationId)).toBe(true)
  expect(f.original.create).toHaveBeenCalledTimes(1); expect(f.original.addMembers).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Continue setup')
  expect((await f.cli(['room', 'inspect', '--operation-id', original!.input.operationId])).operation.creation.state).toBe('unknown')
  await f.original.unchanged()
}, 25_000)

it('a lost creation response and Dialog remount inspect the original operation without a new group or operation identity', async () => {
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { const value = await f.forward(method, input); if (method === 'connection.room.create') throw new Error('Response unconfirmed'); return value })
  await f.mount(); await f.menu('Create group chat'); await f.button('Create group'); await ready('Setup is not confirmed')
  const [intent] = Object.values(useAppStore.getState().connectorRoomIntents)
  expect(intent?.method).toBe('connection.room.create'); expect(intent?.phase).toBe('may-have-dispatched')
  const persisted = localStorage.getItem('agentmux-workbench-v1')!
  expect(JSON.parse(persisted).state.connectorRoomIntents[intent!.input.operationId]).toEqual(intent)
  await f.dom.render(null)
  useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted)
  await useAppStore.persist.rehydrate(); expect(useAppStore.getState().connectorRoomIntents[intent!.input.operationId]).toEqual(intent)
  await f.mount(); await f.menu('Create group chat'); await ready('Group created')
  await f.button('Check status'); await ready('Group created')
  expect(f.original.create).toHaveBeenCalledTimes(1)
  expect(Object.keys(useAppStore.getState().connectorRoomIntents)).toEqual([intent!.input.operationId])
  await f.original.unchanged()
}, 25_000)

it('binding response loss keeps the known group and converges by inspecting its original Binding rather than recreating', async () => {
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { const value = await f.forward(method, input); if (method === 'connection.bind') throw new Error('Binding response unconfirmed'); return value })
  await f.mount(); await f.menu('Create group chat'); await f.button('Create group'); await ready('Group created')
  await consent(); await f.button('Connect group'); await ready('Setup is not confirmed')
  const original = Object.values(useAppStore.getState().connectorRoomIntents).find(intent => intent.method === 'connection.bind')!
  expect(original).toBeDefined(); await f.button('Close'); await f.menu('Shared group details'); await ready('Sharing on')
  await act(async () => await vi.waitFor(() => expect(useAppStore.getState().connectorRoomIntents[original.input.operationId]).toBeUndefined()))
  expect(f.original.create).toHaveBeenCalledTimes(1)
  expect((await f.services.connections.bindings!.list({})).bindings).toHaveLength(1)
  await f.original.unchanged()
}, 25_000)

it('an exact Region occupant change refuses only this room effect and preserves the original Agent and draft', async () => {
  await f.mount(); await f.menu('Create group chat')
  await f.original.change(graph => { graph.regions.find(region => region.regionId === 'original-region')!.agentSessionId = 'replacement-agent' })
  await f.button('Create group'); await ready('target-changed')
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)


it('the original Region context menu binds an existing group and keeps actor approval, relink and pause with the same public owner', async () => {
  await f.mount(); await f.menu('Bind existing group chat', 'original-region', true)
  await f.fill('Existing group ID', 'existing-original-group'); await consent(); await f.button('Connect group'); await ready('Sharing on')
  let binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  await f.fill('Member access ID type', 'account_id'); await f.fill('Member access ID', 'exact-member')
  for (const label of ['Send requests', 'Answer questions']) {
    const box = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')].find(node => node.closest('label')?.textContent === label)!
    expect(box).toBeDefined(); await act(async () => box.click())
  }
  await f.button('Approve this member')
  await ready('exact-member: active')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).grants).toMatchObject([{ actor: { idType: 'account_id', userId: 'exact-member' }, capabilities: ['input', 'answer'] }])
  await f.fill('Existing group ID', 'another-exact-group'); await consent(); await f.button('Change group')
  await ready('another-exact-groupSharing on')
  binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  expect(binding.revision).toBe(2)
  expect((await f.services.connections.bindings!.inspect({ bindingId: binding.bindingId, revision: 2 })).grants).toHaveLength(0)
  await f.button('Pause sharing'); await ready('Sharing paused')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding).toMatchObject({ state: 'paused', externalConversationId: 'another-exact-group' })
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)
