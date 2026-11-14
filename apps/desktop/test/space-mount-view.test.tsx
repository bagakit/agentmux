// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { MountedSpaceWorkbench } from '../src/renderer/src/components/MountedSpaceWorkbench'
import { HostOriginalSpaces } from '../src/renderer/src/components/settings/HostOriginalSpaces'
import * as storeModule from '../src/renderer/src/store'
import { acceptsMountedSnapshot, initialMountedSpaceView, mountedRegionKey, mountedSpaceInput, projectMountedSpaceView } from '../src/renderer/src/lib/space-mount-view'
import { createWorkspaceLayout, setWorkbenchRegionSplitRatio, splitWorkbenchRegion } from '@agentmux/layout'
import { dispatchWorkbenchCommand } from '../src/renderer/src/lib/workbench-shortcuts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { spaceMountKey, type SpaceMountRecord } from '../src/shared/space-mount'
import { mountedAgentOpenInput, mountedAgentOpenKey, type MountedAgentOpenInput } from '../src/renderer/src/lib/space-mount-launch'
import { composerDOM } from './helpers/composer-dom-fixture'
import { spaceMountFixture } from './helpers/space-mount-fixture'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function mountedFixture() {
  const fixture = await spaceMountFixture(cleanup), b = fixture.cores[1]!
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(fixture.api.call)
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(fixture.api.watch)
  const resources = await api.spaceMounts.call('resources', { hostId: b.id }), project = resources.workspaces[0]!
  const registered = await api.spaceMounts.call('register', { hostId: b.id, registration: { runtimeId: resources.runtimeId,
    workspaceId: project.workspaceId, expectedResource: { hostId: project.hostId, workspacePath: project.path, projectRootPath: project.repoPath ?? project.path } } })
  const target: SpaceMountRecord = { hostId: b.id, reference: registered.reference, zoneId: registered.zoneId, workspaceId: registered.workspaceId }
  const tabId = 'same-tab', regionId = 'same-region'
  await fixture.api.call('apply', { hostId: target.hostId, reference: target.reference, edit: { reference: target.reference, expectedRevision: registered.revision, changes: {
    tabs: [{ tabId, zoneId: target.zoneId, workspaceId: target.workspaceId, name: 'Original B tab', regionIds: [regionId] }],
    regions: [{ regionId, tabId, kind: 'launcher', agentSessionId: null, runId: null, execution: { hostId: 'local', cwd: project.path, runtimeId: b.identity.runtimeId } }]
  } } })
  return { ...fixture, b, target, key: spaceMountKey(target.reference), tabId, regionId }
}

it('the original Window Store and view consume a registered B Space through real Main without importing its graph into A', async () => {
  const f = await mountedFixture(), before = useAppStore.getState(), tabs = before.tabs, layouts = before.layouts
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Original B tab')) })
  expect(dom.container.textContent).toContain(f.b.identity.runtimeId)
  expect(dom.container.textContent).toContain('No Agent is attached to this original Region')
  expect(dom.container.querySelector('[data-source-region]')?.getAttribute('data-source-region')).toBe(mountedRegionKey(f.target.reference, f.tabId, f.regionId))
  const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Mounted Space task draft"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep B task without starting an Agent')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const state = useAppStore.getState(), held = mountedSpaceInput(state.mountedSpaceInputs, f.key)!
  expect(held.drafts[mountedRegionKey(f.target.reference, f.tabId, f.regionId)]).toBe('Keep B task without starting an Agent')
  expect(state.tabs).toBe(tabs); expect(state.layouts).toBe(layouts)
  expect(await f.cores[0]!.store.read()).toBeNull()
  expect((await f.b.store.read())!.graph.regions[0]!.execution?.runtimeId).toBe(f.b.identity.runtimeId)
  const frozenInputs = state.mountedSpaceInputs
  const snapshot = await f.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference }), zone = snapshot.scope.zones[0]!
  await act(async () => {
    await f.api.call('apply', { hostId: f.target.hostId, reference: f.target.reference, edit: { reference: f.target.reference, expectedRevision: snapshot.revision,
      changes: { zones: [{ ...zone, branch: 'Original B updated' }] } } })
    await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[f.key]?.snapshot?.revision).toBeGreaterThan(snapshot.revision))
  })
  expect(useAppStore.getState().mountedSpaceInputs).toBe(frozenInputs)
  expect(useAppStore.getState().tabs).toBe(tabs)
})

it('source observations reuse the original native projection while private focus, ratios and drafts survive membership additions', async () => {
  const f = await mountedFixture(), snapshot = await f.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  useAppStore.getState().mountSpace(f.target)
  const view = initialMountedSpaceView(snapshot), original = view.tabLayouts[f.tabId]!
  view.tabLayouts[f.tabId] = setWorkbenchRegionSplitRatio(splitWorkbenchRegion(original, original.activeRegionId, 'right', 'private-retained-region'), '', .32)
  useAppStore.getState().editSpaceMountView(f.key, view)
  useAppStore.getState().editSpaceMountDraft(f.key, f.tabId, f.regionId, 'Retain the original B draft')
  const partialize = useAppStore.persist.getOptions().partialize!, projection = partialize(useAppStore.getState())
  expect(projection).toMatchObject({ mountedSpaceInputs: useAppStore.getState().mountedSpaceInputs, selectedSpaceMount: f.key })
  useAppStore.getState().observeSpaceMount(f.target, { snapshot, reading: false })
  expect(partialize(useAppStore.getState())).toBe(projection)
  const next = { ...snapshot, revision: snapshot.revision + 1, scope: { ...snapshot.scope,
    tabs: snapshot.scope.tabs.map(tab => ({ ...tab, regionIds: [...tab.regionIds, 'new-B-region'] })),
    regions: [...snapshot.scope.regions, { ...snapshot.scope.regions[0]!, regionId: 'new-B-region' }] } }
  useAppStore.getState().observeSpaceMount(f.target, { snapshot: next, reading: false })
  const projected = projectMountedSpaceView(mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, f.key)!.view, next)
  expect(projected.selection).toEqual(view.selection)
  expect(projected.tabLayouts[f.tabId]!.root).toMatchObject({ type: 'split', ratio: .32 })
  expect(mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, f.key)!.view).toBe(view)
  expect(partialize(useAppStore.getState())).toBe(projection)
  expect(mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, f.key)!.drafts[mountedRegionKey(f.target.reference, f.tabId, f.regionId)]).toBe('Retain the original B draft')
})

it('hidden Window readers cancel only their source lease and keep the private input and last confirmed source', async () => {
  const f = await mountedFixture()
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Original B tab')) })
  const before = useAppStore.getState().mountedSpaceObservations[f.key]!.snapshot!, inputs = useAppStore.getState().mountedSpaceInputs
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible={false} />)
  await vi.waitFor(() => expect(f.renderer.listenerCount('spaceMounts:event')).toBe(0))
  await f.api.call('apply', { hostId: f.target.hostId, reference: f.target.reference, edit: { reference: f.target.reference, expectedRevision: before.revision,
    changes: { zones: [{ ...before.scope.zones[0]!, branch: 'After hidden' }] } } })
  expect(useAppStore.getState().mountedSpaceObservations[f.key]!.snapshot).toBe(before)
  expect(useAppStore.getState().mountedSpaceInputs).toBe(inputs)
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('same raw IDs remain source qualified and malformed or other Runtime private input stays opaque', async () => {
  const f = await mountedFixture(), snapshot = await f.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  const other = { unknownFutureInput: ['retain', { exact: 'bytes' }] }, inputs = { [f.key]: { target: f.target, drafts: {} }, foreign: other }
  useAppStore.setState({ mountedSpaceInputs: inputs })
  useAppStore.getState().editSpaceMountDraft(f.key, f.tabId, f.regionId, 'exact B input')
  expect((useAppStore.getState().mountedSpaceInputs as Record<string, unknown>).foreign).toBe(other)
  expect(() => useAppStore.getState().editSpaceMountDraft('foreign', f.tabId, f.regionId, 'overwrite')).toThrow('unreadable')
  expect(acceptsMountedSnapshot(f.target, { ...snapshot, source: { ...snapshot.source, runtimeId: 'A-runtime' } })).toBe(false)
  expect(() => useAppStore.getState().observeSpaceMount(f.target, { snapshot: { ...snapshot, reference: { ...snapshot.reference, runtimeId: 'A-runtime' } }, reading: false })).toThrow('another original source')
  expect(mountedRegionKey(f.target.reference, f.tabId, f.regionId)).not.toBe(mountedRegionKey({ ...f.target.reference, runtimeId: 'A-runtime' }, f.tabId, f.regionId))
})

it('the actual Host entry freezes the answering Core project and registers B before opening its exact Space', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, onClose = vi.fn(), localTabs = useAppStore.getState().tabs
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(f.api.call)
  // Native user-document acknowledgement is the only additional leaf here; the process proof exercises its file owner.
  const checkpoint = vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockImplementation(async () => {
    const values = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>)
    expect(values).toContainEqual(expect.objectContaining({ kind: 'folder-registration', submitted: true,
      registration: expect.objectContaining({ runtimeId: b.identity.runtimeId, workspaceId: b.workspace.id, expectedResource: { hostId: 'local', workspacePath: b.workspace.path, projectRootPath: b.workspace.path } }) }))
  })
  await dom.render(<HostOriginalSpaces host={{ id: b.id, kind: 'ssh', label: 'B original Core', hostname: 'private.invalid' }} active onClose={onClose} />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain(b.workspace.name) })
  const open = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Open original Space')!
  await act(async () => { open.click(); await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce()) })
  expect(checkpoint).toHaveBeenCalledOnce()
  const graph = (await b.store.read())!.graph, key = spaceMountKey({ runtimeId: b.identity.runtimeId, spaceId: graph.spaces[0]!.spaceId })
  expect(useAppStore.getState().selectedSpaceMount).toBe(key)
  expect(mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, key)!.target).toEqual({ hostId: b.id, reference: { runtimeId: b.identity.runtimeId, spaceId: graph.spaces[0]!.spaceId }, workspaceId: b.workspace.id, zoneId: graph.zones[0]!.zoneId })
  expect(useAppStore.getState().tabs).toBe(localTabs)
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('late registration confirmation saves its original reference without replacing later navigation', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, close = vi.fn()
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve }), call = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    const reply = await f.api.call(method, input, signal)
    if (method === 'register') await pending
    return reply
  })
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  const host = { id: b.id, kind: 'ssh' as const, label: 'Original B', hostname: 'private.invalid' }
  await dom.render(<HostOriginalSpaces host={host} active onClose={close} />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain(b.workspace.name) })
  const button = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === 'Open original Space')!
  await act(async () => { button.click(); await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === 'register')).toBe(true)) })
  await dom.render(<HostOriginalSpaces host={host} active={false} onClose={close} />)
  const later = 'later-source-selection'
  useAppStore.setState({ selectedSpaceMount: later, mainSurface: 'agents' })
  await act(async () => { finish(); await pending; await vi.waitFor(async () => expect(await b.store.read()).not.toBeNull()) })
  await vi.waitFor(async () => { await act(async () => {}); expect(Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>).some(value => Boolean(value && typeof value === 'object' && 'target' in value))).toBe(true) })
  expect(useAppStore.getState().selectedSpaceMount).toBe(later)
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(close).not.toHaveBeenCalled()
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('an unknown original registration is inspected without replay and a current exact Space can be opened independently of the lost write receipt', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, calls: string[] = []
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    calls.push(method)
    const reply = await f.api.call(method, input, signal)
    if (method === 'register') throw new Error('Original response lost after source save')
    return reply
  })
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  await dom.render(<HostOriginalSpaces host={{ id: b.id, kind: 'ssh', label: 'Original B', hostname: 'private.invalid' }} active />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain(b.workspace.name) })
  const click = async (text: string) => { const button = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!; expect(button).toBeTruthy(); await act(async () => button.click()) }
  await click('Open original Space')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Original response lost after source save') })
  const retained = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>).find(value => Boolean(value && typeof value === 'object' && 'registration' in value)) as { hostId: string; registration: import('@agentmux/core/space-folder').FolderSpaceRegistration }
  expect(await f.api.call('inspectRegistration', { hostId: retained.hostId, registration: retained.registration })).not.toBeNull()
  await click('Inspect original registration')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('does not confirm the original write response') })
  await click('Open found original Space')
  expect(calls.filter(method => method === 'register')).toHaveLength(1)
  expect(calls).toContain('inspectRegistration')
  const graph = (await b.store.read())!.graph
  expect(useAppStore.getState().selectedSpaceMount).toBe(spaceMountKey({ runtimeId: b.identity.runtimeId, spaceId: graph.spaces[0]!.spaceId }))
  expect(Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>)).toContainEqual(expect.objectContaining({ submitted: true, kind: 'folder-registration' }))
})

it('a cold unavailable source keeps its exact private positions and editable unsent input without inventing a Session', async () => {
  const f = await mountedFixture()
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Original B tab')) })
  const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Mounted Space task draft"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Unsent B original draft'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  const held = mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, f.key)!
  expect(held.view).toBeTruthy()
  await dom.render(null)
  vi.mocked(api.spaceMounts.watch).mockRejectedValue(new Error('Original source is unavailable'))
  useAppStore.setState({ mountedSpaceObservations: {} })
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  expect(dom.container.textContent).toContain('Original Region kept')
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Unsent B original draft')
  expect(dom.container.textContent).toContain(f.b.identity.runtimeId)
  expect(dom.container.textContent).not.toContain('Original Agent')
})

it('source absence keeps the last confirmed members and private input, independently of the current missing observation', async () => {
  const f = await mountedFixture()
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Original B tab')) })
  const before = (await f.b.store.read())!, graph = structuredClone(before.graph)
  graph.spaces = []; graph.zones = []; graph.tabs = []; graph.regions = []; graph.bindings = []
  await act(async () => {
    await f.b.store.commit({ expectedRevision: before.revision, graph, allowEntityRemoval: true })
    await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[f.key]?.snapshot?.scope.space).toBeNull())
  })
  expect(dom.container.textContent).toContain('Original B tab')
  expect(dom.container.textContent).toContain('last confirmed members and private input are kept')
  expect(useAppStore.getState().mountedSpaceObservations[f.key]!.lastPresentSnapshot!.scope.regions[0]!.regionId).toBe(f.regionId)
})

it('the actual window shortcut owner selects only the qualified private view and never falls back to the parked A Launcher', async () => {
  const f = await mountedFixture(), snapshot = await f.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  const localTab = createWorkbenchTab('local-tab', { kind: 'launcher', regionId: 'local-region', workspaceId: 'workspace' })
  const layouts = { workspace: createWorkspaceLayout('local-group', ['local-tab']) }, tabs = { [localTab.id]: localTab }
  useAppStore.setState({ tabs, layouts, activeWorkspaceId: 'workspace' })
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target, { snapshot, reading: false })
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher')
  expect(dispatchWorkbenchCommand({ kind: 'new-tab' }, useAppStore.getState())).toBe(false)
  expect(open).not.toHaveBeenCalled()
  expect(dispatchWorkbenchCommand({ kind: 'select-tab', ordinal: 1 }, useAppStore.getState())).toBe(true)
  expect(mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, f.key)!.view!.selection).toMatchObject({ tabId: f.tabId, regionId: f.regionId })
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
})

it('an unreadable private layout cannot take away a healthy original source read or overwrite that private input', async () => {
  const f = await mountedFixture(), malformed = { target: f.target, drafts: { retained: 'Original input' }, view: { originalBytes: ['do', 'not', 'rewrite'] } }
  useAppStore.setState({ mountedSpaceInputs: { [f.key]: malformed }, mountedSpaceObservations: {} })
  useAppStore.getState().selectSpaceMount(f.key)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[f.key]?.snapshot?.scope.regions[0]?.regionId).toBe(f.regionId)) })
  expect(dom.container.textContent).toContain('unreadable')
  expect(dom.container.textContent).toContain(f.b.identity.runtimeId)
  expect(dom.container.querySelector('textarea')).toBeNull()
  expect((useAppStore.getState().mountedSpaceInputs as Record<string, unknown>)[f.key]).toBe(malformed)
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('the real two-Core original Session metadata reaches the registered Main and Window without borrowing A same-SID state', async () => {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const source = await createSpaceSessionsFixture(cleanup), sid = 'shared-member'
  await source.d.put(sid); await source.admit('D-in-B', 'runtime-d', sid, 'original-source-member-operation')
  const carrier = { forwardRpc: source.b.rpc.call.bind(source.b.rpc), subscribeRpc: source.b.rpc.subscribe.bind(source.b.rpc) }
  const f = spaceMountTransport(cleanup, [{ id: 'saved-b', carrier }])
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(f.api.watch)
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(f.api.sessions)
  const snapshot = await f.api.call('snapshot', { hostId: 'saved-b', reference: source.reference }), zone = snapshot.scope.zones[0]!
  const target: SpaceMountRecord = { hostId: 'saved-b', reference: source.reference, zoneId: zone.zoneId, workspaceId: zone.workspaceId }
  const sessions = [{ ...useAppStore.getState().sessions[0]!, id: sid, label: 'A local same SID remains original' }]
  useAppStore.setState({ sessions }); useAppStore.getState().mountSpace(target)
  const key = spaceMountKey(target.reference)
  await dom.render(<MountedSpaceWorkbench mountKey={key} visible />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.querySelector('.mounted-session-metadata span')?.textContent).toContain('codex')) })
  expect(dom.container.textContent).not.toContain('Original Session observed')
  expect(dom.container.textContent).not.toContain('this window owns only its reader and draft')
  expect(dom.container.querySelector('.mounted-session-metadata strong')).toBeNull()
  expect(dom.container.querySelector('.mounted-session-metadata summary')?.textContent).toBe('Session observation')
  expect(dom.container.querySelector('.mounted-session-metadata details')?.textContent).toContain('runtime-d-run-' + sid)
  const observed = () => Object.values(useAppStore.getState().mountedSpaceSessions[key]!.members).find(fact => fact.member.runtimeId === 'runtime-d')!
  expect(observed().state).toMatchObject({ status: 'observed', authority: { runtimeId: 'runtime-d' }, session: { agentSessionId: sid, updatedAt: 1 } })
  const inputs = useAppStore.getState().mountedSpaceInputs, partialize = useAppStore.persist.getOptions().partialize!, persisted = partialize(useAppStore.getState())
  await act(async () => { await source.d.put(sid, 2); await vi.waitFor(() => expect(observed().state).toMatchObject({ status: 'observed', session: { updatedAt: 2 } })) })
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().mountedSpaceInputs).toBe(inputs)
  expect(partialize(useAppStore.getState())).toBe(persisted)
  await dom.render(<MountedSpaceWorkbench mountKey={key} visible={false} />)
  await vi.waitFor(() => expect(f.renderer.listenerCount('spaceMounts:sessionsEvent')).toBe(0))
  expect((await source.d.core.readAgentSession(sid))!.run.runId).toBe('runtime-d-run-' + sid)
})

it('a failed metadata reader cannot remove a healthy original business member or fall back to A Session state', async () => {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const source = await createSpaceSessionsFixture(cleanup), sid = 'retained-original-member'
  await source.d.put(sid); await source.admit('D-in-B', 'runtime-d', sid, 'retained-original-member-operation')
  const f = spaceMountTransport(cleanup, [{ id: 'saved-b', carrier: { forwardRpc: source.b.rpc.call.bind(source.b.rpc), subscribeRpc: source.b.rpc.subscribe.bind(source.b.rpc) } }])
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(f.api.call)
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(f.api.watch)
  vi.spyOn(api.spaceMounts, 'sessions').mockRejectedValue(new Error('Original scoped metadata source unavailable'))
  const snapshot = await f.api.call('snapshot', { hostId: 'saved-b', reference: source.reference }), zone = snapshot.scope.zones[0]!
  const target = { hostId: 'saved-b', reference: source.reference, zoneId: zone.zoneId, workspaceId: zone.workspaceId }, key = spaceMountKey(target.reference)
  const originalSessions = useAppStore.getState().sessions
  useAppStore.getState().mountSpace(target)
  await dom.render(<MountedSpaceWorkbench mountKey={key} visible />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.querySelector('[data-source-region]')).not.toBeNull()) })
  expect(dom.container.textContent).toContain(sid)
  expect(dom.container.textContent).toContain('Original scoped metadata source unavailable')
  const stage = dom.container.querySelector<HTMLElement>('[data-source-region] .full-page-loading')!
  await vi.waitFor(() => expect(stage.dataset.loadingPhase).toBe('parked'))
  expect(stage.textContent).toContain('Agent creation unconfirmed')
  expect(stage.textContent).toContain('retained-original-member-operation')
  expect(stage.dataset.loadingPhase).toBe('parked')
  expect(stage.getAttribute('aria-busy')).toBe('false')
  expect(useAppStore.getState().sessions).toBe(originalSessions)
  expect((await source.d.core.readAgentSession(sid))!.run.runId).toBe('runtime-d-run-' + sid)
})

async function setMountedTaskDraft(text: string) {
  const field = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Mounted Space task draft"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })) })
}

it.each(['unknown', 'check-failed'] as const)('mounted new work uses the original project and exact target inventory while optional Host choices are pending (%s)', async availability => {
  const f = await mountedFixture(), snapshot = await f.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  const sourceTabs = useAppStore.getState().tabs
  useAppStore.getState().mountSpace(f.target)
  const inventory = { routeHostId: 'local', runtimeId: f.b.identity.runtimeId, executors: [{ executorId: 'only-b', label: 'B original configuration', providerId: 'codex', command: '/original/B/codex', source: 'registered' as const, configRevision: 'B-revision', availability, ...(availability === 'check-failed' ? { cause: { code: 'OBSERVATION_UNAVAILABLE', message: 'Original executable observation did not complete' } } : {}) }] }
  const calls: Array<{ method: string; input: unknown }> = []
  // Discovery and creation are external leaves in this focused UI test; the joined
  // Native proof uses the real original Host creator with this same fixed port.
  vi.mocked(api.spaceMounts.call).mockImplementation(async (method, input, signal) => {
    calls.push({ method, input })
    if (method === 'hostChoices') return await new Promise<never>(() => {})
    if (method === 'executors') return inventory as never
    if (method === 'open') { const original = input as import('../src/shared/space-mount').SpaceMountMethods['open']['input']; return { operationId: original.request.operationId, outcome: 'unknown', from: null, to: null, agent: null, resource: null, save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: null }, issues: [] } as never }
    return await f.api.call(method, input, signal)
  })
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockImplementation(async () => {
    const input = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>).find(value => !!value && typeof value === 'object' && 'kind' in value && value.kind === 'agent-open')
    expect(input).toMatchObject({ submitted: true, target: f.target, request: { destination: { spaceId: f.target.reference.spaceId, zoneId: snapshot.scope.zones[0]!.zoneId, newTab: true }, focus: false } })
    expect(calls.some(call => call.method === 'open')).toBe(false)
  })
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[aria-label="Original Space Agent configuration"]')?.textContent).toContain('B original configuration') })
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent configuration"]')!
  await act(async () => { select.value = 'only-b'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await setMountedTaskDraft('Submit this exact private B task')
  const start = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start in original Space')!
  expect(start.disabled).toBe(false)
  await act(async () => { start.click(); await vi.waitFor(() => expect(calls.filter(call => call.method === 'open')).toHaveLength(1)) })
  expect(calls.find(call => call.method === 'executors')?.input).toEqual({ hostId: f.target.hostId, reference: f.target.reference, agentHostId: 'local' })
  expect(calls.find(call => call.method === 'open')?.input).toMatchObject({ hostId: f.target.hostId, reference: f.target.reference,
    request: { content: { executorId: 'only-b', agentTarget: { hostId: 'local', runtimeId: f.b.identity.runtimeId }, prompt: 'Submit this exact private B task' }, destination: { spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, newTab: true } } })
  expect(useAppStore.getState().tabs).toBe(sourceTabs)
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('unknown mounted creation retains its original request and later draft; remount checks without replay', async () => {
  const f = await mountedFixture(), inventory = { routeHostId: 'local', runtimeId: f.b.identity.runtimeId, executors: [{ executorId: 'b-executor', label: 'Original executor', providerId: 'codex', command: '/B/codex', source: 'registered' as const, configRevision: 'v1', availability: 'available' as const, executable: '/B/codex' }] }
  const opened: unknown[] = [], inspected: unknown[] = []
  vi.mocked(api.spaceMounts.call).mockImplementation(async (method, input, signal) => {
    if (method === 'executors') { const hostId = (input as import('../src/shared/space-mount').SpaceMountMethods['executors']['input']).agentHostId; return { ...inventory, routeHostId: hostId, runtimeId: hostId === 'local' ? f.b.identity.runtimeId : f.b.id + '-remote-runtime' } as never }
    if (method === 'open') { opened.push(input); throw Error('Original reply was not received') }
    if (method === 'inspect') { inspected.push(input); return await f.api.call('inspect', input as import('../src/shared/space-mount').SpaceMountMethods['inspect']['input'], signal) }
    return await f.api.call(method, input, signal)
  })
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[aria-label="Original Space Agent configuration"]')?.textContent).toContain('Original executor') })
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent configuration"]')!
  await act(async () => { select.value = 'b-executor'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  const host = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent device"]')!
  await vi.waitFor(async () => { await act(async () => {}); expect(Array.from(host.options).some(option => option.value === JSON.stringify(['host', f.b.id + '-original-remote']))).toBe(true) })
  await act(async () => { host.value = JSON.stringify(['host', f.b.id + '-original-remote']); host.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(async () => { await act(async () => {}); expect(select.textContent).toContain('Original executor') })
  await act(async () => { select.value = 'b-executor'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await setMountedTaskDraft('Original frozen task')
  const start = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start in original Space')!
  await act(async () => { start.click(); await vi.waitFor(() => expect(dom.container.textContent).toContain('The original task result is unknown')) })
  await setMountedTaskDraft('Later unsent task must stay')
  const original = (opened[0] as import('../src/shared/space-mount').SpaceMountMethods['open']['input']).request
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible={false} />)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  expect(dom.container.textContent).toContain('The original task result is unknown')
  const inspect = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Check original task')!
  await act(async () => { inspect.click(); await vi.waitFor(() => expect(inspected).toHaveLength(1)) })
  expect(inspected[0]).toEqual({ hostId: f.target.hostId, reference: f.target.reference, requestId: original.operationId })
  expect(opened).toHaveLength(1)
  expect(original.content).toMatchObject({ prompt: 'Original frozen task', agentTarget: { hostId: f.b.id + '-original-remote', runtimeId: f.b.id + '-remote-runtime' } })
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Later unsent task must stay')
  expect(useAppStore.getState().selectedSpaceMount).toBe(f.key)
})

it('an empty original Folder can prepare new work privately without manufacturing a source Tab or Region', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(f.api.watch)
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    if (method === 'executors') return { routeHostId: 'local', runtimeId: b.identity.runtimeId, executors: [] } as never
    return await f.api.call(method, input, signal)
  })
  const resources = await f.api.call('resources', { hostId: b.id }), project = resources.workspaces[0]!
  const receipt = await f.api.call('register', { hostId: b.id, registration: { runtimeId: b.identity.runtimeId, workspaceId: project.workspaceId, expectedResource: { hostId: project.hostId, workspacePath: project.path, projectRootPath: project.repoPath ?? project.path } } })
  const target = { hostId: b.id, reference: receipt.reference, zoneId: receipt.zoneId, workspaceId: receipt.workspaceId }, key = spaceMountKey(target.reference), before = (await b.store.read())!
  useAppStore.getState().mountSpace(target)
  await dom.render(<MountedSpaceWorkbench mountKey={key} visible />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('No original member is selected') })
  const action = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'New work')!
  await act(async () => action.click())
  const field = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="New mounted Space task draft"]')!
  expect(field).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Unsent private task on the original empty project'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState()).mountedSpaceInputs).toBe(useAppStore.getState().mountedSpaceInputs)
  expect((await b.store.read())!.graph).toEqual(before.graph)
  expect((await b.store.read())!.graph.tabs).toHaveLength(0)
  expect((await b.store.read())!.graph.regions).toHaveLength(0)
  await act(async () => action.click())
  await act(async () => action.click())
  expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="New mounted Space task draft"]')!.value).toBe('Unsent private task on the original empty project')
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('a failed native checkpoint retains the exact unsent mounted task and only a later explicit click sends that original request', async () => {
  const f = await mountedFixture(), opened: unknown[] = []
  vi.mocked(api.spaceMounts.call).mockImplementation(async (method, input, signal) => {
    if (method === 'executors') return { routeHostId: 'local', runtimeId: f.b.identity.runtimeId, executors: [{ executorId: 'exact', label: 'Exact source executor', providerId: 'codex', command: '/B/codex', source: 'registered', configRevision: 'v1', availability: 'available', executable: '/B/codex' }] } as never
    if (method === 'open') { opened.push(input); const original = input as import('../src/shared/space-mount').SpaceMountMethods['open']['input']; return { operationId: original.request.operationId, outcome: 'unknown' } as never }
    return await f.api.call(method, input, signal)
  })
  const checkpoint = vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockRejectedValue(Error('Private user-document writer unavailable'))
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Exact source executor') })
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent configuration"]')!
  await act(async () => { select.value = 'exact'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await setMountedTaskDraft('Keep this task and original operation')
  const start = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start in original Space')!
  await act(async () => start.click())
  expect(opened).toHaveLength(0)
  expect(dom.container.textContent).toContain('The task was not sent')
  const saved = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>).find(value => !!value && typeof value === 'object' && 'kind' in value && value.kind === 'agent-open') as import('../src/renderer/src/lib/space-mount-launch').MountedAgentOpenInput
  expect(saved.submitted).toBe(false)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible={false} />)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  expect(opened).toHaveLength(0)
  checkpoint.mockResolvedValue(undefined)
  const send = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Send original task')!
  await act(async () => send.click())
  expect(opened).toEqual([{ hostId: f.target.hostId, reference: f.target.reference, request: saved.request }])
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this task and original operation')
  expect(dom.container.textContent).not.toContain('The task was not sent')
})

it('a foreign original project defaults to its own B-realm Agent device instead of the source Core or A local', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, { writeFile } = await import('node:fs/promises')
  const project = { id: 'original-c-project', hostId: 'C-in-B', name: 'C original project', path: '/original/C/project' }
  await writeFile(b.configurationPath, JSON.stringify({ workspaces: [project], hosts: [{ id: 'local', kind: 'local', label: 'B original Node' }, { id: 'C-in-B', kind: 'ssh', label: 'C project device', hostname: 'private-c.invalid', runtimeId: 'original-C-runtime' }] }))
  const registered = await f.api.call('register', { hostId: b.id, registration: { runtimeId: b.identity.runtimeId, workspaceId: project.id, expectedResource: { hostId: project.hostId, workspacePath: project.path, projectRootPath: project.path } } })
  const target = { hostId: b.id, reference: registered.reference, zoneId: registered.zoneId, workspaceId: registered.workspaceId }, key = spaceMountKey(target.reference), requested: string[] = []
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(f.api.watch)
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    if (method === 'executors') { const hostId = (input as import('../src/shared/space-mount').SpaceMountMethods['executors']['input']).agentHostId; requested.push(hostId); return { routeHostId: hostId, runtimeId: 'original-C-runtime', executors: [] } as never }
    return await f.api.call(method, input, signal)
  })
  useAppStore.getState().mountSpace(target)
  await dom.render(<MountedSpaceWorkbench mountKey={key} visible />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('C original project') })
  await act(async () => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'New work')!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(requested).toEqual(['C-in-B']) })
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent device"]')!.value).toBe(JSON.stringify(['host', 'C-in-B']))
  expect(dom.container.textContent).toContain(project.path)
  expect(await f.cores[0]!.store.read()).toBeNull()
})

it('the real inspect.client and strict observation schema report the mounted display separately from parked A selection without private text', async () => {
  const f = await mountedFixture(), { desktopWorkbenchObservationSchema } = await import('../src/shared/client-observation')
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Original B tab') })
  await setMountedTaskDraft('PRIVATE_TEXT_MUST_NOT_ENTER_THE_DISPLAY_OBSERVATION')
  const root = dom.container.querySelector<HTMLElement>('[data-mounted-space]')!, field = root.querySelector<HTMLTextAreaElement>('textarea')!
  const rect = { x: 0, y: 0, width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, toJSON: () => ({}) }
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(rect)
  field.focus()
  const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'observe-source-display', operation: 'inspect.client' })
  expect(result.operation).toBe('inspect.client')
  if (result.operation !== 'inspect.client') throw Error('Expected the original client observation owner')
  const value = desktopWorkbenchObservationSchema.parse(result.observation)
  expect(value.mountedSpace).toMatchObject({ target: { hostId: f.target.hostId, reference: f.target.reference },
    selection: { tabId: f.tabId, regionId: f.regionId }, presentation: 'visible', input: { kind: 'textarea', connected: true, visible: true, inert: false } })
  expect(value.desktop.selection.space?.spaceId).not.toBe(f.target.reference.spaceId)
  expect(JSON.stringify(value.mountedSpace)).not.toContain('PRIVATE_TEXT_MUST_NOT_ENTER_THE_DISPLAY_OBSERVATION')
  const { mountedSpace, ...legacy } = value
  expect(desktopWorkbenchObservationSchema.parse(legacy).mountedSpace).toBeUndefined()
  await dom.render(<MountedSpaceWorkbench mountKey={f.key} visible={false} />)
  const hidden = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'observe-hidden-source', operation: 'inspect.client' })
  if (hidden.operation !== 'inspect.client') throw Error('Expected original observation')
  expect(desktopWorkbenchObservationSchema.parse(hidden.observation).mountedSpace).toMatchObject({ target: { reference: f.target.reference }, presentation: 'hidden' })
})

it('mounted display observation keeps source identity unknown instead of borrowing A or adopting a malformed other-source alias', async () => {
  const { observeMountedSpaceWindow } = await import('../src/renderer/src/lib/mounted-space-observation'), { desktopWorkbenchObservationSchema } = await import('../src/shared/client-observation')
  const f = await mountedFixture(), entries = { [f.key]: { target: { ...f.target, reference: { ...f.target.reference, runtimeId: 'another-original-Core' } }, drafts: {} } }
  const value = observeMountedSpaceWindow({ selectedSpaceMount: f.key, mountedSpaceInputs: entries, mountedSpaceObservations: {} })
  expect(value).toEqual({ target: null, selection: null, presentation: 'unknown', input: { kind: 'unknown' } })
  const future = { [f.key]: { target: { ...f.target, privateFutureTarget: 'retain privately', reference: { ...f.target.reference, privateFutureReference: 'do not expose' } }, drafts: {} } }
  const readable = observeMountedSpaceWindow({ selectedSpaceMount: f.key, mountedSpaceInputs: future, mountedSpaceObservations: {} })
  expect(readable?.target).toEqual({ hostId: f.target.hostId, reference: f.target.reference })
  expect(JSON.stringify(readable)).not.toContain('do not expose')
  expect(observeMountedSpaceWindow({ selectedSpaceMount: null, mountedSpaceInputs: entries, mountedSpaceObservations: {} })).toBeNull()
  expect(observeMountedSpaceWindow({ selectedSpaceMount: undefined, mountedSpaceInputs: entries, mountedSpaceObservations: {} })).toBeUndefined()
  const original = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'read-original-observation-shape', operation: 'inspect.client' })
  if (original.operation !== 'inspect.client') throw Error('Expected original observation')
  expect(() => desktopWorkbenchObservationSchema.parse({ ...original.observation, mountedSpace: { ...value, prompt: 'must not enter the observation' } })).toThrow()
})

it.each(['source','slot'] as const)('a pending original open cannot swallow an explicit Start after changing the exact %s',async change=>{
 const {MountedSpaceLauncher}=await import('../src/renderer/src/components/MountedSpaceLauncher')
 const {mountedAgentOpenKey,mountedAgentOpenInput}=await import('../src/renderer/src/lib/space-mount-launch')
 const f=await mountedFixture(),firstSnapshot=await f.api.call('snapshot',{hostId:f.target.hostId,reference:f.target.reference}),firstProject=firstSnapshot.scope.zones[0]!
 const resources=await f.api.call('resources',{hostId:'local'}),resource=resources.workspaces[0]!
 const registered=await f.api.call('register',{hostId:'local',registration:{runtimeId:resources.runtimeId,workspaceId:resource.workspaceId,expectedResource:{hostId:resource.hostId,workspacePath:resource.path,projectRootPath:resource.repoPath??resource.path}}})
 const other={hostId:'local',reference:registered.reference,zoneId:registered.zoneId,workspaceId:registered.workspaceId},otherSnapshot=await f.api.call('snapshot',{hostId:'local',reference:other.reference})
 useAppStore.getState().mountSpace(f.target);useAppStore.getState().mountSpace(other,false)
 const firstSlot={kind:'new-work' as const,zoneId:f.target.zoneId},secondTarget=change==='source'?other:f.target
 const secondSlot=change==='source'?{kind:'new-work' as const,zoneId:other.zoneId}:{kind:'region' as const,tabId:f.tabId,regionId:f.regionId}
 const secondProject=change==='source'?otherSnapshot.scope.zones[0]!:firstProject
 const requests:Array<import('../src/shared/space-mount').SpaceMountMethods['open']['input']>=[];let failOriginal:(reason:Error)=>void=()=>{}
 const inspected:unknown[]=[]
 vi.mocked(api.spaceMounts.call).mockImplementation(async(method,input,signal)=>{
  if(method==='executors'){const p=input as import('../src/shared/space-mount').SpaceMountMethods['executors']['input'];return{routeHostId:p.agentHostId,runtimeId:p.hostId==='local'?resources.runtimeId:f.b.identity.runtimeId,executors:[{executorId:'exact-only',label:'Exact source configuration',providerId:'codex',command:'/private/exact-cli',source:'registered',configRevision:'exact-source-revision',availability:'unknown'}]}as never}
  if(method==='open'){const p=input as import('../src/shared/space-mount').SpaceMountMethods['open']['input'];requests.push(p);if(requests.length===1)return await new Promise<never>((_,reject)=>{failOriginal=reject});return{operationId:p.request.operationId,outcome:'unknown',from:null,to:null,agent:null,resource:null,save:{layoutApplied:false,clientStateWritten:false,storageFlushRequested:false,diskDurability:'unconfirmed',reason:null},issues:[]}as never}
  if(method==='inspect')inspected.push(input)
  return await f.api.call(method,input,signal)
 })
 vi.spyOn(storeModule,'checkpointMountedSpaceInputs').mockResolvedValue()
 async function prepare(target:SpaceMountRecord,slot:import('../src/renderer/src/lib/space-mount-launch').MountedLauncherSlot,project:typeof firstProject){
  await dom.render(<MountedSpaceLauncher target={target} slot={slot} project={project} mountKey={spaceMountKey(target.reference)} active draft="Second exact task"/>)
  await vi.waitFor(async()=>{await act(async()=>{});expect(dom.container.querySelector('[aria-label="Original Space Agent configuration"]')?.textContent).toContain('Exact source configuration')})
  const select=dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent configuration"]')!
  await act(async()=>{select.value='exact-only';select.dispatchEvent(new Event('change',{bubbles:true}))})
 }
 async function start(){const button=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(x=>x.textContent==='Start in original Space')!;expect(button.disabled).toBe(false);await act(async()=>button.click())}
 await prepare(f.target,firstSlot,firstProject);await start();await vi.waitFor(()=>expect(requests).toHaveLength(1))
 const first=requests[0]!,firstKey=mountedAgentOpenKey(f.target,firstSlot)
 await prepare(secondTarget,secondSlot,secondProject);await start();await vi.waitFor(()=>expect(requests).toHaveLength(2))
 expect(requests[1]).toMatchObject({hostId:secondTarget.hostId,reference:secondTarget.reference,request:{destination:{spaceId:secondTarget.reference.spaceId,zoneId:secondTarget.zoneId}}})
 expect(requests[1]!.request.operationId).not.toBe(first.request.operationId)
 await act(async()=>failOriginal(Error('First original open reply lost')))
 await vi.waitFor(()=>expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs,firstKey)?.issue).toContain('First original open reply lost'))
 expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs,firstKey)?.request).toBe(first.request)
 await prepare(f.target,firstSlot,firstProject)
 const check=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(x=>x.textContent==='Check original task')!
 await act(async()=>check.click());await vi.waitFor(()=>expect(inspected).toHaveLength(1))
 expect(inspected[0]).toEqual({hostId:f.target.hostId,reference:f.target.reference,requestId:first.request.operationId});expect(requests).toHaveLength(2)
})

it('the real Window Store keeps healthy members and private workface when a future association has no execution identity', async () => {
  const f = await mountedFixture(), source = await f.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
  // Controlled incoming DTOs exercise the existing Store entry. This does not
  // claim this Main's Core produces the future association observation.
  const snapshot = { ...source, scope: { ...source.scope, regions: source.scope.regions.map(region => ({ ...region,
    kind: 'agent' as const, agentSessionId: 'original-healthy-SID', runId: 'original-healthy-Run',
    execution: { hostId: 'local', cwd: '/original/project', runtimeId: f.target.reference.runtimeId } })) } }
  const localTab = createWorkbenchTab('original-local-tab', { kind: 'launcher', regionId: 'original-local-region', workspaceId: 'workspace' })
  const tabs = { [localTab.id]: localTab }, layouts = { workspace: createWorkspaceLayout('original-local-group', [localTab.id]) }
  useAppStore.setState({ tabs, layouts, activeWorkspaceId: 'workspace' })
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target, { snapshot, reading: false })
  useAppStore.getState().editSpaceMountView(f.key, initialMountedSpaceView(snapshot))
  useAppStore.getState().editSpaceMountDraft(f.key, f.tabId, f.regionId, 'Keep the original unsent draft')
  const slot = { kind: 'region' as const, tabId: f.tabId, regionId: f.regionId }, requestKey = mountedAgentOpenKey(f.target, slot)
  const pending: MountedAgentOpenInput = { kind: 'agent-open', target: f.target, slot, submitted: true, request: {
    operationId: 'original-pending-OP', content: { kind: 'new-agent', executorId: 'codex' },
    destination: { spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false } }
  useAppStore.getState().retainSpaceMountAgentOpen(requestKey, () => pending)
  const opaque = { future: ['keep', 'original bytes'] }
  useAppStore.setState(state => ({ mountedSpaceInputs: { ...state.mountedSpaceInputs as Record<string, unknown>, 'opaque-neighbor': opaque } }))
  const opening = { reference: f.target.reference, source: snapshot.source, revision: snapshot.revision }
  const healthy = JSON.parse(JSON.stringify({ ...opening, type: 'member',
    member: { hostId: 'local', runtimeId: f.target.reference.runtimeId, agentSessionId: 'original-healthy-SID' },
    state: { status: 'observed', authority: snapshot.source, session: { agentSessionId: 'original-healthy-SID', hostId: 'local',
      providerId: 'codex', executorId: 'codex', workspacePath: '/original/project', run: { runId: 'original-healthy-Run' },
      createdAt: 1, updatedAt: 1 } } }))
  useAppStore.getState().observeSpaceMountSessions(f.target, { observation: healthy })
  const before = useAppStore.getState(), metadata = before.mountedSpaceSessions[f.key]!
  expect(Object.keys(metadata.members)).toHaveLength(1)
  expect(Object.keys(metadata.lastConfirmed)).toHaveLength(1)
  expect(Object.values(metadata.members)[0]?.state.status).toBe('observed')
  for (const code of ['SPACE_SESSION_REFERENCE_UNAVAILABLE', 'SPACE_SESSION_REFERENCE_UNCONFIRMED']) {
    // Same no-SID shape as the independent public watch in the Core association
    // test: association locator and issue only, never a fabricated member.
    const association = JSON.parse(JSON.stringify({ ...opening, type: 'association',
      association: { regionId: 'original-associated-region', operationId: 'original-association-L' },
      state: { status: 'unavailable', issue: { code, message: 'Original association observation unavailable; keep its L.' } } }))
    expect(association).not.toHaveProperty('member')
    expect(association).not.toHaveProperty('runtimeId')
    expect(association).not.toHaveProperty('agentSessionId')
    expect(() => useAppStore.getState().observeSpaceMountSessions(f.target, { observation: association })).not.toThrow()
    const after = useAppStore.getState(), current = after.mountedSpaceSessions[f.key]!
    expect(current.members).toBe(metadata.members); expect(current.lastConfirmed).toBe(metadata.lastConfirmed)
    expect(after.mountedSpaceObservations).toBe(before.mountedSpaceObservations)
    expect(after.mountedSpaceObservations[f.key]!.snapshot).toBe(snapshot)
    expect(after.mountedSpaceInputs).toBe(before.mountedSpaceInputs)
    expect(mountedAgentOpenInput(after.mountedSpaceInputs, requestKey)).toBe(pending)
    expect((after.mountedSpaceInputs as Record<string, unknown>)['opaque-neighbor']).toBe(opaque)
    expect(mountedSpaceInput(after.mountedSpaceInputs, f.key)!.view).toBe(mountedSpaceInput(before.mountedSpaceInputs, f.key)!.view)
    expect(mountedSpaceInput(after.mountedSpaceInputs, f.key)!.drafts[mountedRegionKey(f.target.reference, f.tabId, f.regionId)]).toBe('Keep the original unsent draft')
    expect(after.tabs).toBe(tabs); expect(after.layouts).toBe(layouts)
    expect(after.sessions).toBe(before.sessions); expect(after.selectedSpaceMount).toBe(before.selectedSpaceMount)
  }
})
