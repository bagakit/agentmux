// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-healthy-terminal /> }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div data-healthy-activity /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-composer="disabled" /> }))
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import type { RuntimeSnapshot } from '../src/shared/contracts'
import { restorePendingAgentLaunchWorkfaces } from '../src/renderer/src/lib/session-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), prompt = 'Original request with @relative/file\n  preserve spacing.'
function seed() {
  const launcher = createWorkbenchTab('view', { kind: 'launcher', regionId: 'region', workspaceId: 'workspace' })
  const independent = createWorkbenchTab('independent', { kind: 'launcher', regionId: 'new-input', workspaceId: 'workspace' })
  useLauncherState.setState({ sections: { workspace: { agents: 'expanded', terminal: 'hidden', browser: 'hidden', note: 'hidden' } } })
  useAppStore.setState({ config: composerConfig, sessions: [composerSession('healthy-neighbor')], activeWorkspaceId: 'workspace',
    tabs: { view: launcher, independent }, layouts: { workspace: createWorkspaceLayout('pane', ['view', 'independent']) },
    pendingAgentLaunches: {}, agentComposerDrafts: { region: prompt, 'new-input': 'Independent task' },
    launcherNameDrafts: { region: { agentName: 'Original Agent', tabName: 'Original Tab' } },
    launcherOptionDrafts: { region: { codex: { model: 'original-model' } } }, notificationEvents: [] })
  return { launcher, before: useAppStore.getState() }
}
const pane = (id: string) => <SessionPane sessionId={id} surfaceKind="agent" visible interactiveResize={false}
  linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'pane', tabId: 'view', regionId: 'region' }} />
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function begin() {
  const owner = deferred<Awaited<ReturnType<typeof api.sessions.launchAgent>>>()
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockReturnValue(owner.promise)
  const operation = useAppStore.getState().launchAgent('codex', prompt, 'pane', { tabId: 'view', regionId: 'region' }, { model: 'original-model' })
  const settled = operation.catch(error => error)
  return { owner, launch, settled }
}
it('actual rejected launch parks its exact original workface with cause and Check original, preserving requests and healthy neighbors', async () => {
  const { before } = seed(), stop = vi.spyOn(api.sessions, 'stop'), resume = vi.spyOn(api.sessions, 'resume'), continuation = vi.spyOn(api.sessions, 'continueCreation')
  const { owner, launch, settled } = begin()
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
  const submitted = launch.mock.calls[0]![0], id = submitted.agentSessionId!, original = useAppStore.getState().pendingAgentLaunches[id]!.request
  await dom.render(pane(id))
  expect(dom.container.textContent).toContain('Starting your agent')
  await act(async () => { owner.reject(Object.assign(new Error('Exact owner rejected the request observation'), { code: 'FIXTURE_REQUEST_REJECTED' })); await settled })
  const state = useAppStore.getState(), pending = state.pendingAgentLaunches[id]!
  expect(pending.request).toBe(original)
  expect(pending.requestIssue).toEqual({ message: 'Exact owner rejected the request observation', code: 'FIXTURE_REQUEST_REJECTED' })
  expect(pending.request).toMatchObject({ createOperationId: submitted.createOperationId, hostId: submitted.hostId, prompt, launchOptions: { model: 'original-model' } })
  expect(state.tabs.view!.regions.region).toMatchObject({ kind: 'agent', phase: 'launching', sessionId: id })
  expect(dom.container.querySelector('.session-connecting')?.getAttribute('data-loading-phase')).toBe('parked')
  expect(dom.container.textContent).toContain('Exact owner rejected the request observation')
  expect(dom.container.textContent).toContain('Creation status is unconfirmed')
  expect(dom.container.textContent).toContain(submitted.createOperationId!)
  expect(dom.container.textContent).toContain(id)
  expect(dom.container.querySelector('.full-page-loading__waiting')).toBeNull()
  expect(dom.container.textContent).not.toContain('Starting your agent')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.includes('Check original'))).toBe(true)
  expect(dom.container.querySelector('pre')?.textContent).toBe(prompt)
  expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(state.launcherNameDrafts).toBe(before.launcherNameDrafts)
  expect(state.launcherOptionDrafts).toBe(before.launcherOptionDrafts)
  expect(state.sessions).toBe(before.sessions)
  await dom.render(<><div data-failed-request>{pane(id)}</div><div data-independent-launcher><NewTabSurface tabGroupId="pane" tabId="independent" regionId="new-input" /></div></>)
  expect(dom.container.querySelector<HTMLButtonElement>('[data-independent-launcher] .launcher-launch-button')?.disabled).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['new-input']).toBe('Independent task')
  expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(continuation).not.toHaveBeenCalled()
})
it('an authoritative not_applied rejection restores the original Launcher instead of claiming an unknown creation failure', async () => {
  const { launcher, before } = seed(), { owner, launch, settled } = begin()
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); const id = launch.mock.calls[0]![0].agentSessionId!
  await act(async () => { owner.reject(Object.assign(new Error('Original admission rejected before apply'), { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })); await settled })
  expect(useAppStore.getState().pendingAgentLaunches[id]).toBeUndefined()
  expect(useAppStore.getState().tabs.view!.regions.region).toEqual({ ...launcher.regions.region, executorId: 'codex' })
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
it('a late rejection cannot mark a different original operation at the same Session as failed', async () => {
  seed(); const { owner, launch, settled } = begin()
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); const id = launch.mock.calls[0]![0].agentSessionId!, previous = useAppStore.getState().pendingAgentLaunches[id]!
  const later = { ...previous, request: { ...previous.request!, createOperationId: 'different-original-operation' } }
  await act(async () => useAppStore.setState(state => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches, [id]: later } })))
  await dom.render(pane(id))
  await act(async () => { owner.reject(new Error('Old operation rejected late')); await settled })
  expect(useAppStore.getState().pendingAgentLaunches[id]).toBe(later)
  expect(useAppStore.getState().pendingAgentLaunches[id]!.requestIssue).toBeUndefined()
  expect(dom.container.textContent).toContain('Starting your agent')
  expect(dom.container.textContent).not.toContain('Old operation rejected late')
  expect(dom.container.querySelector('.session-connecting')?.getAttribute('data-loading-phase')).toBe('loading')
})
it('a prior Region notice cannot manufacture rejection of a still-active request', async () => {
  seed(); const { launch } = begin(); await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); const id = launch.mock.calls[0]![0].agentSessionId!
  await act(async () => useAppStore.getState().reportError(new Error('Command timed out. A different request.'), { kind: 'indeterminate', lifecycle: { step: 'launch', regionId: 'region', tabId: 'view' } }))
  await dom.render(pane(id))
  expect(dom.container.textContent).toContain('Starting your agent')
  expect(dom.container.textContent).not.toContain('A different request')
  expect(useAppStore.getState().pendingAgentLaunches[id]!.requestIssue).toBeUndefined()
})

it('the public agent.open original launch adapter retains its CID and the same typed rejection for the real SessionPane', async () => {
  seed(); await initializeSpatialControlFixture()
  vi.spyOn(api.sessions, 'resolveCreationSessionId').mockResolvedValue('public-original-session')
  useAppStore.setState({ pendingAgentLaunches: { 'public-original-session': { events: [], overflowed: false, request: { executorId: 'codex', hostId: 'local', createOperationId: 'older-original-operation' }, requestIssue: { message: 'Older request cause', code: null } } } })
  const owner = deferred<Awaited<ReturnType<typeof api.sessions.launchAgent>>>()
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockReturnValue(owner.promise)
  const operation = useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'exact-control-request',
    operation: 'agent.open', content: { kind: 'new-agent', executorId: 'codex', prompt }, destination: { regionId: 'region', split: 'right' }, focus: false })
  const settled = operation.catch(error => error)
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
  const submitted = launch.mock.calls[0]![0], id = submitted.agentSessionId!
  expect(useAppStore.getState().pendingAgentLaunches[id]?.request?.createOperationId).toBe(submitted.createOperationId)
  expect(useAppStore.getState().pendingAgentLaunches[id]?.requestIssue).toBeUndefined()
  await act(async () => { owner.reject(Object.assign(new Error('Exact public creation observation rejected'), { code: 'FIXTURE_PUBLIC_REJECTION' })); await settled })
  const state = useAppStore.getState(), tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'agent' && region.sessionId === id))!
  const region = Object.values(tab.regions).find(region => region.kind === 'agent' && region.sessionId === id)!
  expect(state.pendingAgentLaunches[id]?.requestIssue).toEqual({ message: 'Exact public creation observation rejected', code: 'FIXTURE_PUBLIC_REJECTION' })
  await dom.render(<SessionPane sessionId={id} surfaceKind="agent" visible interactiveResize={false}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'pane', tabId: tab.id, regionId: region.regionId }} />)
  expect(dom.container.querySelector('.session-connecting')?.getAttribute('data-loading-phase')).toBe('parked')
  expect(dom.container.textContent).toContain('Exact public creation observation rejected')
  expect(launch).toHaveBeenCalledOnce()
})
it('the original workbench partializer retains only rejected request facts and reuses the projection for event-only updates', async () => {
  seed(); const { owner, launch, settled } = begin()
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); const id = launch.mock.calls[0]![0].agentSessionId!
  await act(async () => { owner.reject(new Error('Exact rejected request to retain')); await settled })
  const partialize = useAppStore.persist.getOptions().partialize!, before = partialize(useAppStore.getState())
  const pending = useAppStore.getState().pendingAgentLaunches[id]!
  expect(before).toHaveProperty(['pendingAgentLaunches', id, 'request', 'createOperationId'], pending.request!.createOperationId)
  expect(before).toHaveProperty(['pendingAgentLaunches', id, 'requestIssue', 'message'], 'Exact rejected request to retain')
  expect(before).not.toHaveProperty(['pendingAgentLaunches', id, 'events'])
  expect(before).not.toHaveProperty(['pendingAgentLaunches', id, 'created'])
  await act(async () => useAppStore.setState(state => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches,
    [id]: { ...pending, events: [...pending.events], overflowed: !pending.overflowed } } })))
  expect(partialize(useAppStore.getState())).toBe(before)
})

it('the restored original intent admits its exact positive API snapshot, then keeps live status and timeline projection', async () => {
  const { before } = seed(), { owner, launch, settled } = begin()
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); const id = launch.mock.calls[0]![0].agentSessionId!
  await act(async () => { owner.reject(new Error('Original rejected invocation survives restart')); await settled })
  const options = useAppStore.persist.getOptions(), document = JSON.parse(JSON.stringify(options.partialize!(useAppStore.getState())))
  const cold = { ...useAppStore.getState(), pendingAgentLaunches: {}, sessions: [], timelines: {}, runtimeEndpointWarnings: [], recoveryCandidates: [] }
  await act(async () => useAppStore.setState(options.merge!(document, cold), true))
  const retained = useAppStore.getState().pendingAgentLaunches[id]!
  expect(retained.events).toEqual([]); expect(retained.requestIssue?.message).toBe('Original rejected invocation survives restart')
  await dom.render(pane(id)); expect(dom.container.textContent).toContain('Creation status is unconfirmed')
  const healthy = composerSession(id)
  let payload: RuntimeSnapshot = { sessions: [{ ...healthy, hostId: 'foreign', control: { ...healthy.control, hostId: 'foreign' } }],
    timelines: { [id]: { agentSessionId: id, revision: 1, items: [] } }, recoveryCandidates: [] }
  const read = vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => payload)
  async function resync() { const count = read.mock.calls.length + 1; await act(async () => {
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } } })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(count))
  }) }
  await resync(); expect(useAppStore.getState().sessions.some(session => session.id === id)).toBe(false)
  payload = { ...payload, sessions: [healthy] }; await resync()
  await vi.waitFor(() => expect(useAppStore.getState().sessions.find(session => session.id === id)?.control).toEqual(healthy.control))
  expect(dom.container.querySelector('.session-connecting')).toBeNull()
  expect(useAppStore.getState().pendingAgentLaunches[id]).toBe(retained)
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: id,
    state: 'working', evidence: { source: 'native-hook', run: healthy.control.run, observedAt: Date.now() + 100 } } }))
  expect(useAppStore.getState().sessions.find(session => session.id === id)?.status.state).toBe('working')
  const record = { id: 'later-record', agentSessionId: id, kind: 'assistant_message' as const, status: 'complete' as const, source: 'native-hook' as const,
    title: 'Later original reply', content: 'The original runtime continues updating.', createdAt: 2, updatedAt: 2 }
  payload = { ...payload, sessions: [useAppStore.getState().sessions.find(session => session.id === id)!], timelines: { [id]: { agentSessionId: id, revision: 2, items: [record] } } }
  await resync(); expect(useAppStore.getState().timelines[id]?.items).toEqual([record])
  expect(useAppStore.getState().pendingAgentLaunches[id]?.requestIssue).toEqual(retained.requestIssue)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(launch).toHaveBeenCalledOnce()
})

it.each(['resource-changed', 'agent-changed', 'foreign-executor-host', 'occupied', 'tab-replaced'] as const)('native pending presentation never overwrites an original slot that is %s', async reason => {
  seed(); const { owner, launch, settled } = begin()
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); const id = launch.mock.calls[0]![0].agentSessionId!
  await act(async () => { owner.reject(new Error('Exact retained unknown request')); await settled })
  const tab = reason === 'occupied' ? createWorkbenchTab('view', { kind: 'agent', phase: 'attached', regionId: 'region', workspaceId: 'workspace', sessionId: 'other-original-session' })
    : createWorkbenchTab(reason === 'tab-replaced' ? 'another-view' : 'view', { kind: 'launcher', regionId: 'region',
      workspaceId: reason === 'resource-changed' ? 'another-resource' : 'workspace', agentWorkspaceId: reason === 'agent-changed' ? 'another-execution' : 'workspace',
      ...(reason === 'foreign-executor-host' ? { agentExecutor: { hostId: 'another-original-host', executorId: 'codex', executorRevision: launch.mock.calls[0]![0].executorRevision! } } : {}) })
  const tabs = { [tab.id]: tab }, pending = useAppStore.getState().pendingAgentLaunches
  expect(restorePendingAgentLaunchWorkfaces(tabs, pending, composerConfig)).toBe(tabs)
  expect(pending[id]?.requestIssue?.message).toBe('Exact retained unknown request')
})
it('the native original intent restores only one matching slot and leaves competing unknown requests unresolved', async () => {
  const { launcher } = seed(), { owner, launch, settled } = begin()
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); const id = launch.mock.calls[0]![0].agentSessionId!
  await act(async () => { owner.reject(new Error('Exact retained unknown request')); await settled })
  const tabs = { view: launcher }, pending = useAppStore.getState().pendingAgentLaunches
  const restored = restorePendingAgentLaunchWorkfaces(tabs, pending, composerConfig)
  expect(restored.view!.regions.region).toMatchObject({ kind: 'agent', phase: 'launching', sessionId: id })
  const competing = { ...pending, 'second-original-session': { ...pending[id]!, request: { ...pending[id]!.request!, createOperationId: 'another-original-operation', launcher: { regionId: 'region', tabId: 'view' } } } }
  expect(restorePendingAgentLaunchWorkfaces(tabs, competing, composerConfig)).toBe(tabs)
  expect(Object.keys(competing)).toHaveLength(2)
})
