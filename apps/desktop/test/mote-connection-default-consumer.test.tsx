// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteConnectionJourney } from './fixtures/mote-connection-journey'
import { moteClick, settleMoteApp } from './fixtures/mote-app'
import { defaultAgent, defaultTab, customTab } from './fixtures/mote-workface'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { agentMoteConnectionSource } from '../src/renderer/src/lib/mote-connection-default'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { writeFile } from 'node:fs/promises'
import { serializeMoteConnectionMode } from '../src/shared/mote-quick-mode'

let f: Awaited<ReturnType<typeof moteConnectionJourney>>
beforeEach(async () => { f = await moteConnectionJourney() })
afterEach(async () => { await f?.dispose() })
const ref = (suffix: string) => ({ connectionId: 'robot-' + suffix, application: { domain: 'feishu.cn', appId: 'app-' + suffix } })
async function setDefault(suffix: string, index = 0) {
  const current = await f.read(index)
  expect(current.status, JSON.stringify(current)).toBe('ready')
  return await f.client.call('space.mote.preferences.save', { kind: 'connection', operationId: 'seed-' + suffix + '-' + index,
    target: f.target(index), baseline: moteConnectionBaseline(current)!, values: { connection: ref(suffix) } })
}
const row = () => document.querySelector<HTMLElement>('.mote-connection__row')!
const dialog = () => document.querySelector<HTMLElement>('.mote-connection-dialog, .agent-connector-dialog')!
async function waitText(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.body.textContent).toContain(text) }) }

it('saves a bot from the original Mote Profile through trusted IPC and reads the same file through the compiled CLI', async () => {
  await f.mount(); await f.open(); await f.choose('Robot B')
  const before = useAppStore.getState()
  await f.button('Use this bot')
  await vi.waitFor(() => expect(document.querySelector('.mote-connection-dialog')).toBeNull())
  expect(row().textContent).toContain('Robot B')
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect(f.saves.mock.calls[0]![0]).toMatchObject({ kind: 'connection', target: f.target(), values: { connection: ref('b') } })
  expect((await f.cliRead()).values).toEqual({ connection: ref('b') })
  expect((await f.read(1)).values).toEqual({ connection: null })
  expect(await f.bytes()).toContain('# Original notes')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(f.app.launch).not.toHaveBeenCalled(); expect(f.app.stop).not.toHaveBeenCalled()
})

it('keeps the newer saved choice when the Profile opening read arrives after the child writer', async () => {
  await setDefault('a')
  const old = await f.read()
  let release!: (value: unknown) => void, held = false
  f.reads.mockImplementation(input => {
    if (input.kind === 'connection' && !held) { held = true; return new Promise(resolve => { release = resolve }) }
    return f.forwardRead(input)
  })
  await f.mount(); expect(held).toBe(true)
  await f.open(); await f.choose('Robot B'); await f.button('Use this bot')
  await vi.waitFor(() => expect(row().textContent).toContain('Robot B'))
  await act(async () => release(old)); await settleMoteApp()
  expect(row().textContent).toContain('Robot B')
  expect((await f.cliRead()).values).toEqual({ connection: ref('b') })
})

it('retains the full unknown save across dialog close, Profile remount and workbench rehydration without replay', async () => {
  await f.mount(); await f.open(); await f.choose('Robot A')
  f.saves.mockImplementationOnce(async input => { await f.forwardSave(input); throw new Error('Controlled lost Files acknowledgement') })
  await f.button('Use this bot'); await waitText('The save result is unconfirmed')
  const input = structuredClone(f.saves.mock.calls[0]![0])
  expect(useAppStore.getState().moteConnectionSaveIntents[input.operationId]).toEqual({ input, phase: 'may-have-dispatched' })
  await f.button('Close bot choice')
  await f.app.remount(); await f.open()
  await waitText('The previous save is still unconfirmed')
  expect(dialog().textContent).toContain(input.operationId)
  expect(dialog().querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(true)
  await f.button('Check current choice')
  expect((await f.cliRead()).values).toEqual({ connection: ref('a') })
  expect(dialog().textContent).toContain('Reading the current choice does not confirm that save')
  expect(f.saves).toHaveBeenCalledTimes(1)
  // Read a previous persisted projection through the original Zustand persistence owner.
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().moteConnectionSaveIntents[input.operationId]?.input).toEqual(input)
  await f.button('Use current revision for a new choice'); await f.choose('Robot B'); await f.button('Use this bot')
  await vi.waitFor(() => expect(document.querySelector('.mote-connection-dialog')).toBeNull())
  expect(f.saves).toHaveBeenCalledTimes(2)
  const next = f.saves.mock.calls[1]![0]
  expect(next.operationId).not.toBe(input.operationId)
  expect(next.baseline.values).toEqual({ connection: ref('a') })
  expect(useAppStore.getState().moteConnectionSaveIntents[input.operationId]?.input).toEqual(input)
  expect((await f.cliRead()).values).toEqual({ connection: ref('b') })
})

async function openAgentGroup() {
  const trigger = document.querySelector<HTMLElement>('[data-workbench-region-id="default-region"] .agent-region-header__more')!
  expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await vi.waitFor(async () => { await act(async () => {}); expect([...document.querySelectorAll('[role="menuitem"]')].some(node => node.textContent?.trim() === 'Create group chat')).toBe(true) })
  await moteClick([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Create group chat')!)
}

it('initializes the original Agent menu from its Mote default while keeping the original workface', async () => {
  await setDefault('b')
  await f.mount()
  const before = useAppStore.getState()
  await openAgentGroup()
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value, dialog()?.textContent).toBe('robot-b') })
  expect(f.reads.mock.calls.some(([input]) => input.kind === 'connection' && input.target.spaceId === f.target().spaceId)).toBe(true)
  await f.choose('Robot A', 'Group application')
  // Focus another Mote while the original portal and request remain associated with A.
  await act(async () => useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id))
  await settleMoteApp()
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('robot-a')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe(before.agentComposerDrafts[defaultAgent.id])
  expect(f.saves).not.toHaveBeenCalled()
  expect(f.app.launch).not.toHaveBeenCalled(); expect(f.app.stop).not.toHaveBeenCalled()
  expect(before.tabs[defaultTab.id]).toBeDefined()
})

it('does not overwrite a manually chosen bot when the original Mote read is late', async () => {
  await setDefault('b'); await f.mount()
  const saved = await f.read()
  let release!: (value: unknown) => void
  f.reads.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await openAgentGroup()
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[aria-label="Group application"]')).not.toBeNull() })
  await f.choose('Robot A', 'Group application')
  await act(async () => release(saved)); await settleMoteApp()
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('robot-a')
  expect(f.saves).not.toHaveBeenCalled()
})

it('keeps a previously submitted group intent on its original bot ahead of a later Mote default', async () => {
  await setDefault('b')
  const target = { executionHostId: 'local', agentSessionId: defaultAgent.id, regionAnchor: { regionId: 'default-region' } }
  useAppStore.setState({ connectorRoomIntents: { 'original-create': { method: 'connection.room.create', phase: 'not-dispatched', target,
    input: { ...target, operationId: 'original-create', connectionId: 'robot-a', expectedConnectionRevision: 1, name: 'Original requested group', members: [] } } } })
  await f.mount(); await openAgentGroup()
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('robot-a') })
  expect(useAppStore.getState().connectorRoomIntents['original-create']!.input).toMatchObject({ connectionId: 'robot-a', name: 'Original requested group' })
  expect(f.saves).not.toHaveBeenCalled()
})

it.each(['paused', 'unavailable', 'unconfirmed'] as const)('keeps an %s default explicit and lets the user choose another saved bot', async condition => {
  await setDefault('b')
  if (condition === 'paused') {
    const record = (await f.services.connections.list()).connections.find(row => row.config.connectionId === 'robot-b')!
    await f.services.connections.configure({ operationId: 'pause-bot', expectedRevision: record.revision, connection: { ...record.config, enabled: false } })
  } else if (condition === 'unavailable') {
    const forward = f.connections.getMockImplementation()!
    f.connections.mockImplementation(async (method, input) => {
      const value = await forward(method, input)
      return method === 'connection.ls' ? { ...value, connections: (value as { connections: { config: { connectionId: string } }[] }).connections.filter(item => item.config.connectionId !== 'robot-b') } as typeof value : value
    })
  } else await writeFile(f.path(), '---\nversion: 2\n---\n# Original notes\n')
  await f.mount(); await openAgentGroup()
  await vi.waitFor(async () => { await act(async () => {}); expect(dialog()?.textContent).toMatch(condition === 'paused' ? /paused/ : condition === 'unavailable' ? /unavailable here/ : /invalid or unsupported/) })
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('')
  await f.choose('Robot A', 'Group application')
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('robot-a')
  expect(f.saves).not.toHaveBeenCalled(); expect(f.app.stop).not.toHaveBeenCalled()
})

it('keeps readable bots manually selectable when the separate binding read fails', async () => {
  await setDefault('b')
  const forward = f.connections.getMockImplementation()!
  f.connections.mockImplementation(async (method, input) => {
    if (method === 'connection.binding.ls') throw new Error('Controlled original binding observation gap')
    return await forward(method, input)
  })
  await f.mount(); await openAgentGroup(); await waitText('Controlled original binding observation gap')
  await f.choose('Robot A', 'Group application')
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('robot-a')
  expect(f.saves).not.toHaveBeenCalled(); expect(f.app.stop).not.toHaveBeenCalled()
})

it('keeps a saved application mismatch explicit instead of selecting another bot with the same connection ID', async () => {
  const oldRef = { connectionId: 'robot-a', application: { domain: 'feishu.cn', appId: 'different-original-app' } }
  await writeFile(f.path(), serializeMoteConnectionMode(await f.bytes(), { connection: oldRef }))
  expect((await f.read()).values?.connection).toEqual(oldRef)
  await f.mount(); await openAgentGroup()
  await vi.waitFor(async () => { await act(async () => {}); expect(dialog()?.textContent).toContain('This connection belongs to a different bot') })
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('')
  await f.choose('Robot A', 'Group application')
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('robot-a')
  expect(f.saves).not.toHaveBeenCalled(); expect(f.app.stop).not.toHaveBeenCalled(); expect(f.app.launch).not.toHaveBeenCalled()
  expect((await f.cliRead()).values?.connection).toEqual(oldRef)
})

it('uses the exact home Tab for a shared Session independently of execution cwd, focus and display placement', async () => {
  const state = useAppStore.getState(), shared = state.tabs[defaultTab.id]!
  const second = { ...state.tabs[customTab.id]!, regions: { 'custom-region': { ...shared.regions['default-region']!, regionId: 'custom-region' } } }
  const changed = { ...state, sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, workspacePath: f.config.workspaces[1]!.path } : session),
    activeWorkspaceId: 'project', tabs: { ...state.tabs, [second.id]: second }, workbenchSpaceSelection: null }
  expect(agentMoteConnectionSource(changed, defaultTab.id, 'default-region', defaultAgent.id)).toMatchObject({ target: f.target() })
  expect(agentMoteConnectionSource(changed, customTab.id, 'custom-region', defaultAgent.id)).toMatchObject({ target: f.target(1) })
  expect(agentMoteConnectionSource(changed, defaultTab.id, 'default-region', 'another-session')).toHaveProperty('issue')
})

it('uses effective project Zone memberships and never borrows a withdrawn creation-origin Mote', async () => {
  const state = useAppStore.getState(), project = f.config.workspaces[1]!, first = f.motes[0]!, second = f.motes[1]!
  const projectSpace = directoryIdentity(project.hostId, project.path), zoneId = homeZoneId(projectSpace)
  const tab = { ...createWorkbenchTab('shared-project-tab', { kind: 'agent', phase: 'attached', workspaceId: project.id, regionId: 'project-region', sessionId: defaultAgent.id }), space: { spaceId: projectSpace, zoneId } }
  const changed = { ...state, tabs: { ...state.tabs, [tab.id]: tab }, spaceZoneBindings: {
    [zoneId]: { spaceId: first.spaceId, workspaceId: project.id, directoryPath: project.path, relations: { [first.spaceId]: true, [second.spaceId]: true } }
  } }
  expect(agentMoteConnectionSource(changed, tab.id, 'project-region', defaultAgent.id)).toHaveProperty('issue')
  const withdrawn = { ...changed, spaceZoneBindings: { [zoneId]: { ...changed.spaceZoneBindings[zoneId]!, relations: { [first.spaceId]: false, [second.spaceId]: true } } } }
  expect(agentMoteConnectionSource(withdrawn, tab.id, 'project-region', defaultAgent.id)).toMatchObject({ target: f.target(1) })
})
