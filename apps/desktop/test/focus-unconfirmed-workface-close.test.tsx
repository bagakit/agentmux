// @vitest-environment happy-dom
import { act } from 'react'
import { removeTab, splitWorkbenchRegion } from '@agentmux/layout'
import { requestWorkbenchReferenceClose } from '../src/renderer/src/lib/workbench-close-request'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { rm } from 'node:fs/promises'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkbenchCloseRequests } from '../src/renderer/src/hooks/useWorkbenchTabsClose'
import { api } from '../src/renderer/src/lib/api'
import { confirmedOriginalRawLocations, ordinaryAgentSpaceMember, useAppStore } from '../src/renderer/src/store'
import { desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { createDesktopWorkbenchCloseOwner } from '../src/main/workbench-close-owner'
import { spaceMountKey } from '../src/shared/space-mount'
import { focusSourceContextId } from '../src/renderer/src/lib/focus-source-model'
import { spaceCloseDigest } from '@agentmux/core/space-close'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = [], SID = 'original-unconfirmed-close'
afterEach(async () => { await dom.render(null); for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
/** Real Core spatial/readers and original durable Main/Renderer close owner; Native process observation is the existing fixture leaf. */
async function fixture(execution: 'none' | 'runless' | 'known' = 'none', nonlocal = false, multiple = false, alias = false, observed = true, split = false, placement?: 'replaced' | 'unplaced') {
  vi.stubGlobal('crypto', webcrypto)
  const disposers: typeof cleanup = [], f = await createSpaceSessionsFixture(disposers)
  const privateRoots = new Set([f.b.root, f.d.root])
  cleanup.push(...disposers.map(close => async () => { try { await close() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || !privateRoots.has((error as NodeJS.ErrnoException).path!)) throw error; await rm((error as NodeJS.ErrnoException).path!, { recursive: true, force: true }) } }))
  const original = await (alias ? f.d : f.b).put(SID), admitted = await f.admit(alias ? 'D-in-B' : 'local', alias ? f.d.owner.runtimeId : f.b.owner.runtimeId, SID, 'original-close-admission')
  if (alias) await f.b.spatial.settleAgentOpen('original-close-admission', { agentSessionId: SID, run: original.run }, { agentPresentation: { sessionId: 'qualified-client-SID', agentSessionId: SID, hostId: 'D-in-B' } })
  await f.b.spatial.registerDirectory({ runtimeId: f.b.owner.runtimeId, directory: { hostId: 'local', workspacePath: '/b/project', projectRootPath: '/b/project', witness: { realPath: '/b/project', device: 'fixture-device', inode: 'fixture-inode' } } }, async () => [], async () => {})
  const saved = (await f.b.spatial.read())!, graph = structuredClone(saved.graph)
  graph.regions = graph.regions.map(region => { if (region.regionId !== admitted.address.regionId) return region; const { creationOperationId: _creation, ...retained } = region; return { ...retained, runId: execution === 'known' ? original.run.runId : null, execution: execution === 'none' ? null : region.execution } })
  // Import an existing raw occurrence without a creation binding, preserving the original Session and Run.
  if (execution !== 'known') {
    const oldId = admitted.address.regionId, nextId = 'unconfirmed-original-region'
    graph.tabs = graph.tabs.map(tab => tab.tabId === admitted.address.tabId ? { ...tab, regionIds: [nextId] } : tab)
    graph.regions = graph.regions.map(region => region.regionId === oldId ? { ...region, regionId: nextId } : region)
    graph.tabLayouts[admitted.address.tabId] = { root: { type: 'leaf', regionId: nextId }, activeRegionId: nextId }
    graph.resources['region:' + nextId] = graph.resources['region:' + oldId]!; delete graph.resources['region:' + oldId]
    admitted.address.regionId = nextId
  }
  if (placement === 'replaced') {
    const tab = graph.tabs.find(tab => tab.tabId === admitted.address.tabId)!
    tab.regionIds = ['replacement-browser-region']
    graph.regions.push({ tabId: tab.tabId, regionId: 'replacement-browser-region', kind: 'browser', browserId: 'replacement-browser', agentSessionId: null, runId: null, execution: null })
    graph.tabLayouts[tab.tabId] = { root: { type: 'leaf', regionId: 'replacement-browser-region' }, activeRegionId: 'replacement-browser-region' }
  }
  if (placement === 'unplaced') {
    const { displayWorkspaceId, groupId, tabId } = admitted.address
    graph.layouts[displayWorkspaceId] = removeTab(graph.layouts[displayWorkspaceId]!, groupId, tabId)
  }
  if (split) {
    const tab = graph.tabs.find(tab => tab.tabId === admitted.address.tabId)!
    tab.regionIds.push('retained-launcher-region')
    graph.regions.push({ tabId: tab.tabId, regionId: 'retained-launcher-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null })
    graph.resources['region:retained-launcher-region'] = {}
    graph.tabLayouts[tab.tabId] = splitWorkbenchRegion(graph.tabLayouts[tab.tabId]!, admitted.address.regionId, 'right', 'retained-launcher-region')
  }
  if (multiple) graph.layouts['second-display'] = { ...graph.layouts['original-b-project']!, groups: graph.layouts['original-b-project']!.groups.map(group => ({ ...group, id: 'second-group' })), root: { type: 'leaf', groupId: 'second-group' }, activeGroupId: 'second-group' }
  await f.b.spatial.commit({ expectedRevision: saved.revision, allowEntityRemoval: true, graph })
  const config = structuredClone(DEFAULT_CONFIG)
  config.hosts = [{ id: 'local', kind: 'local', label: 'Original device' }, { id: 'remote', kind: 'ssh', hostname: 'private.invalid', label: 'Different device' }]
  config.workspaces = [{ id: 'original-b-project', hostId: 'local', name: 'Original', kind: 'folder', path: '/b/project' }]
  const main = spaceMountTransport(cleanup, ['local', 'remote'].map(id => ({ id, carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } })), config)
  const sourceCalls = vi.spyOn(api.spaceMounts, 'call').mockImplementation(main.api.call)
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch); vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
  vi.spyOn(api.spaceMounts, 'member').mockImplementation(main.api.member); vi.spyOn(api.spaceMounts, 'reading').mockImplementation(main.api.reading)
  const user = new WorkbenchUserStateStore(join(f.b.root, 'private-user.json'))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read()); vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value)); vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  vi.spyOn(api.config, 'get').mockResolvedValue(config); vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader()); vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  const session = { ...composerSession(SID), ...(alias ? { id: 'qualified-client-SID', hostId: 'D-in-B', control: { kind: 'agent' as const, hostId: 'D-in-B', agentSessionId: SID, run: original.run } } : {}), workspacePath: '/b/project' }; const sessions = observed ? [session] : []
  vi.spyOn(api.sessions, 'timeline').mockResolvedValue({ agentSessionId: SID, revision: 0, items: [] } as never); vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] }); vi.spyOn(api.demands, 'list').mockResolvedValue([]); vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.b.spatial.readForLayout()); vi.spyOn(api.spatial, 'commit').mockImplementation(value => f.b.spatial.commit(value)); vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => f.b.spatial.subscribe(listener)); vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => f.b.spatial.retainDisplayLabels(values))
  const restored = desktopWorkbenchFromSpatial(graph)
  for (const tab of Object.values(restored.tabs)) for (const region of Object.values(tab.regions)) if (region.kind === 'agent') region.phase = 'attached'
  useAppStore.setState({ config, ...restored, sessions, loading: false, mainSurface: 'agents', focusView: 'list', mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {}, agentComposerDrafts: { [SID]: 'Original draft' }, error: null })
  // Hydrate accepted Core facts before arranging current Session observations; startup writers are outside this close proof.
  const arranged = useAppStore.getState(), dispose = await useAppStore.getState().initialize(); dispose(); useAppStore.setState(arranged, true)
  const target = { hostId: nonlocal ? 'remote' : 'local', reference: f.reference, zoneId: admitted.address.zoneId!, workspaceId: admitted.address.workspaceId! }
  useAppStore.getState().mountSpace(target, false)
  let bridge: DesktopControlIpcBridge
  bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation() {}, sendRequest(request) {
    void useAppStore.getState().executeWorkbenchClose(request as never).then(result => bridge.accept({ requestId: request.requestId, ok: true, result }), error => bridge.accept({ requestId: request.requestId, ok: false, error: { code: 'CONTROL_FAILED', message: error.message } }))
  } }); cleanup.push(() => bridge.dispose())
  const lifecycle = vi.fn(async () => { throw Error('A view-only close cannot touch Agent lifecycle') })
  const owner = createDesktopWorkbenchCloseOwner({ store: user, bridge, authority: () => ({ ownerId: spaceCloseDigest(user.path), endpoint: 'private-original', documentGeneration: 'private-renderer' }), runtime: { prepareWorkbenchCloseTerminal: lifecycle, callOriginalCore: lifecycle }, closeBrowser: lifecycle })
  const calls = vi.spyOn(api.workbenchClose, 'call').mockImplementation((method, params) => owner.call(method, params, { actor: { kind: 'user', id: 'private-user' }, originalContext: {} } as never))
  await dom.render(<><GlobalFocusSurface /><WorkbenchCloseRequests /></>)
  await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[spaceMountKey(f.reference)]?.snapshot?.scope.regions.some(region => region.tabId === admitted.address.tabId && region.regionId === admitted.address.regionId && region.agentSessionId === SID)).toBe(true))
  const sourceId = execution === 'none' ? JSON.stringify(['unconfirmed-region', f.reference, admitted.address.regionId]) : focusSourceContextId(alias ? f.d.owner.runtimeId : f.b.owner.runtimeId, SID)
  const card = () => [...dom.container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')].find(node => node.dataset.sessionId === sourceId)!
  if (placement !== 'replaced') await vi.waitFor(() => expect(card(), sourceId).toBeDefined())
  const close = async () => { await act(async () => card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))); const item = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Close workface…'); await vi.waitFor(() => expect(item()).toBeDefined()); await act(async () => item()!.click()) }
  return { ...f, original, admitted, target, calls, sourceCalls, lifecycle, card, close, tabId: admitted.address.tabId, regionId: admitted.address.regionId }
}
it('a retained Agent Region replaced by a Browser does not offer a current Focus workface', async () => {
  const f = await fixture('none', false, false, false, false, false, 'replaced')
  expect(f.card()).toBeUndefined()
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original draft')
  expect((await f.b.core.readAgentSession(SID))!.run).toEqual(f.original.run)
  await expect(api.spaceMounts.call('closeLocations', { hostId: f.target.hostId, reference: f.target.reference,
    member: { scope: 'tab', tabId: f.tabId, regionId: f.regionId, kind: 'agent', agentSessionId: SID } })).rejects.toMatchObject({ code: 'WORKBENCH_CLOSE_STALE' })
  const original = await f.b.spatial.read()
  expect(original?.graph.tabs.find(tab => tab.tabId === f.tabId)?.regionIds).toEqual(['replacement-browser-region'])
  expect(original?.graph.regions.find(region => region.regionId === 'replacement-browser-region')?.kind).toBe('browser')
  expect(f.lifecycle).not.toHaveBeenCalled()
})
it('a current member without an original position gets a dismissible Focus close explanation', async () => {
  const f = await fixture('none', false, false, false, false, false, 'unplaced')
  await act(async () => useAppStore.setState({ tabs: {}, layouts: {} }))
  expect(workbenchSelectionCatalog(useAppStore.getState()).locations).toHaveLength(0)
  await f.close()
  const done = () => document.querySelector<HTMLElement>('[data-confirm-label="Done"]:not([disabled])')
  await vi.waitFor(() => {
    expect(document.querySelector('.confirmation-dialog')?.textContent).toContain('The original workface has no confirmed display position')
    expect(done()).not.toBeNull()
  })
  expect(f.sourceCalls.mock.calls.filter(([method]) => method === 'closeLocations')).toHaveLength(1)
  expect(f.sourceCalls.mock.calls.some(([method]) => method === 'close')).toBe(false)
  expect(f.calls).not.toHaveBeenCalled()
  await act(async () => done()!.click())
  await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog')).toBeNull())
  expect(f.card()).toBeDefined()
  expect((await f.b.core.readAgentSession(SID))!.run).toEqual(f.original.run)
  expect(f.lifecycle).not.toHaveBeenCalled()
})
it.each(['none', 'runless'] as const)('actual Focus closes confirmed raw position with %s execution while preserving original Session and draft', async execution => {
  const f = await fixture(execution, false, false, false, execution !== 'runless')
  expect(confirmedOriginalRawLocations(useAppStore.getState(), f.target)).toHaveLength(1)
  expect(ordinaryAgentSpaceMember({ tabId: f.tabId, regionId: f.regionId, sessionId: SID }).kind).not.toBe('foreign')
  await f.close()
  await vi.waitFor(() => expect(f.calls).toHaveBeenCalled())
  expect(f.calls.mock.calls[0]).toEqual(['space.close.prepare', expect.objectContaining({ keepAgentSessions: true, target: expect.objectContaining({ tabId: f.tabId }) })])
  if (execution === 'runless') {
    await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog')?.textContent, useAppStore.getState().error ?? '').toContain('Close without confirming the Agent?'))
    expect(useAppStore.getState().tabs[f.tabId]).toBeDefined()
    await act(async () => document.querySelector<HTMLElement>('[data-confirm-label="Close"]')!.click())
  } else expect(document.querySelector('.confirmation-dialog')).toBeNull()
  await vi.waitFor(() => expect(useAppStore.getState().tabs[f.tabId], useAppStore.getState().error ?? '').toBeUndefined())
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original draft'); expect((await f.b.core.readAgentSession(SID))!.run).toEqual(f.original.run); expect(f.lifecycle).not.toHaveBeenCalled()
})
it('a nonlocal same-ID Source cannot borrow an accepted local raw occurrence', async () => {
  const f = await fixture('none', true); expect(confirmedOriginalRawLocations(useAppStore.getState(), f.target)).toHaveLength(0)
  await f.close(); const choice = document.querySelector<HTMLElement>('[aria-label="Choose original workface"] .focus-location-choice'); if (choice) await act(async () => choice.click()); expect(f.calls).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs[f.tabId]).toBeDefined()
})
it('a delayed exact position choice rechecks the original spatial witness', async () => {
  const f = await fixture('none', false, true); await f.close()
  const choices = [...document.querySelectorAll<HTMLButtonElement>('.focus-location-choice')]; expect(choices.length).toBeGreaterThan(1)
  const state = useAppStore.getState(), tab = state.tabs[f.tabId]!, region = tab.regions[f.regionId]!
  await act(async () => { useAppStore.setState({ tabs: { ...state.tabs, [f.tabId]: { ...tab, regions: { ...tab.regions, [f.regionId]: { ...region, sessionId: 'different-session' } as typeof region } } } }); choices[0]!.click() })
  expect(f.calls).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs[f.tabId]).toBeDefined(); expect(useAppStore.getState().error).toContain('unconfirmed or changed')
})

it('preserves an already qualified client presentation SID close path', async () => {
  const f = await fixture('known', false, false, true)
  expect(ordinaryAgentSpaceMember({ tabId: f.tabId, regionId: f.regionId, sessionId: 'qualified-client-SID' }).kind).toBe('foreign')
  await f.close(); await vi.waitFor(() => expect(f.calls).toHaveBeenCalled())
  expect(f.calls.mock.calls[0]![1]).toMatchObject({ keepAgentSessions: true, target: { tabId: f.tabId } })
  await vi.waitFor(() => expect(useAppStore.getState().tabs[f.tabId], useAppStore.getState().error ?? '').toBeUndefined()); expect(f.lifecycle).not.toHaveBeenCalled()
  expect((await f.d.core.readAgentSession(SID))!.run).toEqual(f.original.run); expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original draft')
})

it('actual Focus split close retains its neighboring Region and propagates the same Keep intent', async () => {
  const f = await fixture('none', false, false, false, false, true)
  await f.close(); await vi.waitFor(() => expect(f.calls).toHaveBeenCalled())
  expect(f.calls.mock.calls[0]![1]).toMatchObject({ keepAgentSessions: true, target: { kind: 'region', tabId: f.tabId, regionId: f.regionId } })
  await vi.waitFor(() => expect(document.querySelector('[data-confirm-label="Close"]')).not.toBeNull())
  await act(async () => document.querySelector<HTMLElement>('[data-confirm-label="Close"]')!.click())
  await vi.waitFor(() => expect(useAppStore.getState().tabs[f.tabId]?.regions[f.regionId], useAppStore.getState().error ?? '').toBeUndefined())
  expect(useAppStore.getState().tabs[f.tabId]?.regions['retained-launcher-region']).toBeDefined()
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original draft'); expect((await f.b.core.readAgentSession(SID))!.run).toEqual(f.original.run); expect(f.lifecycle).not.toHaveBeenCalled()
})
it('ordinary reference close retains its existing Stop review when Keep was not requested', async () => {
  const f = await fixture(), reference = confirmedOriginalRawLocations(useAppStore.getState(), f.target)[0]!
  await act(async () => requestWorkbenchReferenceClose(reference))
  await vi.waitFor(() => expect(f.calls).toHaveBeenCalled())
  expect(f.calls.mock.calls[0]![1]).toMatchObject({ keepAgentSessions: false })
  await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog')?.textContent).toContain('Stop Agent Session?'))
  expect(useAppStore.getState().tabs[f.tabId]).toBeDefined(); expect(f.lifecycle).not.toHaveBeenCalled()
})
