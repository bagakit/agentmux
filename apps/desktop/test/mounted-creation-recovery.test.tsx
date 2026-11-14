// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentMuxHostedForwardRpc } from '../../../packages/core/src/hosted-client-contract'
import { sourceCreationFixture } from '../../../packages/core/test/helpers/source-creation-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { spaceMountKey, type SpaceMountRecord } from '../src/shared/space-mount'
import { mountedSpaceRegions, mountedSpaceTarget } from '../src/renderer/src/lib/space-mount-view'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
function SourceWorkbench({ mountKey, visible }: { mountKey: string; visible: boolean }) {
  const workspaceId = useAppStore(state => mountedSpaceTarget(state.mountedSpaceInputs, mountKey)?.workspaceId)
  return workspaceId ? <WorkspaceWorkbench workspaceId={workspaceId} visible={visible} /> : null
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const button = (label: string) => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === label)

/** Actual Source admission and protected business service over Unix RPC, trusted
 * Main/Preload/Renderer and Workbench. Native/create/binding and Session stream
 * delivery are explicit leaves; this does not certify the production SG1 task. */
async function fixture(strict = false) {
  const source = await sourceCreationFixture(cleanup); source.pending()
  const admitted = await source.rpc.call('agent.open', source.input)
  const calls: Array<{ method: string; params: unknown; context: unknown }> = []
  const delivery = { wait: undefined as Promise<void> | undefined, override: undefined as unknown, continueWait: undefined as Promise<void> | undefined, failure: undefined as Error | undefined }
  const forwardRpc: AgentMuxHostedForwardRpc = async (method, params, context, fence) => {
    const originalContext = { ...context, ...(fence ? { runtimeFence: fence } : {}) }
    calls.push({ method, params: structuredClone(params), context: originalContext })
    const result = await source.rpc.call(method as never, params as never, originalContext)
    if (method === 'space.inspect') {
      await delivery.wait
      if (delivery.failure) throw delivery.failure
      return (delivery.override ?? result) as never
    }
    if (method === 'agent.execution.continue') await delivery.continueWait
    return result as never
  }
  const carrier = { forwardRpc, subscribeRpc: source.rpc.subscribe.bind(source.rpc) }
  const transport = spaceMountTransport(cleanup, [{ id: 'source-route', carrier }])
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(transport.api.call)
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(transport.api.watch)
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(async () => ({ initial: { reference: target.reference, source: snapshot.source, revision: snapshot.revision }, dispose() {} }))
  const target: SpaceMountRecord = { hostId: 'source-route', reference: { runtimeId: 'runtime-b', spaceId: source.folder.spaceId }, workspaceId: admitted.to!.workspaceId, zoneId: source.folder.zoneId }
  const snapshot = await transport.api.call('snapshot', { hostId: target.hostId, reference: target.reference }), member = mountedSpaceRegions(snapshot)[0]!, key = spaceMountKey(target.reference)
  useAppStore.getState().mountSpace(target)
  useAppStore.getState().editSpaceMountDraft(key, member.tab.tabId, member.region.regionId, 'Keep this private unsent task')
  const sessions = useAppStore.getState().sessions
  const surface = <SourceWorkbench mountKey={key} visible />
  await dom.render(strict ? <StrictMode>{surface}</StrictMode> : surface)
  await vi.waitFor(() => expect(button('Continue original request')).toBeDefined())
  return { source, transport, target, snapshot, member, key, calls, delivery, sessions, admitted }
}

test('the real mounted workface reads pre-Agent Source state and explicitly continues only its frozen original request through Main and public RPC', async () => {
  const f = await fixture()
  expect(dom.container.textContent).toContain('Agent creation unconfirmed')
  expect(dom.container.textContent).toContain('The original binding is not connected.')
  expect(f.calls.filter(call => call.method === 'space.inspect')).toEqual([expect.objectContaining({ params: { target: { operationId: f.source.input.operationId } }, context: expect.objectContaining({ runtimeFence: { runtimeId: 'runtime-b', ownerInstanceId: 'instance-b' } }) })])
  expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1)
  await act(async () => { button('Continue original request')!.click(); button('Continue original request')!.click() })
  await vi.waitFor(() => expect(dom.container.textContent, dom.container.textContent ?? '').toContain('The original creation was confirmed.'))
  expect(f.calls.filter(call => call.method === 'agent.execution.continue')).toEqual([expect.objectContaining({ params: f.admitted.execution!.reference, context: expect.objectContaining({ runtimeFence: { runtimeId: 'runtime-b', ownerInstanceId: 'instance-b' } }) })])
  expect(f.source.bindings.admit).toHaveBeenCalledTimes(1)
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(2)
  expect(f.source.create).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toBe(f.sessions)
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this private unsent task')
  expect((await f.source.spatial.read())!.graph.regions[0]!.agentSessionId).toBe('original-d-session')
})

test('a failed current observation keeps its confirmed original continuation and private draft without an automatic effect', async () => {
  const f = await fixture(); f.delivery.failure = Error('Current Source read unavailable')
  await act(async () => { button('Check original status')!.click() })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Latest observation: Current Source read unavailable'))
  expect(dom.container.textContent).toContain('Last confirmed tools')
  expect(button('Continue original request')).toBeDefined()
  expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this private unsent task')
})

test.each(['runtime', 'session', 'creation'])('another %s observation cannot provide this Region with a continuation', async kind => {
  const f = await fixture()
  const report = structuredClone(f.admitted)
  if (kind === 'runtime') report.execution!.coordinatorRuntimeId = 'other-source'
  if (kind === 'session') report.execution!.reference.agentSessionId = 'other-session'
  if (kind === 'creation') report.execution!.reference.createOperationId = 'other-creation'
  f.delivery.override = { request: { known: true, operationId: f.source.input.operationId, report } }
  await act(async () => { button('Check original status')!.click() })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The observation belongs to another original request.'))
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
})

test('Main pins the original Source and rejects private launch fields on the finite continuation bridge', async () => {
  const f = await fixture(), execution = f.admitted.execution!.reference
  await expect(f.transport.api.call('continueExecution', { hostId: f.target.hostId, reference: { ...f.target.reference, runtimeId: 'other-source' }, execution })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(f.transport.api.call('continueExecution', { hostId: f.target.hostId, reference: f.target.reference, execution: { ...execution, prompt: 'not allowed' } } as never)).rejects.toThrow()
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1)
})

test('a read arriving after this Region has been rebound cannot publish its old continuation or erase a newer draft', async () => {
  const f = await fixture(); let release!: () => void
  f.delivery.wait = new Promise<void>(resolve => { release = resolve })
  await act(async () => { button('Check original status')!.click() })
  const state = (await f.source.spatial.read())!
  await f.source.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph, regions: state.graph.regions.map(region => ({ ...region, agentSessionId: 'new-original-session', creationOperationId: 'new-original-creation' })) } })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('new-original-session'))
  await act(async () => { useAppStore.getState().editSpaceMountDraft(f.key, f.member.tab.tabId, f.member.region.regionId, 'New private draft'); release() })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The Source has not returned this original creation.'))
  expect(button('Continue original request')).toBeUndefined()
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('New private draft')
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
})


test('the actual StrictMode workface can establish its original reader after repeated setup without starting anything', async () => {
  const f = await fixture(true)
  expect(button('Continue original request')).toBeDefined()
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.agentInput).not.toHaveBeenCalled()
})

test('a Source-confirmed Agent remains confirmed while its Session stream is delayed', async () => {
  const f = await fixture()
  await f.source.create(f.source.frozen()!.agent)
  await act(async () => { button('Check original status')!.click() })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original Agent confirmed'))
  expect(dom.container.textContent).not.toContain('its original Agent has not been confirmed')
  expect(dom.container.textContent).toContain('Its Session observation has not arrived yet.')
  expect(useAppStore.getState().sessions).toBe(f.sessions)
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
})

test('an original Core retirement is distinct from absent creation and provides no continuation action', async () => {
  const f = await fixture()
  await f.source.create(f.source.frozen()!.agent); f.source.retire()
  await act(async () => { button('Check original status')!.click() })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original Session retired'))
  expect(button('Continue original request')).toBeUndefined()
  expect(dom.container.textContent).not.toContain('its original Agent has not been confirmed')
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this private unsent task')
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
})


test('a completed continuation arriving after Region rebinding cannot refresh or adopt into the new workface', async () => {
  const f = await fixture(); let release!: () => void
  f.delivery.continueWait = new Promise<void>(resolve => { release = resolve })
  await act(async () => { button('Continue original request')!.click() })
  await vi.waitFor(() => expect(f.source.create).toHaveBeenCalledTimes(1))
  const state = (await f.source.spatial.read())!
  await f.source.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph, regions: state.graph.regions.map(region => ({ ...region, agentSessionId: 'new-original-session', creationOperationId: 'new-original-creation' })) } })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('new-original-session'))
  await act(async () => { useAppStore.getState().editSpaceMountDraft(f.key, f.member.tab.tabId, f.member.region.regionId, 'Later private task'); release() })
  await vi.waitFor(() => expect(button('Continue original request')).toBeUndefined())
  expect(dom.container.textContent).not.toContain('The original creation was confirmed.')
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Later private task')
  expect(useAppStore.getState().sessions).toBe(f.sessions)
  expect((await f.source.spatial.read())!.graph.regions[0]!.agentSessionId).toBe('new-original-session')
  expect(f.source.create).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
})
