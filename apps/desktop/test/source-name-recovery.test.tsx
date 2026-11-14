import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
import type { AgentMuxStoredAgentSession } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { spatialAgentFact, isSpatialAgentAssociation } from '../../../packages/core/src/spatial-agent-open-contract'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { sendSourceLauncherRequest } from '../src/renderer/src/lib/source-launcher-request'
import { mountedAgentOpenKey, mountedAgentOpenInput, type MountedAgentOpenInput } from '../src/renderer/src/lib/space-mount-launch'
import { sourceCoordinatorInputKey, sourceCoordinatorInput, type SourceCoordinatorInput } from '../src/renderer/src/lib/source-coordinator-input'
import { originalLaunchName, type LaunchNameOwner } from '../src/renderer/src/lib/original-launch-names'
import { SourceLauncherRequest } from '../src/renderer/src/components/SourceLauncherRequest'
import { SourceCoordinatorRequests } from '../src/renderer/src/components/SourceCoordinatorRequests'

const cleanup: Array<() => unknown | Promise<unknown>> = [], initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private observer' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, saveBookmark: true, viewport: true, more: true } } }
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); useAppStore.setState(initial, true); localStorage.clear() })
async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup), before = await f.d.put('original-recovery-SID')
  const session: AgentMuxStoredAgentSession = { ...before, creation: { createOperationId: 'original-recovery-C', initialPrompt: 'unknown' } }
  await (f.d.core as unknown as { registry: { put(session: AgentMuxStoredAgentSession, expected: AgentMuxStoredAgentSession['run']): Promise<void> } }).registry.put(session, before.run)
  const admitted = await f.admit('D-in-B', f.d.owner.runtimeId, session.agentSessionId, 'original-recovery-C')
  if (admitted.address.zoneId === null) throw Error('The original registered Source Zone is required')
  const transport = spaceMountTransport(cleanup, [{ id: 'B-original-carrier', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } },
    { id: 'local', carrier: { forwardRpc: f.d.rpc.call.bind(f.d.rpc), subscribeRpc: f.d.rpc.subscribe.bind(f.d.rpc) } }])
  const native = vi.spyOn(f.d.core, 'connectRuntime').mockRejectedValue(Error('No Native during names'))
  const target = { hostId: 'B-original-carrier', reference: f.reference, zoneId: admitted.address.zoneId, workspaceId: 'original-b-project' }
  const report = { operationId: 'original-recovery-C', outcome: 'opened' as const, from: null, to: admitted.address, agent: spatialAgentFact(session, 'D-in-B'), resource: null, issues: [],
    save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed' as const, reason: 'This current read is not the original write acknowledgement.' } }
  useAppStore.setState({ config, sessions: [], mountedSpaceInputs: {}, launcherNameDrafts: { untouched: { agentName: 'Unsent unrelated name', tabName: 'Keep this draft' } } })
  await initializeSpatialControlFixture()
  const create = vi.spyOn(api.sessions, 'launchAgent'), continueC = vi.spyOn(api.sessions, 'continueExecution')
  return { ...f, ...transport, session, admitted, target, report, native, create, continueC }
}
async function mount(content: ReturnType<typeof createElement>) {
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  await act(async () => root.render(content)); cleanup.push(async () => { await act(async () => root.unmount()); container.remove() }); return container
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)

it('after a lost Source C reply, readonly Check provides the exact locator for explicit original names without another C, initial input or fabricated producer ACK', async () => {
  const f = await fixture(), original: MountedAgentOpenInput = { kind: 'agent-open', target: f.target, slot: { kind: 'region', tabId: 'launcher-tab', regionId: 'launcher-region' }, submitted: false,
    origin: { kind: 'ordinary-launcher', launcherId: 'original-launcher', project: { id: 'observer-project', hostId: f.target.hostId, path: '/b/project' }, names: { agentName: 'Recovered D name', tabName: 'Recovered B Tab name' } },
    request: { operationId: 'original-recovery-C', content: { kind: 'new-agent', executorId: 'test-executor', agentTarget: { hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId }, prompt: 'Original first input retained verbatim' },
      destination: { spaceId: f.reference.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false } }
  const calls = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    if (method === 'open') throw Error('Original C producer reply lost')
    if (method === 'inspect') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
      request: { known: true, operationId: original.request.operationId, report: f.report } } as never
    return await f.api.call(method, input, signal)
  })
  await expect(sendSourceLauncherRequest(original)).rejects.toThrow('reply lost')
  const get = () => mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, mountedAgentOpenKey(original.target, original.slot))!, pending = get(), draft = useAppStore.getState().launcherNameDrafts
  const continuation = vi.fn(), container = await mount(createElement(SourceLauncherRequest, { input: pending, busy: false, active: true, onContinue: continuation }))
  await act(async () => button(container, 'Check original task')!.click())
  await vi.waitFor(() => expect(container.textContent).toContain('The project device confirmed this Agent'))
  expect(calls.mock.calls.filter(([method]) => method.endsWith('Change'))).toHaveLength(0)
  expect(get().receipt).toBeUndefined(); expect(get().nameInputs).toBeUndefined()
  expect(button(container, 'Apply original agent name')).toBeDefined()
  await act(async () => button(container, 'Apply original agent name')!.click())
  await act(async () => button(container, 'Apply original tab name')!.click())
  const owner = (): LaunchNameOwner => ({ kind: 'source', input: get() })
  await vi.waitFor(() => expect(originalLaunchName(owner(), 'agent')?.response?.save.diskDurability).toBe('confirmed'))
  await vi.waitFor(() => expect(originalLaunchName(owner(), 'tab')?.response?.save.diskDurability).toBe('confirmed'))
  expect(originalLaunchName(owner(), 'agent')!.target).toMatchObject({ kind: 'member', name: { target: { reference: f.reference, regionId: f.admitted.address.regionId, runtimeId: f.d.owner.runtimeId,
    agentSessionId: f.session.agentSessionId, expectedAdmission: { kind: 'creation', operationId: original.request.operationId } } } })
  expect(get().receipt).toBeUndefined(); expect(get().request).toBe(original.request)
  expect(calls.mock.calls.filter(([method]) => method === 'open')).toHaveLength(1); expect(continuation).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.continueC).not.toHaveBeenCalled()
  expect(useAppStore.getState().launcherNameDrafts).toBe(draft); expect(f.native).not.toHaveBeenCalled()
})

it('a readonly opened Reach L locates its original Tab name for explicit Apply while C and L ACK history remain separate and no reverse Agent write is used', async () => {
  const f = await fixture(), binding = { bindingId: 'original-binding', agentSessionId: f.session.agentSessionId, createOperationId: 'original-recovery-C' }
  const request = rpcControlRequest('agent.open', { operationId: 'original-recovery-L', content: { kind: 'agent-session', reference: { kind: 'coordinator-agent', runtimeId: f.d.owner.runtimeId, binding },
    expectedResource: { runtimeId: f.b.owner.runtimeId, workspaceId: f.target.workspaceId, workspacePath: '/b/project' } }, destination: { spaceId: f.reference.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false })
  if (!isSpatialAgentAssociation(request)) throw Error('The original association is required')
  const linked = await f.b.spatial.associateAgentOpen(request, f.b.owner.runtimeId, async () => {})
  const historical = { ...f.report, operationId: 'original-recovery-L', outcome: 'unknown' as const, agent: null, to: null }
  const original: SourceCoordinatorInput = { kind: 'source-coordinator-launch', target: f.target,
    request: { hostId: 'local', executorId: 'test-executor', workspacePath: f.session.workspacePath, agentSessionId: f.session.agentSessionId, createOperationId: binding.createOperationId,
      toolWorkspace: { id: f.target.workspaceId, hostId: f.target.hostId, path: '/b/project' }, sourceCoordinator: { hostId: 'local', runtimeId: f.d.owner.runtimeId, resourceRuntimeId: f.b.owner.runtimeId, workingDirectory: 'device-home' } },
    origin: { launcherId: 'reach-original', slot: { tabId: 'reach-tab', regionId: 'reach-region' }, project: { id: f.target.workspaceId, hostId: f.target.hostId, path: '/b/project' }, names: { agentName: '', tabName: 'Recovered original L Tab' } },
    submitted: true, acknowledged: { target: { coordinator: { hostId: 'local', runtimeId: f.d.owner.runtimeId }, reference: binding }, run: f.session.run },
    association: { operationId: 'original-recovery-L', submitted: true, request: { operationId: 'original-recovery-L', content: request.content, destination: request.destination!, focus: false }, receipt: historical } }
  const key = sourceCoordinatorInputKey(original.request)
  useAppStore.getState().retainSourceCoordinatorInput(key, () => original)
  vi.spyOn(api.sessions, 'resolveExecutionBinding').mockRejectedValue(Error('Independent C observation unavailable, without blocking B'))
  const calls = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    if (method === 'inspect') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
      request: { known: true, operationId: original.association.operationId, report: { ...f.report, operationId: original.association.operationId, agent: null, to: linked.record.address } } } as never
    return await f.api.call(method, input, signal)
  })
  const container = await mount(createElement(SourceCoordinatorRequests, { active: true, origin: original.origin.slot }))
  await act(async () => button(container, 'Check original Reach request')!.click())
  await vi.waitFor(() => expect(container.querySelector('summary')!.textContent).toBe('Original project link observed'))
  expect(calls.mock.calls.filter(([method]) => method.endsWith('Change'))).toHaveLength(0)
  expect(sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)!.association.receipt).toBe(historical)
  expect(button(container, 'Apply original tab name')).toBeDefined()
  await act(async () => button(container, 'Apply original tab name')!.click())
  const current = () => sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)!
  await vi.waitFor(() => expect(originalLaunchName({ kind: 'reach', input: current() }, 'tab')?.response?.save.diskDurability).toBe('confirmed'))
  expect(current().association.receipt).toBe(historical); expect(current().acknowledged).toBe(original.acknowledged)
  expect(calls.mock.calls.filter(([method]) => method === 'open' || method === 'agentNameChange')).toHaveLength(0)
  expect(f.create).not.toHaveBeenCalled(); expect(f.continueC).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled()
})
