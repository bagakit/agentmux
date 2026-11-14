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
import { MountedSpaceLauncher } from '../src/renderer/src/components/MountedSpaceLauncher'
import { mountedAgentOpenInput, mountedAgentOpenKey } from '../src/renderer/src/lib/space-mount-launch'
import { api } from '../src/renderer/src/lib/api'
import * as storeModule from '../src/renderer/src/store'
import { useAppStore } from '../src/renderer/src/store'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

/** The final executor/Native port is explicit controlled data. Route storage,
 * signed discovery, trusted Main/Preload, RPC and Host spatial admission are
 * actual owners. Native effects and restart proof are separate evidence. */
test('a saved source route reaches original Host admission from the real Launcher without replacing its request', async () => {
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
      ['runtime.owner.identity', 'route.choices', 'route.executors', 'agent.open', 'space.inspect', 'space.snapshot'])] } })
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
  const slot = { kind: 'new-work' as const, zoneId: folder.zoneId }, key = mountedAgentOpenKey(target, slot)
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockImplementation(async () => { expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.submitted).toBe(true) })
  useAppStore.setState({ mountedSpaceInputs: {}, mountedSpaceObservations: {} }); useAppStore.getState().mountSpace(target)
  await dom.render(<MountedSpaceLauncher target={target} project={sourceProject!} slot={slot} mountKey={spaceMountKey(target.reference)} active />)
  const device = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent device"]')!
  await vi.waitFor(() => expect(Array.from(device.options).some(option => option.textContent?.includes('2 hops'))).toBe(true))
  await act(async () => { device.value = Array.from(device.options).find(option => option.textContent?.includes('2 hops'))!.value; device.dispatchEvent(new Event('change', { bubbles: true })) })
  const executor = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent configuration"]')!
  await vi.waitFor(() => expect(executor.textContent, dom.container.textContent ?? '').toContain('runtime-D original'))
  await act(async () => { executor.value = 'same-executor'; executor.dispatchEvent(new Event('change', { bubbles: true })) })
  const prompt = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="New mounted Space task draft"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Work in the original source project'); prompt.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start in original Space')!.click() })
  await vi.waitFor(() => expect(bindings.create).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.receipt?.outcome).toBe('partial'))
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)!
  const state = (await spatial.read())!, admitted = spatialAgentOpenRecord(state.graph, original.request.operationId!)!
  expect(admitted).toMatchObject({ agentSessionId: 'original-target-session', requestId: original.request.operationId,
    placement: { runtimeId: owner.runtimeId, hostId: 'local', workspacePath: '/source/project', workspaceId: project.id },
    execution: { runtimeId: 'runtime-D', hostId: 'collision', workspacePath: agentWorkspacePath, adoptedRoute: route.route } })
  expect(d.hostEnvironment.mock.calls.filter(([selector]) => selector !== undefined)).toEqual([[{ agentSessionId: 'original-target-session' }]])
  expect(admitted.digest).toBe(spatialAgentOpenDigest(rpcControlRequest('agent.open', original.request) as never))
  expect(frozen).toMatchObject({ agentRuntimeId: 'runtime-D', agentRoute: route.route, resourceRuntimeId: owner.runtimeId, resourceWorkspacePath: '/source/project',
    agent: { agentSessionId: admitted.agentSessionId, createOperationId: admitted.requestId, workspacePath: agentWorkspacePath, prompt: 'Work in the original source project' } })
  const snapshot = await readSpaceSnapshot(route.rpc, target.reference)
  expect(snapshot.scope?.regions).toContainEqual(expect.objectContaining({ regionId: admitted.address.regionId, creationOperationId: admitted.requestId, agentSessionId: admitted.agentSessionId,
    execution: expect.objectContaining({ cwd: agentWorkspacePath }) }))
  expect(original.request.content).toMatchObject({ kind: 'new-agent', agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: route.route } })
  expect(bindings.admit).toHaveBeenCalledOnce(); expect(bindings.continueOriginal).toHaveBeenCalledOnce(); expect(localLookup).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
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
