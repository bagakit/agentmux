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
async function consent() { await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false')); const box = document.querySelector<HTMLInputElement>('.agent-connector-check input')!; expect(box).not.toBeNull(); await act(async () => box.click()) }

it('the original Agent menu creates a dedicated group through actual IPC/Core/Host, then independently confirms sharing and reuses the same Binding in another Region', async () => {
  await f.mount(); expect(f.original.create).not.toHaveBeenCalled()
  await f.journey('create'); await ready('Connect a group')
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
  const pairing = document.querySelector('[aria-label="Agent and group conversation"]')!
  expect(document.querySelector('.agent-connector-identity [role="img"]')?.getAttribute('aria-label')).toBe('Original Mote Agent')
  expect(document.querySelector('.agent-connector-identity [data-executor-id]')?.getAttribute('data-executor-id')).toBe(f.session.kind === 'agent' ? f.session.executorId : null)
  expect(pairing.querySelector('[aria-label="Group name"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Group application"]')?.textContent).toContain('Change')
  const invite = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Invite people (optional)')!
  expect(invite.open).toBe(false)
  expect(document.querySelector('[aria-label="Group name"]')?.closest('details')).toBeNull()
  expect(document.querySelector('[aria-label="New group"]')).toBe(document.activeElement)
  expect([...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent === 'Create group')?.closest('footer')).not.toBeNull()
  expect([...document.querySelectorAll('[role="dialog"] button')].some(node => node.textContent === 'Refresh')).toBe(false)
  await f.fill('Member ID type', 'account_id'); await f.fill('Invite member IDs', 'member/甲\nmember/乙')
  await f.button('Create group'); await ready('Group created')
  expect(f.original.create).toHaveBeenCalledTimes(1); expect(f.original.addMembers).toHaveBeenCalledTimes(1)
  expect((await f.services.connections.bindings!.list({})).bindings).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('existing private context')
  await consent(); await f.button('Connect group'); await ready('Group saved')
  const [binding] = (await f.services.connections.bindings!.list({})).bindings
  for (const label of ['Change connected group', 'Connection details']) {
    const section = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === label)!
    expect(section.open, label + ' begins folded').toBe(false)
  }
  expect(document.querySelector('[role="dialog"] code')?.closest('details')?.open).toBe(false)
  await ready('No members approved')
  await vi.waitFor(() => expect([...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Manage member access')?.open).toBe(true))
  const access = document.querySelector('[aria-label="Group member access"]')!
  expect(access.textContent).toBe('No members approved to use this Agent'); expect(access.closest('details')).toBeNull()
  expect(binding).toMatchObject({ executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: 'created-room', scope: { input: 'mentions-and-replies' } })
  expect((await f.services.connections.bindings!.inspect({ bindingId: binding!.bindingId })).grants).toHaveLength(0)
  await f.button('Close'); await f.journey('create', 'other-region'); await ready('Group saved')
  expect(document.querySelector('[aria-label="Group connection status"]')?.textContent).toContain('Group saved')
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
  await f.mount(); await f.journey('create'); await f.fill('Group name', 'Original unknown group'); await f.button('Create group'); await ready('Creation not confirmed')
  const [original] = Object.values(useAppStore.getState().connectorRoomIntents)
  await f.button('Close'); await f.journey('create'); await ready('Creation not confirmed')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Group name"]')?.value).toBe('Original unknown group')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Group name"]')?.disabled).toBe(true)
  await f.button('Check status'); await ready('Creation not confirmed')
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false') })
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
  await f.mount(); await f.journey('create'); await f.button('Create group'); await ready('Setup is not confirmed')
  const [intent] = Object.values(useAppStore.getState().connectorRoomIntents)
  expect(intent?.method).toBe('connection.room.create'); expect(intent?.phase).toBe('may-have-dispatched')
  const persisted = localStorage.getItem('agentmux-workbench-v1')!
  expect(JSON.parse(persisted).state.connectorRoomIntents[intent!.input.operationId]).toEqual(intent)
  await f.dom.render(null)
  useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted)
  await useAppStore.persist.rehydrate(); expect(useAppStore.getState().connectorRoomIntents[intent!.input.operationId]).toEqual(intent)
  await f.mount(); await f.journey('create'); await ready('Group created')
  await f.button('Check status'); await ready('Group created')
  expect(f.original.create).toHaveBeenCalledTimes(1)
  expect(Object.keys(useAppStore.getState().connectorRoomIntents)).toEqual([intent!.input.operationId])
  await f.original.unchanged()
}, 25_000)

it('binding response loss keeps the known group and converges by inspecting its original Binding rather than recreating', async () => {
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { const value = await f.forward(method, input); if (method === 'connection.bind') throw new Error('Binding response unconfirmed'); return value })
  await f.mount(); await f.journey('create'); await f.button('Create group'); await ready('Group created')
  await consent(); await f.button('Connect group'); await ready('Setup is not confirmed')
  const original = Object.values(useAppStore.getState().connectorRoomIntents).find(intent => intent.method === 'connection.bind')!
  expect(original).toBeDefined(); await f.button('Close'); await f.journey('details'); await ready('Group saved')
  await act(async () => await vi.waitFor(() => expect(useAppStore.getState().connectorRoomIntents[original.input.operationId]).toBeUndefined()))
  expect(f.original.create).toHaveBeenCalledTimes(1)
  expect((await f.services.connections.bindings!.list({})).bindings).toHaveLength(1)
  await f.original.unchanged()
}, 25_000)

it('an exact Region occupant change refuses only this room effect and preserves the original Agent and draft', async () => {
  await f.mount(); await f.journey('create')
  await f.original.change(graph => { graph.regions.find(region => region.regionId === 'original-region')!.agentSessionId = 'replacement-agent' })
  await f.button('Create group'); await ready('target-changed')
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)


it('the original Region context menu binds an existing group and keeps actor approval, relink and pause with the same public owner', async () => {
  await f.mount(); await f.journey('existing', 'original-region', true)
  await f.fill('Existing group ID', 'existing-original-group'); await consent(); await f.button('Connect group'); await ready('Group saved')
  let binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  await f.fill('Member access ID type', 'account_id'); await f.fill('Member access ID', 'exact-member')
  for (const label of ['Send requests', 'Answer questions']) {
    const box = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')].find(node => node.closest('label')?.textContent === label)!
    expect(box).toBeDefined(); await act(async () => box.click())
  }
  await f.button('Approve this member')
  await ready('1 member approved to use this Agent')
  expect(document.querySelector('[aria-label="Group member access"]')?.textContent).toBe('1 member approved to use this Agent')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).grants).toMatchObject([{ actor: { idType: 'account_id', userId: 'exact-member' }, capabilities: ['input', 'answer'] }])
  await act(async () => [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Change connected group')!.querySelector('summary')!.click())
  await f.fill('Existing group ID', 'another-exact-group')
  expect(document.querySelector('[aria-label="Group connection status"]'), 'the old group’s confirmed sharing must not describe the proposed group').toBeNull()
  expect(document.querySelector('[aria-label="Group member access"]')).toBeNull()
  expect([...document.querySelectorAll('details')].some(node => node.querySelector('summary')?.textContent === 'Manage member access')).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Your current group stays connected until you confirm this change.')
  await consent(); await f.button('Change group')
  await ready('Group saved'); await ready('No members approved')
  await vi.waitFor(() => expect([...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Manage member access')?.open).toBe(true))
  expect(document.querySelector('.agent-connector-group-selection')?.textContent).toContain('another-exact-group')
  binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  expect(binding.revision).toBe(2)
  expect((await f.services.connections.bindings!.inspect({ bindingId: binding.bindingId, revision: 2 })).grants).toHaveLength(0)
  await f.button('Pause sharing'); await ready('Sharing paused')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding).toMatchObject({ state: 'paused', externalConversationId: 'another-exact-group' })
  await act(async () => [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Change connected group')!.querySelector('summary')!.click())
  await consent(); await f.button('Resume sharing'); await ready('Group saved')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding).toMatchObject({ state: 'active', revision: 4, externalConversationId: 'another-exact-group' })
  await act(async () => [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Change connected group')!.querySelector('summary')!.click())
  await consent(); await f.button('Reconnect group'); await ready('Group saved')
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding).toMatchObject({ state: 'active', revision: 5, externalConversationId: 'another-exact-group' })
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)

it('a lost group-change response keeps the proposed audience unconfirmed until the exact original Binding receipt is observed', async () => {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'existing-original-group'); await consent(); await f.button('Connect group'); await ready('Group saved')
  const original = (await f.services.connections.bindings!.list({})).bindings[0]!
  let observedOriginal = false, heldRefresh = false, release!: () => void
  const continueReading = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    const value = await f.forward(method, input)
    if (method === 'connection.binding.relink') throw new Error('Original group-change response lost')
    if (method === 'connection.binding.inspect' && 'operationId' in input) observedOriginal = true
    if (observedOriginal && method === 'connection.binding.ls') { heldRefresh = true; await continueReading }
    return value
  })
  await act(async () => [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Change connected group')!.querySelector('summary')!.click())
  await f.fill('Existing group ID', 'proposed-exact-group'); await consent(); await f.button('Change group'); await ready('The group change is not confirmed. Check its original status.')
  expect(document.querySelector('[aria-label="Group connection status"]')).toBeNull()
  const retained = Object.values(useAppStore.getState().connectorRoomIntents).find(intent => intent.method === 'connection.binding.relink')!
  expect(retained).toBeDefined(); expect(retained.input).toMatchObject({ bindingId: original.bindingId, externalConversationId: 'proposed-exact-group', expectedRevision: 1 })
  const change = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Change connected group')!
  await act(async () => change.querySelector('summary')!.click()); expect(change.open).toBe(false)
  const actual = (await f.cli(['binding', 'inspect', '--binding', original.bindingId])).binding
  expect(actual).toMatchObject({ revision: 2, externalConversationId: 'proposed-exact-group' })
  expect(document.querySelector('[aria-label="Group connection status"]'), 'folding cannot confirm the old group while its original relink result is unknown').toBeNull()
  expect(document.querySelector('[aria-label="Group member access"]')).toBeNull()
  expect(document.querySelector('[aria-label="Group delivery"]')).toBeNull()
  expect([...document.querySelectorAll('details')].some(node => node.querySelector('summary')?.textContent === 'Manage member access')).toBe(false)
  await ready('The group change is not confirmed. Check its original status.')
  expect(document.querySelector('.agent-connector-group-selection')?.textContent).toContain('proposed-exact-group')
  expect(document.querySelector('.agent-connector-group-selection')?.textContent).not.toContain('existing-original-group')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Requested group · proposed-exact-group')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Last observed group · existing-original-group')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Last observed Binding · ' + original.bindingId + ' · Revision 1')
  expect(useAppStore.getState().connectorRoomIntents[retained.input.operationId]).toEqual(retained)
  expect(f.calls.filter(call => call.method === 'connection.binding.relink')).toHaveLength(1)
  expect(f.calls.some(call => call.method === 'connection.room.get' && (call.input as { externalConversationId: string }).externalConversationId === 'proposed-exact-group')).toBe(true)
  try {
    await f.button('Check status'); await vi.waitFor(() => expect(heldRefresh).toBe(true)); await ready('Group saved')
    expect(document.querySelector('.agent-connector-group-selection')?.textContent, 'the exact inspect.current snapshot replaces the old revision before a later list read can finish').toContain('proposed-exact-group')
  } finally { release() }
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false') })
  expect(document.querySelector('.agent-connector-group-selection')?.textContent).toContain('proposed-exact-group')
  expect(f.calls.filter(call => call.method === 'connection.binding.relink')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.binding.inspect' && 'operationId' in (call.input as object)).at(-1)?.input).toEqual({ operationId: retained.input.operationId })
  expect((await f.cli(['binding', 'inspect', '--binding', original.bindingId])).binding).toMatchObject({ revision: 2, externalConversationId: 'proposed-exact-group' })
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)
