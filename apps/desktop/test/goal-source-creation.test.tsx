// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxError } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { spatialAgentOpenRecord } from '../../../packages/core/src/spatial-agent-open'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { createHostSpatialAgentControl } from '../../host/src/spatial-agent-control'
import { createHostFolderSpaceResource } from '../../host/src/folder-space-resource'
import { readHostSettingsHosts } from '../../host/src/settings-hosts-read'
import type { AgentMuxAgentSession } from '../../../packages/core/src/types'
import type { AgentExecutionOpenInput } from '../../../packages/core/src/agent-execution-coordinator'
import type { AgentMuxHeadlessRuntime } from '../../../packages/core/src/headless-runtime'
import { GoalAgentPicker } from '../src/renderer/src/components/GoalAgentPicker'
import { api } from '../src/renderer/src/lib/api'
import { goalCreationDraftKey } from '../src/renderer/src/lib/goal-agent-selection'
import { readGoalSourceCreationDraft } from '../src/renderer/src/lib/goal-source-creation-draft'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { chooseField } from './helpers/selection-field'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import type { AgentLaunchInput, AgentLaunchResult } from '../src/shared/contracts'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const goal: DemandRecord = { id: 'source-creation-Goal', title: 'Original Goal', description: 'Original task not sent by creation', status: 'todo', priority: 'normal',
  sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, projectId: null, projectName: null, createdAt: 1, updatedAt: 1, source: 'session' }
const key = goalCreationDraftKey(goal.id, 'assignees')
async function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.goal-agent-picker button')].filter(value => value.textContent?.trim() === label)
  expect(found, document.body.textContent ?? '').toHaveLength(1)
  await act(async () => found[0]!.click())
}
async function field(label: string, value: string) { await chooseField(document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!, value) }
async function fixture(sourceCarrier = 'B-in-A') {
  const root = await mkdtemp(join(tmpdir(), 'amx-goal-source-create-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')), path = join(root, 'config.json')
  const project = { id: 'B-original-project', hostId: 'local', name: 'Original project', path: '/B/original-project', kind: 'folder' as const }
  const hosts = [{ id: 'local', kind: 'local' as const, label: 'Project device' }, { id: 'D-in-B', kind: 'ssh' as const, label: 'Agent device', hostname: 'private.invalid', runtimeId: 'D' }]
  await writeFile(path, JSON.stringify({ workspaces: [project], hosts })); const folder = await spatial.registerFolder(project)
  const owner = { runtimeId: 'B', ownerInstanceId: 'B-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' as const }
  const executor = { executorId: 'selected', providerId: 'codex', label: 'Original D configuration', command: '/D/private-cli', source: 'registered' as const,
    configRevision: 'D-revision', availability: 'unknown' as const, launchOptions: [], creationContract: { ordinaryLaunch: 1 as const } }
  let session: AgentMuxAgentSession | undefined, frozen: AgentExecutionOpenInput | undefined
  const locatorWorkspacePath = '/D/agent-workspaces/' + 'a'.repeat(64)
  const forbidden = vi.fn(async () => { throw Error('Creation sends no task or navigation input.') })
  const d = { readAgentInputEpoch: vi.fn(async (): Promise<string | undefined> => 'original-D-cut'), resolveAgentCreationSessionId: vi.fn(async () => 'same-SID'), inspectAgentCreation: vi.fn(async () => {
    if (!session) throw new AgentMuxError('The original creation is absent.', 'AGENT_CREATION_UNKNOWN'); return session
  }), listHostExecutors: vi.fn(async () => ({ runtimeId: 'D', executors: [executor] })), hostEnvironment: vi.fn(async (selector?: { agentSessionId: string }) => selector ? {
    homeDirectory: '/D/home', agentWorkspace: { runtimeId: 'D', agentSessionId: selector.agentSessionId, workspacePath: locatorWorkspacePath }
  } : { homeDirectory: '/D/home' }),
    writeAgent: forbidden, pasteAgent: forbidden, submitAgentPrompt: forbidden }
  const reference = () => ({ bindingId: frozen!.bindingId, agentSessionId: frozen!.agent.agentSessionId, createOperationId: frozen!.agent.createOperationId })
  const bindings = {
    admit: vi.fn(async (input: AgentExecutionOpenInput) => { frozen = input; return reference() }),
    create: vi.fn(async (input: AgentExecutionOpenInput) => {
      frozen = input; session = { kind: 'agent', agentSessionId: input.agent.agentSessionId, hostId: 'local', providerId: 'codex', executorId: 'selected', workspacePath: input.agent.workspacePath,
        createdAt: 1, updatedAt: 1, run: { runId: 'controlled-original-D-run' }, retiredRuns: [], creation: { createOperationId: input.agent.createOperationId, executorRevision: input.agent.executorRevision, initialPrompt: 'not-requested' },
        toolExecution: { bindingId: input.bindingId, resourceHostId: input.resourceHostId, resourceRuntimeId: input.resourceRuntimeId, workspacePath: input.resourceWorkspacePath } }
      return { session, creation: session.creation!, execution: {} }
    }),
    inspect: vi.fn(async (bindingId: string, view?: 'association') => frozen && bindingId === frozen.bindingId ? {
      bindingId: frozen.bindingId, agentHostId: frozen.agentHostId, resourceHostId: frozen.resourceHostId, agentSessionId: frozen.agent.agentSessionId,
      resourceWorkspacePath: frozen.resourceWorkspacePath, state: session?.creation?.createOperationId === frozen.agent.createOperationId ? 'connected' as const : 'unavailable' as const,
      continuation: reference(), ...(view === 'association' ? { association: { state: 'confirmed' as const, reference: reference(), agentRuntimeId: frozen.agentRuntimeId,
        resourceRuntimeId: frozen.resourceRuntimeId, resourceWorkspacePath: frozen.resourceWorkspacePath,
        agent: { executorId: frozen.agent.executorId, executorRevision: frozen.agent.executorRevision, workspacePath: frozen.agent.workspacePath },
        ...(frozen.sourceRequestDigest ? { sourceRequestDigest: frozen.sourceRequestDigest } : {}) } } : {}) } : null),
    continueOriginal: vi.fn(async () => {
      if (!frozen) throw Error('The original frozen intent is absent.')
      const created = session?.creation?.createOperationId === frozen.agent.createOperationId ? { session, creation: session.creation! } : await bindings.create(frozen)
      return { ...created, execution: await bindings.inspect(frozen.bindingId) }
    }) }
  const local = { ...d, agentCreationAuthority: vi.fn(async () => ({ runtimeId: 'B' })),
    readAgentInputEpoch: vi.fn(async (): Promise<string | undefined> => 'original-B-cut'),
    listHostExecutors: vi.fn(async (selector?: { executorId?: string }) => ({ runtimeId: 'B', executors: [{ ...executor, configRevision: 'B-revision', label: 'Original B configuration' },
      ...(selector?.executorId === 'codex' ? [{ ...executor, executorId: 'codex', configRevision: 'B-codex-revision', label: 'Codex' }] : [])] })),
    createHostAgentWithDelivery: vi.fn(async (input: { agentSessionId: string; createOperationId: string; executorId: string; executorRevision?: string; workspacePath: string }) => {
      session = { kind: 'agent', agentSessionId: input.agentSessionId, hostId: 'local', providerId: 'codex', executorId: input.executorId, workspacePath: input.workspacePath,
        createdAt: 1, updatedAt: 1, run: { runId: 'controlled-B-run' }, retiredRuns: [], creation: { createOperationId: input.createOperationId, ...(input.executorRevision ? { executorRevision: input.executorRevision } : {}), initialPrompt: 'not-requested' } }
      return { session, creation: session.creation!, promptConfirmed: true }
    }) }
  const runtime = { ownerIdentity: () => owner, executionHost: async (hostId: string) => {
    expect(['local', 'D-in-B']).toContain(hostId); return hostId === 'local' ? { runtimeId: 'B', client: local } : { runtimeId: 'D', client: d }
  }, executionBindings: bindings, client: local } as unknown as AgentMuxHeadlessRuntime
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), spatialState: spatial, executionBindings: bindings as never,
    coreClients: () => [{ hostId: 'local', client: local }, { hostId: 'D-in-B', client: d }] as never,
    snapshot: async () => ({ workspaces: [{ workspaceId: project.id, hostId: project.hostId, name: project.name, path: project.path, repoPath: null, kind: 'directory', projectId: null, branch: null }] }),
    forwardControl: async method => { expect(method).toBe('settings.hosts.ls'); return { hosts: await readHostSettingsHosts(path) } as never },
    spatialFolderResource: createHostFolderSpaceResource(path), spatialAgentControl: createHostSpatialAgentControl({ configurationPath: path, spatial, runtime: () => runtime }),
    hostedRuntime: () => ({ call: async (method: string) => { expect(method).toBe('runtime.owner.identity'); return { owner } }, assertFence() {}, subscribe: forbidden }) as never })
  Object.assign(runtime, { server })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const transport = spaceMountTransport(cleanup, [{ id: sourceCarrier, carrier: { forwardRpc: rpc.call.bind(rpc), subscribeRpc: rpc.subscribe.bind(rpc) } }])
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(transport.api.call)
  const observerProject = { ...project, id: 'A-project-locator', hostId: sourceCarrier }
  useAppStore.setState({ config: { ...composerConfig, hosts: sourceCarrier === 'local' ? composerConfig.hosts : [...composerConfig.hosts, { id: sourceCarrier, kind: 'ssh', label: 'Original B', hostname: 'private.invalid' }], workspaces: [observerProject] },
    goalAgentCreationDrafts: {}, goalAgentSelectionDrafts: {}, mountedSpaceInputs: {}, sessions: [], agentComposerDrafts: { original: 'Keep unsent input' } })
  await initializeSpatialControlFixture()
  return { root, configurationPath: path, spatial, folder, observerProject, bindings, local, forbidden, d, locatorWorkspacePath, get frozen() { return frozen } }
}
async function prepareProject(f: Awaited<ReturnType<typeof fixture>>, target = JSON.stringify(['host', 'D-in-B'])) {
  await button('New Agent'); await field('Project for this arrangement', f.observerProject.id)
  await field('Agent runs on', target); await button('Use project and Agent device')
  await vi.waitFor(() => expect([...document.querySelectorAll<HTMLButtonElement>('.goal-agent-picker button')].find(value => value.textContent === 'Create Agent')?.disabled).toBe(false))
}

it.each([{ carrier: 'local', agent: 'local' }, { carrier: 'local', agent: 'D-in-B' }, { carrier: 'B-in-A', agent: 'local' }, { carrier: 'B-in-A', agent: 'D-in-B' }])(
  'the Goal picker uses original Source $carrier and Agent $agent through real Main/public Host admission, without sending input or navigating', async ({ carrier, agent }) => {
  const f = await fixture(carrier), before = useAppStore.getState(), save = vi.fn(async () => false), oldMain = vi.spyOn(api.sessions, 'launchAgent')
  await dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={save} onClose={() => {}} />)
  await prepareProject(f, JSON.stringify(['host', agent]))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="New Goal Agent configuration"]')?.textContent).toContain(agent === 'local' ? 'Original B configuration' : 'Original D configuration'))
  await vi.waitFor(() => expect([...document.querySelectorAll<HTMLButtonElement>('.goal-agent-picker button')].find(value => value.textContent === 'Create Agent')?.disabled).toBe(false))
  expect(f.bindings.create).not.toHaveBeenCalled(); await button('Create Agent')
  await vi.waitFor(() => expect(readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')).toBeDefined())
  const birth = readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')!
  expect(birth.request, birth.issue).toMatchObject({ content: { inputRuntimeId: agent === 'local' ? 'B' : 'D', inputEpoch: agent === 'local' ? 'original-B-cut' : 'original-D-cut' } })
  await vi.waitFor(() => expect(agent === 'local' ? f.local.createHostAgentWithDelivery : f.bindings.create).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker__search')).not.toBeNull())
  const draft = readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')!
  expect(draft).toMatchObject({ kind: 'goal-source-create', receipt: { outcome: 'opened', save: { diskDurability: 'confirmed' } } })
  const admitted = spatialAgentOpenRecord((await f.spatial.read())!.graph, draft.operationId)!
  const selected = useAppStore.getState().goalAgentSelectionDrafts[key]
  expect(selected).toMatchObject({ selected: [{ kind: 'space-member', source: { runtimeId: 'B', spaceId: f.folder.spaceId, regionId: admitted.address.regionId,
    admission: { kind: 'creation', operationId: draft.operationId } }, execution: { runtimeId: agent === 'local' ? 'B' : 'D', agentSessionId: 'same-SID' } }],
    relationAccess: [{ access: { source: { hostId: carrier } } }] })
  if (agent !== 'local') {
    expect(f.frozen).toMatchObject({ agentRuntimeId: 'D', resourceRuntimeId: 'B', resourceWorkspacePath: '/B/original-project', agent: { createOperationId: draft.operationId, workspacePath: f.locatorWorkspacePath } })
    expect(f.d.hostEnvironment).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'same-SID' })
  } else expect(f.d.hostEnvironment).not.toHaveBeenCalled()
  expect(f.frozen?.agent.prompt).toBeUndefined(); expect(f.forbidden).not.toHaveBeenCalled(); expect(oldMain).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts); expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts); expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
})

it.each([undefined, 'restored-B-cut'])('a denied namespace observation keeps the original Runtime pin and lets its owner decide cut %s before any Start', async cut => {
  const f = await fixture(), originalCall = vi.mocked(api.spaceMounts.call).getMockImplementation()!
  f.local.readAgentInputEpoch.mockResolvedValue(cut)
  const reads = vi.fn()
  vi.mocked(api.spaceMounts.call).mockImplementation(async (method, input, signal) => {
    if (method === 'describe' && 'executionOnly' in input && input.executionOnly) { reads(); throw new AgentMuxError('Original qualification reader denied', 'CONTROL_PERMISSION_DENIED') }
    return await originalCall(method, input, signal)
  })
  await dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={async () => false} onClose={() => {}} />)
  await prepareProject(f, JSON.stringify(['host', 'local'])); await button('Create Agent')
  await vi.waitFor(() => expect(readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')).toBeDefined())
  const draft = readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')!
  expect(draft.request).toMatchObject({ content: { inputRuntimeId: 'B' } }); expect(draft.request.content).not.toHaveProperty('inputEpoch')
  expect(reads).toHaveBeenCalledOnce()
  if (cut === undefined) {
    await vi.waitFor(() => expect(f.local.createHostAgentWithDelivery).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')).toHaveProperty('receipt'))
    expect(readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')!.issue).toBeUndefined()
  } else {
    await vi.waitFor(() => expect(document.body.textContent).toContain('earlier or unconfirmed storage cut'))
    expect(f.local.createHostAgentWithDelivery).not.toHaveBeenCalled()
  }
  expect(f.bindings.create).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep unsent input')
})

it('an unsupported selected locator keeps the Goal request and composer draft without admission or a home retry', async () => {
  const f = await fixture(), before = useAppStore.getState(), render = () => dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={async () => false} onClose={() => {}} />)
  f.d.hostEnvironment.mockRejectedValueOnce(new AgentMuxError('The selected target cannot resolve an exact Agent workspace.', 'REMOTE_CORE_UPGRADE_REQUIRED'))
  await render(); await prepareProject(f); await button('Create Agent')
  await vi.waitFor(() => expect(document.body.textContent).toContain('The selected target cannot resolve an exact Agent workspace.'))
  expect(f.d.hostEnvironment).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'same-SID' })
  expect(f.bindings.admit).not.toHaveBeenCalled(); expect(f.bindings.create).not.toHaveBeenCalled(); expect(f.local.createHostAgentWithDelivery).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled()
  expect((await f.spatial.read())!.graph.regions).toEqual([])
  const original = useAppStore.getState().goalAgentCreationDrafts[key]
  expect(readGoalSourceCreationDraft(original, goal.id, 'assignees')).toMatchObject({ kind: 'goal-source-create', operationId: expect.any(String) })
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await dom.render(null); await render()
  expect(useAppStore.getState().goalAgentCreationDrafts[key]).toBe(original)
  expect(f.d.hostEnvironment).toHaveBeenCalledOnce(); expect(f.bindings.admit).not.toHaveBeenCalled(); expect(f.bindings.create).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled()
})

it('an original Reach C with an unknown ACK is inspected and explicitly continued through the same Main reference before the actual Source L, without a Launcher slot or repeated creation', async () => {
  const f = await fixture(), originalSpaceCall = vi.mocked(api.spaceMounts.call).getMockImplementation()!
  const epoch = vi.spyOn(api.sessions, 'readInputEpoch').mockResolvedValue('original-coordinator-cut')
  vi.spyOn(api.sessions, 'executionCoordinatorTarget').mockResolvedValue({ hostId: 'local', runtimeId: 'A' })
  vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: 'local', homeDirectory: '/A/original-home' })
  vi.mocked(api.spaceMounts.call).mockImplementation(async (method, input, signal) => method === 'executors' && 'hostId' in input && input.hostId === 'local'
    ? { runtimeId: 'A', executors: [{ executorId: 'A-selected', configRevision: 'A-revision', providerId: 'codex', label: 'Original A', command: '/A/cli', source: 'registered', availability: 'unknown', creationContract: { ordinaryLaunch: 1 } }] } as never
    : await originalSpaceCall(method, input, signal))
  let request!: AgentLaunchInput
  const created = (): AgentLaunchResult => ({ projectionFailures: [], created: { kind: 'agent', hostId: 'local', agentSessionId: request.agentSessionId!,
    providerId: 'codex', executorId: 'A-selected', workspacePath: '/A/original-home', run: { runId: 'original-A-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    creation: { createOperationId: request.createOperationId!, initialPrompt: 'not-requested' }, toolExecution: { bindingId: 'original-Main-binding', resourceHostId: 'B-in-A', resourceRuntimeId: 'B', workspacePath: '/B/original-project' } } })
  const target = () => ({ coordinator: { hostId: 'local', runtimeId: 'A' }, reference: { bindingId: 'original-Main-binding', agentSessionId: request.agentSessionId!, createOperationId: request.createOperationId! } })
  const inspection = () => ({ bindingId: 'original-Main-binding', agentHostId: 'local', resourceHostId: 'B-in-A', agentSessionId: request.agentSessionId!, resourceWorkspacePath: '/B/original-project', state: 'connected' as const,
    association: { state: 'confirmed' as const, reference: target().reference, agentRuntimeId: 'A', resourceRuntimeId: 'B', resourceWorkspacePath: '/B/original-project' } })
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => { request = input; throw Error('Original Main ACK lost after creation') })
  const resolve = vi.spyOn(api.sessions, 'resolveExecutionBinding').mockImplementation(async () => ({ target: target(), inspection: inspection() }))
  const continuing = vi.spyOn(api.sessions, 'continueExecution').mockImplementation(async input => { expect(input).toEqual(target()); return created() })
  vi.spyOn(api.sessions, 'executionBinding').mockImplementation(async (input, view) => { expect(input).toEqual(target()); expect(view).toBe('association'); return inspection() })
  const save = vi.fn(async () => false), render = () => dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={save} onClose={() => {}} />)
  await render(); await prepareProject(f, 'independent-coordinator'); await button('Create Agent')
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
  expect(request.inputEpoch).toBe('original-coordinator-cut')
  expect(request.inputRuntimeId).toBe('A')
  expect(epoch).toHaveBeenCalledExactlyOnceWith('local')
  await vi.waitFor(() => expect(document.body.textContent).toContain('Original Main ACK lost'))
  expect(request).toMatchObject({ hostId: 'local', workspacePath: '/A/original-home', executorId: 'A-selected', executorRevision: 'A-revision',
    toolWorkspace: { id: f.observerProject.id, hostId: 'B-in-A', path: '/B/original-project' }, sourceCoordinator: { runtimeId: 'A', resourceRuntimeId: 'B', workingDirectory: 'device-home' } })
  expect(request).not.toHaveProperty('launcher'); expect(request).not.toHaveProperty('prompt'); expect(request).not.toHaveProperty('executionWorkspaceId')
  const original = readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')!
  expect(original).toMatchObject({ kind: 'goal-coordinator-create', submitted: true, request, association: { submitted: false } })
  await dom.render(null); await render()
  expect(launch).toHaveBeenCalledOnce(); expect(resolve).not.toHaveBeenCalled(); expect(continuing).not.toHaveBeenCalled()
  await button('Check original creation')
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: request.agentSessionId, createOperationId: request.createOperationId, toolWorkspace: request.toolWorkspace })
  expect(continuing).not.toHaveBeenCalled(); await button('Continue original creation')
  await vi.waitFor(() => expect(continuing).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker__search')).not.toBeNull())
  const retained = readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')!
  expect(retained.kind).toBe('goal-coordinator-create')
  if (retained.kind !== 'goal-coordinator-create') throw Error('Expected original C/L intent')
  expect(retained.request).toBe(original.request); expect(retained.association.operationId).toBe(original.kind === 'goal-coordinator-create' ? original.association.operationId : '')
  expect(useAppStore.getState().goalAgentSelectionDrafts[key]).toMatchObject({ selected: [{ source: { admission: { kind: 'association', operationId: retained.association.operationId } },
    execution: { runtimeId: 'A', agentSessionId: request.agentSessionId } }], relationAccess: [{ access: { source: { hostId: 'B-in-A' }, coordinator: { hostId: 'local' } } }] })
  expect(launch).toHaveBeenCalledOnce(); expect(f.bindings.create).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
})

it.each(['typed', 'opaque'] as const)('a late original C keeps the created occurrence and a newer $0 relationship selection without replacing its input', async kind => {
  const f = await fixture(), create = f.bindings.create.getMockImplementation()!
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve })
  f.bindings.create.mockImplementation(async input => { await waiting; return await create(input) })
  await dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={async () => false} onClose={() => {}} />)
  await prepareProject(f); await button('Create Agent'); await vi.waitFor(() => expect(f.bindings.create).toHaveBeenCalledOnce())
  const opaque = { goalId: goal.id, role: 'assignees', selected: kind === 'opaque' ? [{ kind: 'future-Source', originalInput: 'Keep this newer selection' }] : ['original-later-choice'], expectedUpdatedAt: 1 }
  await act(async () => useAppStore.setState(state => ({ goalAgentSelectionDrafts: { ...state.goalAgentSelectionDrafts, [key]: opaque } })))
  await act(async () => release())
  await vi.waitFor(() => expect(readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')).toHaveProperty('receipt'))
  const calls = vi.mocked(api.spaceMounts.call)
  await vi.waitFor(() => expect(calls.mock.calls.filter(([method]) => method === 'snapshot')).toHaveLength(1))
  await act(async () => { await calls.mock.results[calls.mock.calls.findIndex(([method]) => method === 'snapshot')]!.value })
  expect(useAppStore.getState().goalAgentSelectionDrafts[key]).toBe(opaque)
  expect(readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')).toMatchObject({ submitted: true, receipt: { to: { spaceId: f.folder.spaceId } } })
  expect(f.bindings.create).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled()
})

it('a confirmed relationship Save completes only its exact durable Source creation, so the next picker can create another Agent', async () => {
  const f = await fixture(), save = vi.fn(async () => false), close = vi.fn()
  const render = () => dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={save} onClose={close} />)
  await render(); await prepareProject(f); await button('Create Agent')
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker__search')).not.toBeNull())
  const completed = useAppStore.getState().goalAgentCreationDrafts[key]
  expect(readGoalSourceCreationDraft(completed, goal.id, 'assignees')).toMatchObject({ receipt: { outcome: 'opened', save: { diskDurability: 'confirmed' } } })
  await button('Save relationships')
  await vi.waitFor(() => expect(document.body.textContent).toContain('Relationships are not saved'))
  expect(useAppStore.getState().goalAgentCreationDrafts[key]).toBe(completed)
  save.mockResolvedValue(true); await button('Save relationships')
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(useAppStore.getState().goalAgentCreationDrafts[key]).toBeUndefined()
  expect(f.bindings.create).toHaveBeenCalledOnce()
  const original = spatialAgentOpenRecord((await f.spatial.read())!.graph, readGoalSourceCreationDraft(completed, goal.id, 'assignees')!.operationId)
  expect(original?.agentSessionId).toBe('same-SID')
  await dom.render(null); await render(); await button('New Agent')
  expect(document.querySelector('[aria-label="Project for this arrangement"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Original Agent request retained')
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph, original!.requestId)).toEqual(original)
  expect(f.forbidden).not.toHaveBeenCalled()
})

it.each(['partial', 'unconfirmed-save'] as const)('an unconfirmed Source receipt $0 stays in the original private creation leaf after a successful relationship Save', async mode => {
  const f = await fixture(), calls = vi.mocked(api.spaceMounts.call), forward = calls.getMockImplementation()!
  calls.mockImplementation(async (method, input, signal) => {
    const value = await forward(method, input, signal)
    if (method !== 'open') return value
    const receipt = value as import('../../../packages/core/src/public-rpc').AgentMuxRpcResult<'agent.open'>
    return (mode === 'partial' ? { ...receipt, outcome: 'partial' } : { ...receipt, save: { ...receipt.save, diskDurability: 'unconfirmed' } }) as typeof value
  })
  const save = vi.fn(async () => true), close = vi.fn()
  await dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={save} onClose={close} />)
  await prepareProject(f); await button('Create Agent')
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker__search')).not.toBeNull())
  const original = useAppStore.getState().goalAgentCreationDrafts[key]
  await button('Save relationships'); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(useAppStore.getState().goalAgentCreationDrafts[key]).toBe(original)
  expect(f.bindings.create).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled()
})

it.each(['typed', 'opaque'] as const)('a late confirmed relationship ACK preserves a newer $0 private creation request', async kind => {
  const f = await fixture(); let resolve!: (value: boolean) => void
  const saved = new Promise<boolean>(done => { resolve = done }), save = vi.fn(() => saved), close = vi.fn()
  await dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={save} onClose={close} />)
  await prepareProject(f); await button('Create Agent')
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker__search')).not.toBeNull())
  const original = useAppStore.getState().goalAgentCreationDrafts[key]
  await button('Save relationships'); expect(save).toHaveBeenCalledOnce()
  const next = kind === 'opaque' ? { kind: 'future-creation', input: 'Keep original opaque bytes' } : { ...readGoalSourceCreationDraft(original, goal.id, 'assignees')!, issue: 'Updated in another window' }
  await act(async () => useAppStore.setState(state => ({ goalAgentCreationDrafts: { ...state.goalAgentCreationDrafts, [key]: next } })))
  await act(async () => resolve(true)); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(useAppStore.getState().goalAgentCreationDrafts[key]).toBe(next)
  expect(f.bindings.create).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled()
})

it.each(['typed', 'opaque'] as const)('a late readonly Check after close and reopen retains a newer $0 relationship selection and the original Source request', async kind => {
  const f = await fixture(), render = () => dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={async () => false} onClose={() => {}} />)
  await render(); await prepareProject(f); await button('Create Agent')
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker__search')).not.toBeNull())
  const original = useAppStore.getState().goalAgentCreationDrafts[key]
  await dom.render(null); await render()
  const calls = vi.mocked(api.spaceMounts.call), forward = calls.getMockImplementation()!
  let release!: () => void; const blocked = new Promise<void>(done => { release = done })
  calls.mockImplementation(async (method, input, signal) => { if (method === 'snapshot') await blocked; return await forward(method, input, signal) })
  await button('Check original creation')
  await vi.waitFor(() => expect(calls.mock.calls.filter(([method]) => method === 'snapshot')).toHaveLength(2))
  await dom.render(null)
  const next = { goalId: goal.id, role: 'assignees', selected: kind === 'typed' ? ['new choice while closed'] : [{ kind: 'future-choice', input: 'Keep opaque selection' }], expectedUpdatedAt: 1 }
  await act(async () => useAppStore.setState(state => ({ goalAgentSelectionDrafts: { ...state.goalAgentSelectionDrafts, [key]: next } })))
  await render(); await act(async () => release())
  const index = calls.mock.calls.map(([method]) => method).lastIndexOf('snapshot')
  await act(async () => { await calls.mock.results[index]!.value })
  expect(useAppStore.getState().goalAgentSelectionDrafts[key]).toStrictEqual(next)
  expect(useAppStore.getState().goalAgentCreationDrafts[key]).toBe(original)
  expect(f.bindings.create).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled()
})

it('failed private saving keeps a not-sent Source request and later explicit first send uses the same original C', async () => {
  const f = await fixture(), render = () => dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={async () => false} onClose={() => {}} />)
  await render(); await prepareProject(f)
  const originalWrite = localStorage.setItem.bind(localStorage)
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (key === 'agentmux-workbench-v1') throw Error('Private file ACK unavailable'); originalWrite(key, value) })
  await button('Create Agent'); await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type=submit]')?.disabled).toBe(false))
  expect(f.bindings.create).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Saving the original creation request or receipt is unconfirmed')
  const original = readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')!
  expect(original.submitted).toBe(false); expect(f.bindings.create).not.toHaveBeenCalled()
  write.mockRestore(); await dom.render(null); await render()
  expect(f.bindings.create).not.toHaveBeenCalled(); await button('Save request and create once')
  await vi.waitFor(() => expect(f.bindings.create).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker__search')).not.toBeNull())
  expect(f.frozen?.agent.createOperationId).toBe(original.operationId)
  expect(readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goal.id, 'assignees')?.operationId).toBe(original.operationId)
  expect(f.forbidden).not.toHaveBeenCalled()
})

it('the original Mote producer keeps one legacy OP through actual Source Host preparation and read-only lost-ACK recovery, without sending the Goal task', async () => {
  const { ScratchTopics } = await import('../../host/src/mote-resources')
  const { directoryIdentity, homeZoneId } = await import('../src/shared/space-addresses')
  const { scratchTopicsScope } = await import('../src/renderer/src/lib/scratch-topic-snapshots')
  const f = await fixture('local'), scratch = { id: '__scratch__', name: 'Topics', hostId: 'local', path: join(f.root, 'topics'), kind: 'folder' as const }
  const topics = new ScratchTopics(), topic = await topics.ensureMote(scratch, 'launcher:original-goal-mote')
  const { scratchTopicIdentityPath } = await import('../../host/src/mote-model')
  const topicPath = scratchTopicIdentityPath(scratch, topic)
  const spaceId = directoryIdentity('local', topicPath), zoneId = homeZoneId(spaceId), state = (await f.spatial.read())!
  const graph = structuredClone(state.graph)
  graph.spaces.push({ spaceId, kind: 'mote', name: topic.title, hostId: 'local', directoryPath: topicPath, projectId: null, topicId: topic.id })
  graph.zones.push({ zoneId, workspaceId: scratch.id, kind: 'home', hostId: 'local', directoryPath: topicPath, branch: null })
  graph.bindings.push({ zoneId, spaceId }); await f.spatial.commit({ expectedRevision: state.revision, graph })
  const config = { ...useAppStore.getState().config!, workspaces: [...useAppStore.getState().config!.workspaces, scratch] }
  await writeFile(f.configurationPath, JSON.stringify(config))
  useAppStore.setState({ config, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], error: null, reading: false } } })
  const originalSpace = api.spaceMounts.call, calls: string[] = []
  vi.spyOn(useAppStore.getState(), 'executeControl').mockImplementation(async request => {
    calls.push(request.operation)
    const target = { hostId: 'local', reference: { runtimeId: 'B', spaceId } }
    if (request.operation === 'agent.open') {
      await originalSpace('open', { ...target, request: { operationId: request.requestId, content: request.content, destination: request.destination, focus: false } })
      throw Error('Original Mote creation ACK lost')
    }
    if (request.operation === 'space.inspect' && 'requestId' in request.target) {
      const value = await originalSpace('inspect', { ...target, requestId: request.target.requestId })
      const report = value.request?.report
      const adapted = report ? (({ operationId, ...body }) => ({ ...body, requestId: operationId }))(report) : null
      return { operation: 'space.inspect', catalog: value.catalog, ...(value.request ? { request: { requestId: value.request.operationId, known: value.request.known, report: adapted } } : {}) }
    }
    throw Error('This fixture never sends the Goal task or substitutes another control operation.')
  })
  const render = () => dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={async () => false} onClose={() => {}} />)
  await render()
  const modes = document.querySelector('[role="radiogroup"][aria-label="Agent source"]')!
  expect(modes.querySelector('[data-option="existing"]')?.getAttribute('aria-checked')).toBe('true')
  await button('Mote · new Session')
  expect(modes.querySelector('[data-option="mote"]')?.getAttribute('aria-checked')).toBe('true')
  await field('Mote for new Session', topic.id)
  await field('New Session Agent configuration', 'codex')
  expect(calls).toEqual([])
  await button('Create Mote Session'); await vi.waitFor(() => expect(document.body.textContent).toContain('Original Mote creation ACK lost'))
  expect(f.local.createHostAgentWithDelivery).toHaveBeenCalledOnce()
  const original = useAppStore.getState().goalAgentCreationDrafts[key]
  expect(original).toMatchObject({ phase: 'may-have-dispatched', request: { content: { kind: 'new-agent', executorId: 'codex' } } })
  expect(f.local.createHostAgentWithDelivery.mock.calls[0]![0]).toMatchObject({ workspacePath: topicPath, sourceAgentMuxNote: expect.stringContaining(`Your persistent Mote identity is ${topic.id}`), optionalContext: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Mote personality from') })]) })
  expect(f.local.createHostAgentWithDelivery.mock.calls[0]![0]).not.toHaveProperty('prompt')
  await dom.render(null); await render(); await vi.waitFor(() => expect(document.body.textContent).toContain('Original Session observed'))
  expect(calls.filter(value => value === 'agent.open')).toHaveLength(1); expect(calls).toContain('space.inspect')
  expect(f.local.createHostAgentWithDelivery).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled()
  expect(useAppStore.getState().goalAgentCreationDrafts[key]).toBe(original)
  expect(useAppStore.getState().goalAgentSelectionDrafts[key]).toMatchObject({ selected: ['same-SID'] })
})
