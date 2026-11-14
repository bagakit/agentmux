// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentLaunchInput, AgentLaunchResult, SessionSnapshot, AppConfig } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { sourceCoordinatorInput, sourceCoordinatorInputKey } from '../src/renderer/src/lib/source-coordinator-input'
import { sendOriginalSourceAssociation } from '../src/renderer/src/lib/source-coordinator-request'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import type { SourceCoordinatorStart } from '../src/renderer/src/lib/launcher-source'
import { WORKBENCH_USER_STATE_KEY } from '../src/renderer/src/lib/workbench-user-storage'
import { SourceCoordinatorRequests } from '../src/renderer/src/components/SourceCoordinatorRequests'
import { createClientUiRoot } from './helpers/client-ui-render'

const initial = useAppStore.getState(), prompt = '  The exact original task\n', names = { agentName: '  Original Agent ', tabName: ' Original B Tab  ' }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This device' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, saveBookmark: true, viewport: true, more: true } } }
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true); localStorage.clear() })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function seed() {
  const project = { id: 'original-project', hostId: 'B-in-A', path: '/B/original-project', name: 'B project', kind: 'folder' as const }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'launcher', workspaceId: project.id })
  const selection: SourceCoordinatorStart = { selection: { kind: 'source-coordinator', project,
    target: { hostId: project.hostId, reference: { runtimeId: 'B-Runtime', spaceId: 'B-Space' }, workspaceId: 'B-workspace', zoneId: 'B-Zone' },
    coordinator: { hostId: 'local', runtimeId: 'A-Runtime', homeDirectory: '/A/original-home' } },
    executor: { executorId: 'A-selected-executor', providerId: 'codex', configRevision: 'A-revision' } }
  useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, { id: project.hostId, label: 'Original B', kind: 'ssh', hostname: 'private.invalid' }], workspaces: [project] },
    activeWorkspaceId: project.id, tabs: { [tab.id]: tab }, layouts: { [project.id]: createWorkspaceLayout('group', [tab.id]) },
    pendingAgentLaunches: {}, mountedSpaceInputs: {}, agentComposerDrafts: { 'original-region': prompt }, launcherNameDrafts: { 'original-region': names },
    launcherOptionDrafts: { 'original-region': { codex: { model: 'original-option' } } }, agentComposerNotes: { 'original-region': 'Original note\n' },
    canonicalizeAgentLaunch: async result => result, sessions: [], agentNames: {}, notificationEvents: [] })
  await initializeSpatialControlFixture()
  return { selection, project, start: () => useAppStore.getState().launchAgent('A-selected-executor', prompt, 'group',
    { tabId: tab.id, regionId: 'original-region' }, { model: 'original-option' }, names, undefined, undefined, selection) }
}
function creation(input: AgentLaunchInput): AgentLaunchResult {
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: input.agentSessionId!, hostId: 'local', kind: 'agent', executorId: input.executorId, providerId: 'codex',
    workspacePath: input.workspacePath!, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, label: 'Original Agent', processState: 'running',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    status: { state: 'running', source: 'run-process', observedAt: 1 }, control: { kind: 'agent', hostId: 'local', agentSessionId: input.agentSessionId!, run: { runId: 'original-A-run' } } }
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] }, projectionFailures: [],
    created: { kind: 'agent', agentSessionId: session.id, providerId: 'codex', executorId: input.executorId, hostId: 'local', workspacePath: input.workspacePath!,
      createdAt: 1, updatedAt: 1, run: session.control.run, retiredRuns: [], creation: { createOperationId: input.createOperationId!, initialPrompt: 'unknown' },
      toolExecution: { bindingId: 'original-binding', resourceHostId: input.toolWorkspace!.hostId, resourceRuntimeId: 'B-Runtime', workspacePath: input.toolWorkspace!.path } } }
}
function acknowledgeWitness(input: AgentLaunchInput) {
  return { bindingId: 'original-binding', agentHostId: 'local', resourceHostId: 'B-in-A',
    agentSessionId: input.agentSessionId!, resourceWorkspacePath: input.toolWorkspace!.path, state: 'connected',
    association: { state: 'confirmed', reference: { bindingId: 'original-binding', agentSessionId: input.agentSessionId!, createOperationId: input.createOperationId! },
      agentRuntimeId: 'A-Runtime', resourceRuntimeId: 'B-Runtime', resourceWorkspacePath: input.toolWorkspace!.path } } as const
}

it('the real Store dispatches A creation only after the native input checkpoint contains complete C, L, names and options', async () => {
  const f = await seed(), owner = deferred<AgentLaunchResult>(), before = useAppStore.getState()
  const checkpoints: string[] = []
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(input => {
    checkpoints.push(localStorage.getItem(WORKBENCH_USER_STATE_KEY) ?? '')
    return owner.promise
  })
  const operation = f.start().catch(error => error)
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
  const request = launch.mock.calls[0]![0], pending = useAppStore.getState().pendingAgentLaunches[request.agentSessionId!]!
  const retained = sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, sourceCoordinatorInputKey({ ...request, sourceCoordinator: request.sourceCoordinator!, agentSessionId: request.agentSessionId!, createOperationId: request.createOperationId! }))!
  try {
    const saved = JSON.parse(checkpoints[0]!).state, key = sourceCoordinatorInputKey(retained.request)
    expect(Object.keys(saved.mountedSpaceInputs)).toHaveLength(1)
    expect(sourceCoordinatorInput(saved.mountedSpaceInputs, key)?.request).toEqual(request)
    expect(sourceCoordinatorInput(saved.mountedSpaceInputs, key)?.origin.names).toEqual(names)
    expect(retained.association.operationId).toBeTruthy()
    expect(request).toMatchObject({ hostId: 'local', workspacePath: '/A/original-home', sourceCoordinator: { runtimeId: 'A-Runtime', resourceRuntimeId: 'B-Runtime' },
      toolWorkspace: { id: f.project.id, hostId: f.project.hostId, path: f.project.path }, prompt, launchOptions: { model: 'original-option' }, agentMuxNote: 'Original note\n' })
    expect(request.executionWorkspaceId).toBeUndefined(); expect(pending.request).toBe(retained.request)
  } finally { owner.reject(Error('Original C result is unknown')); expect(await operation).toBeInstanceOf(Error) }
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().launcherNameDrafts).toBe(before.launcherNameDrafts)
  expect(retained.association.submitted).toBe(false)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it('a failed original checkpoint leaves the complete Reach input and original Launcher without dispatching C or L', async () => {
  const f = await seed(), launch = vi.spyOn(api.sessions, 'launchAgent'), open = vi.spyOn(api.spaceMounts, 'call')
  const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw Error('Original user file ACK unavailable') })
  await expect(f.start()).rejects.toThrow('ACK unavailable')
  expect(launch).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  const retained = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>)[0]!
  expect(retained).toMatchObject({ kind: 'source-coordinator-launch', submitted: false, origin: { names }, request: { prompt }, association: { submitted: false } })
  expect(useAppStore.getState().tabs['original-tab']!.regions['original-region']!.kind).toBe('launcher')
  write.mockRestore()
})

it('confirmed original A creation reaches B association once; concurrent explicit continuation joins the same original L and no raw receiving-name owner is used', async () => {
  const f = await seed(), source = deferred<Awaited<ReturnType<typeof api.spaceMounts.call<'open'>>>>()
  const rename = vi.spyOn(api.spatial, 'renameLabel'), witness = vi.spyOn(api.sessions, 'executionBinding')
  let input!: AgentLaunchInput
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async request => { input = request; witness.mockResolvedValue(acknowledgeWitness(request)); return creation(request) })
  const open = vi.spyOn(api.spaceMounts, 'call').mockImplementation((method, _request) => {
    expect(method).toBe('open'); return source.promise as ReturnType<typeof api.spaceMounts.call<typeof method>>
  })
  await f.start(); await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
  const key = sourceCoordinatorInputKey({ ...input, sourceCoordinator: input.sourceCoordinator!, agentSessionId: input.agentSessionId!, createOperationId: input.createOperationId! })
  const original = sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)!
  const same = sendOriginalSourceAssociation(original)
  expect(open).toHaveBeenCalledOnce(); expect(witness).toHaveBeenCalledOnce()
  const frozen = original.association.request!
  expect(frozen).toMatchObject({ operationId: original.association.operationId, content: { kind: 'agent-session', reference: { kind: 'coordinator-agent', runtimeId: 'A-Runtime', binding: { agentSessionId: input.agentSessionId, createOperationId: input.createOperationId } }, expectedResource: { runtimeId: 'B-Runtime', workspaceId: 'B-workspace', workspacePath: f.project.path } }, focus: false })
  expect(JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!).state.mountedSpaceInputs[key].association.request).toEqual(frozen)
  source.reject(Error('Original L response lost')); await expect(same).rejects.toThrow('lost')
  expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({ id: input.agentSessionId, processState: 'running' }))
  expect(sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)).toMatchObject({ acknowledged: { target: { reference: { createOperationId: input.createOperationId } } }, association: { submitted: true, request: frozen } })
  expect(rename).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledOnce()
})

it('a wrong B Runtime in the original association witness refuses only L and preserves the confirmed A Agent', async () => {
  const f = await seed()
  let submitted!: AgentLaunchInput
  const witness = vi.spyOn(api.sessions, 'executionBinding')
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async request => {
    submitted = request; const value = acknowledgeWitness(request)
    witness.mockResolvedValue({ ...value, association: { ...value.association, resourceRuntimeId: 'another-B-Runtime' } })
    return creation(request)
  })
  const open = vi.spyOn(api.spaceMounts, 'call').mockRejectedValue(Error('An unexpected L was dispatched'))
  await f.start()
  await vi.waitFor(() => expect(Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]?.association.issue).toContain('has not confirmed this project resource'))
  expect(open).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({ id: submitted.agentSessionId, processState: 'running' }))
})

it('the actual original-request service can read B while A lookup is pending and never submits on Check', async () => {
  const f = await seed(), launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Error('Original C observation lost'))
  await expect(f.start()).rejects.toThrow('lost')
  const input = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]!
  const readA = vi.spyOn(api.sessions, 'resolveExecutionBinding').mockReturnValue(new Promise(() => {})), continuation = vi.spyOn(api.sessions, 'continueExecution')
  const readB = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, query) => {
    expect(method).toBe('inspect'); expect(query).toMatchObject({ hostId: input.target.hostId, reference: input.target.reference, requestId: input.association.operationId })
    return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }, request: { known: false, operationId: input.association.operationId, report: null } } as Awaited<ReturnType<typeof api.spaceMounts.call<typeof method>>>
  })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(SourceCoordinatorRequests, { active: true, origin: { tabId: 'original-tab', regionId: 'original-region' } })))
    expect(readA).not.toHaveBeenCalled(); expect(readB).not.toHaveBeenCalled()
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Check original Reach request')!.click())
    await vi.waitFor(() => expect(readB).toHaveBeenCalledOnce())
    expect(readA).toHaveBeenCalledOnce(); expect(launch).toHaveBeenCalledOnce(); expect(continuation).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('explicit original-C continuation presents its confirmed Agent even when the separate B link reply is lost', async () => {
  const f = await seed(), launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Error('Original C result lost'))
  await expect(f.start()).rejects.toThrow('lost')
  const input = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]!
  const target = { coordinator: { hostId: input.request.hostId, runtimeId: input.request.sourceCoordinator.runtimeId }, reference: { bindingId: 'original-binding', agentSessionId: input.request.agentSessionId, createOperationId: input.request.createOperationId } }
  vi.spyOn(api.sessions, 'resolveExecutionBinding').mockResolvedValue({ target, inspection: acknowledgeWitness(input.request) })
  vi.spyOn(api.sessions, 'executionBinding').mockResolvedValue(acknowledgeWitness(input.request))
  const continuation = vi.spyOn(api.sessions, 'continueExecution').mockResolvedValue(creation(input.request))
  const source = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async method => {
    if (method === 'open') throw Error('Original L reply lost')
    expect(method).toBe('inspect')
    return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }, request: { known: false, operationId: input.association.operationId, report: null } } as Awaited<ReturnType<typeof api.spaceMounts.call<typeof method>>>
  })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(SourceCoordinatorRequests, { active: true, origin: { tabId: 'original-tab', regionId: 'original-region' } })))
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Check original Reach request')!.click())
    await vi.waitFor(() => expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Continue original Coordinator request')).toBe(true))
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Continue original Coordinator request')!.click())
    await vi.waitFor(() => expect(container.textContent).toContain('Original L reply lost'))
    expect(continuation).toHaveBeenCalledExactlyOnceWith(target); expect(launch).toHaveBeenCalledOnce()
    expect(source.mock.calls.filter(([method]) => method === 'open')).toHaveLength(1)
    expect(useAppStore.getState().tabs['original-tab']!.regions['original-region']).toMatchObject({ kind: 'agent', sessionId: input.request.agentSessionId })
    expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({ id: input.request.agentSessionId, processState: 'running' }))
    expect(sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, sourceCoordinatorInputKey(input.request))).toMatchObject({ request: input.request,
      origin: { names }, acknowledged: { target }, association: { operationId: input.association.operationId, submitted: true } })
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('one unreadable private C/L sibling keeps the valid original request controls and both exact inputs visible without altering healthy Agents', async () => {
  const f = await seed(); vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Error('Original C outcome unconfirmed'))
  await expect(f.start()).rejects.toThrow('unconfirmed')
  const input = Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]!
  const bad = { kind: 'source-coordinator-launch', origin: input.origin, request: { future: [' exact bytes ', { keep: true }] }, target: input.target }
  const neighbor = creation({ ...input.request, agentSessionId: 'healthy-neighbor', createOperationId: 'healthy-neighbor-C' }).session!
  useAppStore.setState(state => ({ mountedSpaceInputs: { ...state.mountedSpaceInputs as Record<string, unknown>, unreadable: bad }, sessions: [neighbor] }))
  const before = useAppStore.getState(), bytes = JSON.stringify(before.mountedSpaceInputs)
  const target = { coordinator: { hostId: input.request.hostId, runtimeId: input.request.sourceCoordinator.runtimeId }, reference: { bindingId: 'original-binding', agentSessionId: input.request.agentSessionId, createOperationId: input.request.createOperationId } }
  vi.spyOn(api.sessions, 'resolveExecutionBinding').mockResolvedValue({ target, inspection: acknowledgeWitness(input.request) })
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async () => ({ catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
    request: { operationId: input.association.operationId, known: false, report: null } }))
  const continuation = vi.spyOn(api.sessions, 'continueExecution').mockRejectedValue(Error('This exact Coordinator observation remains unknown'))
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(SourceCoordinatorRequests, { active: true, origin: { tabId: 'original-tab', regionId: 'original-region' } })))
    expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Check original Reach request')).toBe(true)
    expect(container.textContent).toContain('unreadable')
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Check original Reach request')!.click())
    await vi.waitFor(() => expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Continue original Coordinator request')).toBe(true))
    const keep = [...container.querySelectorAll('button')].find(item => item.textContent === 'Continue original Coordinator request')!
    expect(keep.disabled).toBe(false); await act(async () => keep.click())
    expect(continuation).toHaveBeenCalledExactlyOnceWith(target)
    expect(JSON.stringify(useAppStore.getState().mountedSpaceInputs)).toBe(bytes)
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().tabs).toBe(before.tabs)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('hidden original-request consumers do not enumerate private inputs; one visible workface alone pays for a changed input map', async () => {
  const f = await seed(); vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Error('Original C outcome retained'))
  await expect(f.start()).rejects.toThrow('retained')
  const before = useAppStore.getState(), entries = before.mountedSpaceInputs as Record<string, unknown>, persistence = useAppStore.persist.getOptions()
  // The original writer is separately tested. This leaf counts only rendering,
  // excluding its legitimate serialization of an actual private input edit.
  useAppStore.persist.setOptions({ storage: { getItem: async () => null, setItem() {}, removeItem() {} } })
  let scans = 0
  const observed = (value: Record<string, unknown>) => new Proxy(value, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  useAppStore.setState({ mountedSpaceInputs: observed(entries) })
  const check = vi.spyOn(api.sessions, 'resolveExecutionBinding'), source = vi.spyOn(api.spaceMounts, 'call')
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  const pane = (key: string, active: boolean) => createElement(SourceCoordinatorRequests, { key, active, origin: { tabId: 'original-tab', regionId: 'original-region' } })
  try {
    scans = 0
    await act(async () => root.render(createElement('div', {}, pane('hidden-one', false), pane('hidden-two', false), pane('hidden-three', false))))
    expect(scans).toBe(0); expect(container.querySelector('button')).toBeNull()
    await act(async () => useAppStore.setState({ mountedSpaceInputs: observed({ ...entries, otherSpace: { kind: 'future-private-input', bytes: 'keep' } }) }))
    expect(scans).toBe(0)
    await act(async () => root.render(createElement('div', {}, pane('hidden-one', false), pane('hidden-two', false), pane('visible', true))))
    expect(scans).toBe(1)
    await act(async () => useAppStore.setState({ mountedSpaceInputs: observed({ ...entries, anotherSpace: { kind: 'future-private-input', bytes: 'keep again' } }) }))
    expect(scans).toBe(2)
    expect(check).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().tabs).toBe(before.tabs)
  } finally { await act(async () => root.unmount()); container.remove(); useAppStore.persist.setOptions(persistence) }
})

it.each([{ saved: false, partial: false }, { saved: true, partial: false }, { saved: true, partial: true }])('read-only opened association separates current observation from the original saved ACK (%j)', async ({ saved, partial }) => {
  const f = await seed(), reason = 'The current read confirms the association, not the original write acknowledgement.'
  let original!: AgentLaunchInput
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async request => { original = request; return creation(request) })
  vi.spyOn(api.sessions, 'executionBinding').mockImplementation(async () => acknowledgeWitness(original))
  const report = (operationId: string, producer: boolean): Awaited<ReturnType<typeof api.spaceMounts.call<'open'>>> => ({ operationId,
    outcome: producer && !saved ? 'unknown' : !producer && partial ? 'partial' : 'opened', from: null,
    to: { spaceId: 'B-Space', zoneId: 'B-Zone', workspaceId: 'B-workspace', displayWorkspaceId: 'B-workspace', groupId: 'B-group', tabId: 'B-tab', regionId: 'B-region' },
    agent: null, resource: null, issues: !producer && partial ? [{ step: 'placement', code: 'SPACE_ASSOCIATION_PLACEMENT_UNCONFIRMED',
      message: 'The current association has no matching original placement.', recovery: 'Inspect the original Source placement; retain its Agent and operation.' }] : [], save: { layoutApplied: producer, clientStateWritten: producer, storageFlushRequested: producer,
      diskDurability: producer && saved ? 'confirmed' : 'unconfirmed', reason: producer ? null : reason } })
  const source = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, query) => {
    if (method === 'open') return report((query as import('../src/shared/space-mount').SpaceMountMethods['open']['input']).request.operationId!, true) as Awaited<ReturnType<typeof api.spaceMounts.call<typeof method>>>
    expect(method).toBe('inspect'); const operationId = (query as import('../src/shared/space-mount').SpaceMountMethods['inspect']['input']).requestId
    return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }, request: { operationId, known: true, report: report(operationId, false) } } as Awaited<ReturnType<typeof api.spaceMounts.call<typeof method>>>
  })
  await f.start()
  await vi.waitFor(() => expect(Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]?.association.receipt).toBeDefined())
  const before = useAppStore.getState(), input = Object.values(before.mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]!, bytes = JSON.stringify(before.mountedSpaceInputs)
  vi.spyOn(api.sessions, 'resolveExecutionBinding').mockResolvedValue({ target: input.acknowledged!.target, inspection: acknowledgeWitness(original) })
  const sourceCalls = source.mock.calls.length, creates = vi.mocked(api.sessions.launchAgent).mock.calls.length
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(SourceCoordinatorRequests, { active: true, origin: { tabId: 'original-tab', regionId: 'original-region' } })))
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Check original Reach request')!.click())
    await vi.waitFor(() => expect([...container.querySelectorAll('[role="status"]')].some(item => item.textContent?.includes(reason))).toBe(true))
    const title = container.querySelector('details > summary')!.textContent
    expect(title).toBe(partial ? 'Current project link needs checking' : saved ? 'Original project link saved' : 'Original project link observed')
    expect(title).not.toBe('Original project link confirmed')
    if (!saved) expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Continue original project link')).toBe(true)
    if (partial) {
      expect(container.querySelector<HTMLDetailsElement>('details')!.open).toBe(true)
      const statuses = [...container.querySelectorAll('[role="status"]')].map(item => item.textContent).join('\n')
      expect(statuses).toContain('The current association has no matching original placement.')
      expect(statuses).toContain('Inspect the original Source placement; retain its Agent and operation.')
      expect(statuses).toContain('Original write acknowledgement: saved')
    }
    expect(JSON.stringify(useAppStore.getState().mountedSpaceInputs)).toBe(bytes)
    expect(source.mock.calls.slice(sourceCalls).map(([method]) => method)).toEqual(['inspect'])
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(creates)
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, sourceCoordinatorInputKey(input.request))!.association.receipt).toBe(input.association.receipt)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('a user continues an unknown L with the exact frozen source and request, retains the original response and ignores an older read after the new ACK', async () => {
  const f = await seed(), delayedRead = deferred<Awaited<ReturnType<typeof api.spaceMounts.call<'inspect'>>>>()
  let original!: AgentLaunchInput
  const create = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async request => { original = request; return creation(request) })
  const continueC = vi.spyOn(api.sessions, 'continueExecution')
  const witness = vi.spyOn(api.sessions, 'executionBinding').mockImplementation(async () => acknowledgeWitness(original))
  let writes = 0
  const source = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, query) => {
    if (method === 'inspect') return delayedRead.promise as ReturnType<typeof api.spaceMounts.call<typeof method>>
    expect(method).toBe('open'); writes++
    const request = (query as import('../src/shared/space-mount').SpaceMountMethods['open']['input']).request
    return { operationId: request.operationId!, outcome: writes === 1 ? 'unknown' : 'opened', from: null, to: null, agent: null, resource: null, issues: [],
      save: { layoutApplied: writes > 1, clientStateWritten: writes > 1, storageFlushRequested: writes > 1, diskDurability: writes > 1 ? 'confirmed' : 'unconfirmed', reason: writes === 1 ? 'Original L write outcome unconfirmed.' : null }
    } as Awaited<ReturnType<typeof api.spaceMounts.call<typeof method>>>
  })
  await f.start()
  await vi.waitFor(() => expect(Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]?.association.receipt).toBeDefined())
  const before = useAppStore.getState(), input = Object.values(before.mountedSpaceInputs as Record<string, import('../src/renderer/src/lib/source-coordinator-input').SourceCoordinatorInput>)[0]!, oldResponse = input.association.receipt!, oldBytes = JSON.stringify(oldResponse)
  vi.spyOn(api.sessions, 'resolveExecutionBinding').mockResolvedValue({ target: input.acknowledged!.target, inspection: acknowledgeWitness(original) })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(SourceCoordinatorRequests, { active: true, origin: { tabId: 'original-tab', regionId: 'original-region' } })))
    expect(writes).toBe(1)
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Check original Reach request')!.click())
    expect(writes).toBe(1)
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Continue original project link')!.click())
    await vi.waitFor(() => expect(writes).toBe(2))
    await act(async () => delayedRead.resolve({ catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
      request: { operationId: input.association.operationId, known: true, report: oldResponse } }))
    expect(container.querySelector('details > summary')!.textContent).toBe('Original project link saved')
    const opens = source.mock.calls.filter(([method]) => method === 'open')
    expect(opens).toHaveLength(2); expect(opens[1]![1]).toEqual(opens[0]![1])
    expect(opens[1]![1]).toMatchObject({ hostId: input.target.hostId, reference: input.target.reference, request: input.association.request })
    expect(create).toHaveBeenCalledOnce(); expect(continueC).not.toHaveBeenCalled(); expect(witness).toHaveBeenCalledTimes(2)
    const current = sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, sourceCoordinatorInputKey(input.request))!
    expect(current.request).toBe(input.request); expect(current.association.operationId).toBe(input.association.operationId)
    expect(current.association.originalReceipt).toBe(oldResponse); expect(JSON.stringify(oldResponse)).toBe(oldBytes)
    expect(current.association.receipt).toMatchObject({ outcome: 'opened', save: { diskDurability: 'confirmed' } })
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().tabs).toBe(before.tabs)
  } finally { await act(async () => root.unmount()); container.remove() }
})
