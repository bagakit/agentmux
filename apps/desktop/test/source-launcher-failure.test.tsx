// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { sourceCreationFixture } from '../../../packages/core/test/helpers/source-creation-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { SourceLauncherRequest } from '../src/renderer/src/components/SourceLauncherRequest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AgentMuxHostedForwardRpc } from '../../../packages/core/src/hosted-client-contract'
import type { MountedAgentOpenInput } from '../src/renderer/src/lib/space-mount-launch'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const button = (label: string) => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!
const creation = () => dom.container.querySelector('[aria-label="Original creation failures"]')

/** Actual Source/public service and Unix RPC → production Main/trusted IPC,
 * Preload, Renderer and component. Binding/native/create and controlled later
 * response delivery are leaves; no production writer or original task is run. */
async function fixture(kind: 'writer' | 'prepare' = 'writer') {
  const source = await sourceCreationFixture(cleanup)
  if (kind === 'writer') source.bindings.continueOriginal.mockRejectedValueOnce(new AgentMuxError('The original execution coordinator already has a writer.', 'EXECUTION_OWNER_UNAVAILABLE'))
  else source.pending()
  const receipt = await source.rpc.call('agent.open', source.input)
  const calls: Array<{ method: string; params: unknown; context: unknown }> = []
  const delivery = { wait: undefined as Promise<void> | undefined, override: undefined as unknown, failure: undefined as Error | undefined }
  const forwardRpc: AgentMuxHostedForwardRpc = async (method, params, context, fence) => {
    const original = { ...context, ...(fence ? { runtimeFence: fence } : {}) }
    calls.push({ method, params: structuredClone(params), context: original })
    const value = await source.rpc.call(method as never, params as never, original)
    if (method === 'space.inspect') {
      await delivery.wait
      if (delivery.failure) throw delivery.failure
      return (delivery.override ?? value) as never
    }
    return value as never
  }
  const carrier = { forwardRpc, subscribeRpc: source.rpc.subscribe.bind(source.rpc) }
  const transport = spaceMountTransport(cleanup, [{ id: 'original-source', carrier }])
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(transport.api.call)
  const input: MountedAgentOpenInput = { kind: 'agent-open', target: { hostId: 'original-source', reference: { runtimeId: 'runtime-b', spaceId: source.folder.spaceId },
    workspaceId: receipt.to!.workspaceId, zoneId: source.folder.zoneId }, slot: { kind: 'new-work', zoneId: source.folder.zoneId }, request: source.input, submitted: true, receipt }
  const onContinue = vi.fn()
  useAppStore.getState().setAgentComposerDraft('original-launcher', 'Keep this newer private draft unsent')
  const healthy = composerSession('healthy-sibling')
  useAppStore.setState({ sessions: [healthy] })
  const render = (next = input) => dom.render(<StrictMode><SourceLauncherRequest input={next} busy={false} onContinue={onContinue} /></StrictMode>)
  await render()
  return { source, transport, input, receipt, delivery, calls, onContinue, render, healthy }
}

test.each(['writer', 'prepare'] as const)('the real Source %s failure is readable before opening JSON, with zero read effects', async kind => {
  const f = await fixture(kind)
  const code = kind === 'writer' ? 'EXECUTION_OWNER_UNAVAILABLE' : 'EXECUTION_HELPER_UNAVAILABLE'
  expect(creation()?.textContent).toContain(code)
  expect(creation()?.textContent).toContain(kind === 'writer' ? 'already has a writer' : 'Original helper preparation')
  expect(creation()?.closest('details')).toBeNull()
  expect(f.calls).toHaveLength(0)
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Source observation issues"]')?.textContent).toContain('Latest Source observation'))
  expect(creation()?.textContent).toContain(code)
  expect(f.calls.filter(call => call.method === 'space.inspect')).toEqual([expect.objectContaining({ params: { target: { operationId: f.input.request.operationId } },
    context: expect.objectContaining({ runtimeFence: { runtimeId: 'runtime-b', ownerInstanceId: 'instance-b' } }) })])
  expect(f.source.bindings.admit).toHaveBeenCalledTimes(1)
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.agentInput).not.toHaveBeenCalled()
  expect(f.onContinue).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['original-launcher']).toBe('Keep this newer private draft unsent')
  expect(useAppStore.getState().sessions).toEqual([f.healthy])
  await act(async () => button('Continue original task').click())
  expect(f.onContinue).toHaveBeenCalledExactlyOnceWith(f.input)
})

test('a newer observer failure leaves the original creation cause and request intact', async () => {
  const f = await fixture()
  f.source.client.inspectAgentCreation.mockRejectedValueOnce(new AgentMuxError('The current observer cannot read this target.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED'))
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Source observation issues"]')?.textContent).toContain('HOST_ROUTE_AUTHORIZATION_REQUIRED'))
  expect(creation()?.textContent).toContain('EXECUTION_OWNER_UNAVAILABLE')
  expect(creation()?.textContent).not.toContain('HOST_ROUTE_AUTHORIZATION_REQUIRED')
  f.delivery.failure = Error('Transport observation failed')
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Latest observation: Transport observation failed'))
  expect(creation()?.textContent).toContain('already has a writer')
  expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.onContinue).not.toHaveBeenCalled()
})

test.each(['operation', 'session', 'runtime'] as const)('a foreign %s report cannot replace this original diagnosis or actions', async kind => {
  const f = await fixture()
  const report = structuredClone(f.receipt)
  report.issues = [{ step: 'creation', code: 'FOREIGN_CREATION', message: 'Unrelated failure', recovery: 'Inspect its own request.' }]
  if (kind === 'operation') report.operationId = 'other-operation'
  if (kind === 'session') report.execution!.reference.agentSessionId = 'other-session'
  if (kind === 'runtime') report.execution!.coordinatorRuntimeId = 'other-runtime'
  f.delivery.override = { request: { known: true, operationId: f.input.request.operationId, report } }
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain(kind === 'operation' ? 'The Source has not confirmed this original request.' : 'The observation belongs to another original request.'))
  expect(dom.container.textContent).not.toContain('FOREIGN_CREATION')
  expect(creation()?.textContent).toContain('EXECUTION_OWNER_UNAVAILABLE')
  await act(async () => button('Continue original task').click())
  expect(f.onContinue).toHaveBeenCalledExactlyOnceWith(f.input)
  expect(f.source.create).not.toHaveBeenCalled()
})

test('a reply from an earlier request cannot populate a changed Source or erase later private input', async () => {
  const f = await fixture(); let release!: () => void
  f.delivery.wait = new Promise<void>(resolve => { release = resolve })
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'space.inspect')).toHaveLength(1))
  const { receipt: _receipt, ...original } = f.input
  const next: MountedAgentOpenInput = { ...original, target: { ...f.input.target, hostId: 'different-original-source' },
    request: { ...f.input.request, operationId: 'next-original-operation' } }
  await f.render(next)
  await act(async () => { useAppStore.getState().setAgentComposerDraft('original-launcher', 'A later private edit'); release() })
  await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'space.inspect')).toHaveLength(1))
  expect(creation()).toBeNull()
  expect(dom.container.querySelector('[aria-label="Source observation issues"]')).toBeNull()
  expect(dom.container.textContent).not.toContain('EXECUTION_OWNER_UNAVAILABLE')
  expect(useAppStore.getState().agentComposerDrafts['original-launcher']).toBe('A later private edit')
  await act(async () => button('Continue original task').click())
  expect(f.onContinue).toHaveBeenCalledExactlyOnceWith(next)
  expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.agentInput).not.toHaveBeenCalled()
})

test.each(['confirmed', 'retired'] as const)('an original %s Agent is not presented as uncreated, while the historical cause remains readable', async kind => {
  const f = await fixture('prepare')
  await f.source.create(f.source.frozen()!.agent)
  if (kind === 'retired') f.source.retire()
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain(kind === 'retired' ? 'The original Agent was retired.' : 'The project device confirmed this Agent.'))
  expect(creation()?.textContent).toContain('Earlier creation')
  expect(creation()?.textContent).toContain('EXECUTION_HELPER_UNAVAILABLE')
  if (kind === 'retired') expect(button('Continue original task')).toBeUndefined()
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([f.healthy])
})
