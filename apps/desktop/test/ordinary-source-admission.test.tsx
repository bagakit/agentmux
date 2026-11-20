// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxError } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { spatialAgentOpenDigest, spatialAgentOpenRecord } from '../../../packages/core/src/spatial-agent-open'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { readSpaceSnapshot } from '../../../packages/core/src/space-authority-stream'
import { createHostRouteInventoryFixture } from '../../../packages/core/test/helpers/host-route-inventory-fixture'
import { createHostSpatialAgentControl } from '../../host/src/spatial-agent-control'
import type { AgentMuxHeadlessRuntime } from '../../../packages/core/src/headless-runtime'
import type { AgentExecutionOpenInput } from '../../../packages/core/src/agent-execution-coordinator'
import type { AgentMuxAgentSession } from '../../../packages/core/src/types'
import type { HostRouteExecutionAccess } from '../../../packages/core/src/host-route-gateway'
import type { AdoptedHostRoute } from '../../../packages/core/src/host-route'
import type { SpaceMountRecord } from '../src/shared/space-mount'
import { spaceMountKey } from '../src/shared/space-mount'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { mountedAgentOpenInput, mountedAgentOpenKey } from '../src/renderer/src/lib/space-mount-launch'
import { originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from '../src/renderer/src/lib/original-space-navigation'
import { api } from '../src/renderer/src/lib/api'
import * as storeModule from '../src/renderer/src/store'
import { useAppStore } from '../src/renderer/src/store'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

/** The final executor/Native port is explicit controlled data. Route storage,
 * signed discovery, trusted Main/Preload, RPC and Host spatial admission are
 * actual owners. Native effects and restart proof are separate evidence. */
test.each([false, true])('ordinary Source Start crosses the real Main, signed public RPC and Host admission with complete original fields (description denied=%s)', async descriptionDenied => {
  const root = await mkdtemp(join(tmpdir(), 'amx-route-admission-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const project = { id: 'source-project', hostId: 'local', name: 'Source project', path: '/source/project' }
  const agentWorkspacePath = '/executor/agent-workspaces/original-target-session'
  const folder = await spatial.registerFolder(project)
  const owner = { runtimeId: 'runtime-B', ownerInstanceId: 'source-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' as const }
  let session: AgentMuxAgentSession | undefined, frozen: AgentExecutionOpenInput | undefined
  const input = vi.fn(async () => { throw Error('This admission proof never sends an Agent input.') })
  const d = {
    readAgentInputEpoch: vi.fn(async (): Promise<string | undefined> => descriptionDenied ? undefined : 'original-route-cut'),
    resolveAgentCreationSessionId: vi.fn(async () => 'original-target-session'),
    inspectAgentCreation: vi.fn(async () => {
      if (!session) throw new AgentMuxError('The controlled executor has not returned a Session.', 'AGENT_CREATION_UNKNOWN')
      return session
    }),
    listHostExecutors: vi.fn(async (params: { refresh: boolean; executorId: string }) => await route.original.client.listHostExecutors(params)),
    hostEnvironment: vi.fn(async (selector?: { agentSessionId: string }) => selector ? { homeDirectory: '/executor/home',
      agentWorkspace: { runtimeId: 'runtime-D', agentSessionId: selector.agentSessionId, workspacePath: agentWorkspacePath } } : { homeDirectory: '/executor/home' }),
    writeAgent: input, pasteAgent: input, submitAgentPrompt: input
  }
  const reference = () => ({ bindingId: frozen!.bindingId, agentSessionId: frozen!.agent.agentSessionId, createOperationId: frozen!.agent.createOperationId })
  const bindings = {
    admit: vi.fn(async (value: AgentExecutionOpenInput) => { frozen = structuredClone(value); return reference() }),
    create: vi.fn(async (value: AgentExecutionOpenInput) => {
      frozen = structuredClone(value)
      session = { kind: 'agent', agentSessionId: value.agent.agentSessionId, hostId: 'local', providerId: 'claude', executorId: value.agent.executorId,
        workspacePath: value.agent.workspacePath, run: { runId: 'controlled-target-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
        toolExecution: { bindingId: value.bindingId, resourceHostId: value.resourceHostId, resourceRuntimeId: value.resourceRuntimeId, workspacePath: value.resourceWorkspacePath },
        creation: { createOperationId: value.agent.createOperationId, executorRevision: value.agent.executorRevision,
          createdRun: { runId: 'controlled-target-run' }, initialPrompt: 'unconfirmed' } } as AgentMuxAgentSession
      return { session, creation: session.creation!, execution: {} }
    }),
    inspectSourceAdmission: async (bindingId: string) => bindings.inspect(bindingId, 'association'),
    inspect: vi.fn(async (bindingId: string, view?: 'association') => frozen && bindingId === frozen.bindingId ? { bindingId: frozen.bindingId, agentHostId: frozen.agentHostId, resourceHostId: frozen.resourceHostId,
      agentSessionId: frozen.agent.agentSessionId, resourceWorkspacePath: frozen.resourceWorkspacePath,
      continuation: reference(), state: session?.creation?.createOperationId === frozen.agent.createOperationId ? 'connected' as const : 'unavailable' as const,
      ...(view === 'association' ? { association: { state: 'confirmed' as const, reference: reference(), agentRuntimeId: frozen.agentRuntimeId,
        resourceRuntimeId: frozen.resourceRuntimeId, resourceWorkspacePath: frozen.resourceWorkspacePath,
        agent: { executorId: frozen.agent.executorId, executorRevision: frozen.agent.executorRevision, workspacePath: frozen.agent.workspacePath },
        ...(frozen.sourceRequestDigest ? { sourceRequestDigest: frozen.sourceRequestDigest } : {}) } } : {}) } : null),
    continueOriginal: vi.fn(async () => {
      if (!frozen) throw Error('The original frozen intent is absent.')
      const created = session?.creation?.createOperationId === frozen.agent.createOperationId ? { session, creation: session.creation! } : await bindings.create(frozen)
      return { ...created, execution: await bindings.inspect(frozen.bindingId) }
    })
  }
  const localLookup = vi.fn(async () => { throw Error('The project Core cannot substitute its local Session catalogue.') })
  const executionHost = vi.fn(async (hostId: string, adoptedRoute: AdoptedHostRoute | undefined, access: HostRouteExecutionAccess | undefined) => {
    expect(hostId).toBe('collision'); expect(adoptedRoute).toEqual(route.route)
    if (access && 'call' in access) expect(access.call.params).toMatchObject({ content: { agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: route.route } } })
    return { runtimeId: 'runtime-D', client: d }
  })
  const runtime = { ownerIdentity: () => owner, executionHost, executionBindings: bindings, client: { inspectAgentCreation: localLookup } } as unknown as AgentMuxHeadlessRuntime
  const route = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>, {
    spatialState: spatial,
    spatialAgentControl: createHostSpatialAgentControl({ configurationPath: join(root, 'unused-executor-config.json'), spatial, runtime: () => runtime }),
    hostedRuntime: () => ({ call: async () => ({ owner }), assertFence: () => {}, subscribe: async () => { throw Error('No general Host subscription is needed.') } }) as never
  })
  const before = await route.b.rpc.call('route.inspect', {})
  const saved = await route.b.rpc.call('route.configure', { expectedRevision: before.revision, operationId: 'save-source-launch-route', configuration: {
    routes: [{ id: 'collision', route: route.route }], grants: [route.grant('source-viewer', route.a.identity, route.b.identity,
      [...(descriptionDenied ? [] : ['agent.open.describe']), 'runtime.owner.identity', 'route.choices', 'route.executors', 'agent.open', 'space.inspect', 'space.snapshot'])] } })
  const retained = await route.b.rpc.call('route.inspect', {})
  expect(retained.routes).toEqual([{ id: 'collision', route: route.route }])
  expect(saved.settings.operation?.operationId).toBe('save-source-launch-route')
  const carrier = { forwardRpc: async (method: string, params: unknown, context: unknown) => method === 'settings.hosts.ls'
    ? { hosts: [{ id: 'local', kind: 'local', label: 'Project device' }] }
    : await route.rpc.call(method as never, params as never, context as never), subscribeRpc: route.rpc.subscribe.bind(route.rpc) }
  const target: SpaceMountRecord = { hostId: 'source-B', reference: { runtimeId: owner.runtimeId, spaceId: folder.spaceId }, workspaceId: project.id, zoneId: folder.zoneId }
  const initialSnapshot = await readSpaceSnapshot(route.rpc, target.reference)
  const sourceProject = initialSnapshot.scope?.zones.find(zone => zone.zoneId === folder.zoneId)
  expect(sourceProject).toMatchObject({ workspaceId: project.id, hostId: 'local', directoryPath: '/source/project' })
  const transport = spaceMountTransport(cleanup, [{ id: target.hostId, carrier: carrier as never }])
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(transport.api.call)
  const originalProject = { ...project, kind: 'folder' as const, hostId: target.hostId }
  const tab = createWorkbenchTab('ordinary-launcher-tab', { kind: 'launcher', regionId: 'ordinary-launcher-slot', workspaceId: project.id })
  const slot = { kind: 'region' as const, tabId: tab.id, regionId: 'ordinary-launcher-slot' }, key = mountedAgentOpenKey(target, slot)
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockImplementation(async () => { expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.submitted).toBe(true) })
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, { id: target.hostId, kind: 'ssh', hostname: 'private-source.invalid', label: 'Project B' }], workspaces: [originalProject] },
    mountedSpaceInputs: {}, mountedSpaceObservations: {}, tabs: { [tab.id]: tab }, layouts: { [project.id]: createWorkspaceLayout('original-group', [tab.id]) }, activeWorkspaceId: project.id,
    agentComposerDrafts: { [slot.regionId]: '  Work in the original source project\n' }, agentComposerNotes: { [slot.regionId]: ' separate caller note\n' },
    launcherNameDrafts: { [slot.regionId]: { agentName: 'Private original Agent name', tabName: 'Private original Tab name' } },
    launcherOptionDrafts: { [slot.regionId]: { claude: { model: 'original-unlisted-value' } } }, prewarmTerminal: vi.fn(), detectExecutors: vi.fn(), sessions: [], workbenchSpaceSelection: null })
  useLauncherState.setState({ sections: {}, executors: {}, drafts: { ['region:' + slot.regionId]: { browser: '', note: '', sourceExecution: {
    project: { id: originalProject.id, hostId: originalProject.hostId, path: originalProject.path }, target,
    agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: route.route }, executorId: 'same-executor'
  } } } })
  await dom.render(<NewTabSurface tabId={tab.id} regionId={slot.regionId} tabGroupId="original-group" />)
  const start = () => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Launch')!
  await vi.waitFor(async () => { await act(async () => {}); expect(start().disabled, dom.container.textContent ?? '').toBe(false) })
  await act(async () => { start().click() })
  await vi.waitFor(() => expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)).toBeDefined())
  const birth = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)!
  expect(birth.request.content).toMatchObject({ inputRuntimeId: 'runtime-D' })
  if (descriptionDenied) expect(birth.request.content).not.toHaveProperty('inputEpoch')
  else expect(birth.request.content).toHaveProperty('inputEpoch', 'original-route-cut')
  await vi.waitFor(() => expect(bindings.create,dom.container.textContent ?? '').toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.receipt?.outcome).toBe('partial'))
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)!
  const state = (await spatial.read())!, admitted = spatialAgentOpenRecord(state.graph, original.request.operationId!)!
  expect(admitted).toMatchObject({ agentSessionId: 'original-target-session', requestId: original.request.operationId,
    placement: { runtimeId: owner.runtimeId, hostId: 'local', workspacePath: '/source/project', workspaceId: project.id },
    execution: { runtimeId: 'runtime-D', hostId: 'collision', workspacePath: agentWorkspacePath, adoptedRoute: route.route } })
  expect(d.hostEnvironment.mock.calls.filter(([selector]) => selector !== undefined)).toEqual([[{ agentSessionId: 'original-target-session' }]])
  expect(admitted.digest).toBe(spatialAgentOpenDigest(rpcControlRequest('agent.open', original.request) as never))
  expect(frozen).toMatchObject({ agentRuntimeId: 'runtime-D', agentRoute: route.route, resourceRuntimeId: owner.runtimeId, resourceWorkspacePath: '/source/project',
    agent: { agentSessionId: admitted.agentSessionId, createOperationId: admitted.requestId, workspacePath: agentWorkspacePath, prompt: '  Work in the original source project\n', launchOptions: { model: 'original-unlisted-value' }, agentMuxNote: ' separate caller note\n' } })
  const snapshot = await readSpaceSnapshot(route.rpc, target.reference)
  expect(snapshot.scope?.regions).toContainEqual(expect.objectContaining({ regionId: admitted.address.regionId, creationOperationId: admitted.requestId, agentSessionId: admitted.agentSessionId,
    execution: expect.objectContaining({ cwd: agentWorkspacePath }) }))
  expect(original.request.content).toMatchObject({ kind: 'new-agent', agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: route.route } })
  expect(bindings.admit).toHaveBeenCalledOnce(); expect(bindings.continueOriginal).toHaveBeenCalledOnce(); expect(localLookup).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
  expect(original.origin?.names).toEqual({ agentName: 'Private original Agent name', tabName: 'Private original Tab name' })
  expect(useAppStore.getState().tabs[tab.id]?.regions[slot.regionId]?.kind).toBe('launcher')
  expect(useAppStore.getState().agentComposerDrafts[slot.regionId]).toBe('  Work in the original source project\n')
  const observerTabs = useAppStore.getState().tabs, observerLayouts = useAppStore.getState().layouts
  const openOriginal = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Open original work')!
  expect(openOriginal).toBeDefined()
  await act(async () => openOriginal.click())
  await vi.waitFor(() => expect(useAppStore.getState().workbenchSpaceSelection?.zoneId,dom.container.textContent ?? '').toBe(target.zoneId))
  const privateView = (useAppStore.getState().mountedSpaceInputs as Record<string, { view?: unknown }>)[spaceMountKey(target.reference)]?.view
  expect(privateView).toBeUndefined()
  expect(Object.hasOwn(useAppStore.getState(),'selectedSpaceMount')).toBe(false)
  const projectionWorkspaceId = originalSourceWorkspaceId(target), projectionTabId = originalSourceTabProjectionId(target, admitted.address.tabId), projectionRegionId = originalSourceRegionProjectionId(target, admitted.address.regionId)
  expect(useAppStore.getState().activeWorkspaceId).toBe(projectionWorkspaceId)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ sourceRuntimeId: target.reference.runtimeId, spaceId: target.reference.spaceId, zoneId: target.zoneId,
    workspaceId: projectionWorkspaceId, tabId: projectionTabId, regionId: projectionRegionId })
  for(const [id,originalTab] of Object.entries(observerTabs)) expect(useAppStore.getState().tabs[id]).toBe(originalTab)
  for(const [id,originalLayout] of Object.entries(observerLayouts)) expect(useAppStore.getState().layouts[id]).toBe(originalLayout)
  await dom.render(<WorkspaceWorkbench workspaceId={projectionWorkspaceId} visible />)
  const region = (id: string) => [...dom.container.querySelectorAll<HTMLElement>('[data-workbench-region-id]')].find(element => element.dataset.workbenchRegionId === id)
  const workbenchTab = (id: string) => [...dom.container.querySelectorAll<HTMLElement>('[data-workbench-tab-id]')].find(element => element.dataset.workbenchTabId === id)
  await vi.waitFor(() => expect(region(projectionRegionId)).toBeDefined())
  expect(workbenchTab(projectionTabId),dom.container.innerHTML).toBeDefined()
  expect(dom.container.querySelectorAll('[data-mounted-space-nav], [data-mounted-space]')).toHaveLength(0)
  for(const [id,originalTab] of Object.entries(observerTabs)) expect(useAppStore.getState().tabs[id]).toBe(originalTab)
  for(const [id,originalLayout] of Object.entries(observerLayouts)) expect(useAppStore.getState().layouts[id]).toBe(originalLayout)
  await dom.render(<WorkspaceSidebar />)
  const originalRow = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-workspace-id]')].find(row => row.dataset.workspaceId === projectionWorkspaceId)!
  expect(originalRow).toBeDefined()
  expect(originalRow.getAttribute('data-original-source-space')).toBe(target.reference.spaceId)
  const openOriginalAction = vi.spyOn(useAppStore.getState(),'openOriginalSpaceLocation')
  await act(async () => originalRow.click())
  expect(openOriginalAction).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ hostId: target.hostId }) }))
  expect(input).not.toHaveBeenCalled()
  const evidence = process.env.ADMISSION_EVIDENCE_DIR
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'public-join.json'), JSON.stringify({ saved, retained, initialSnapshot, request: original.request,
      receipt: original.receipt, admitted, snapshot, execution: frozen,
      controls: { creations: bindings.create.mock.calls.length, continuations: bindings.continueOriginal.mock.calls.length,
        projectLocalSessionLookups: localLookup.mock.calls.length, AgentInputCalls: input.mock.calls.length },
      boundary: 'Actual saved-route discovery, trusted Main/Preload, signed public Source RPC, Host admission and snapshot. The executor/Native port is controlled; no physical Native or prompt effect is claimed.' }, null, 2))
  }
})
