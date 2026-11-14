import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionBindingService, AgentMuxError } from '@agentmux/core'
import { registerExecutionBindingIpc } from '../src/main/execution-binding-ipc'
import { ExecutionBindingReaders } from '../src/main/execution-binding-readers'
import { createExecutionBindingApi } from '../src/preload/execution-binding'
import type { IpcMainInvokeEvent } from 'electron'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-source-association-read-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const resolveHost = vi.fn(async () => { throw new AgentMuxError('Controlled original endpoint is unavailable', 'CONTROL_UNAVAILABLE') })
  const owner = new AgentExecutionBindingService(root, { resolveHost }); cleanup.push(() => owner.dispose())
  const reference = { bindingId: 'original-binding', agentSessionId: 'original-SID', createOperationId: 'original-C' }
  await expect(owner.create({ bindingId: reference.bindingId, agentHostId: 'local', agentRuntimeId: 'original-A', resourceHostId: 'source-B', resourceRuntimeId: 'original-B', resourceWorkspacePath: '/original/B/project', resourceGrant: { scope: 'host-user', bindingId: reference.bindingId },
    agent: { executorId: 'original-executor', executorRevision: 'original-revision', workspacePath: '/original/A/home', agentSessionId: reference.agentSessionId, createOperationId: reference.createOperationId, prompt: 'Original private input' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const coordinator = { hostId: 'local', runtimeId: 'original-A' }, handlers = new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>()
  const readers = new ExecutionBindingReaders(id => owner.inspect(id)); cleanup.push(() => readers.dispose())
  const continuation = vi.spyOn(owner, 'continueOriginal'), inspect = vi.spyOn(owner, 'inspect')
  registerExecutionBindingIpc({ handle: (channel, listener) => handlers.set(channel, listener), bindings: owner, readers,
    coordinatorTarget: async () => coordinator, coordinator: async target => { if (target.hostId !== coordinator.hostId || target.runtimeId !== coordinator.runtimeId) throw new AgentMuxError('Wrong original Coordinator', 'RUNTIME_OWNER_MISMATCH') },
    project: async () => { throw Error('This read must not project a creation') } })
  const bus = new EventEmitter(), sender = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, send: (channel: string, value: unknown) => bus.emit(channel, {}, value) })
  // The read does not subscribe. Electron sender delivery is the explicit leaf;
  // the actual registration, original Coordinator assertion and reader are real.
  const ipc = { invoke: vi.fn(async (channel: string, ...values: unknown[]) => structuredClone(await handlers.get(channel)!({ sender } as never, ...structuredClone(values)))), on: vi.fn(), off: vi.fn() }
  return { root, owner, coordinator, reference, resolveHost, continuation, inspect, ipc, api: createExecutionBindingApi(ipc) }
}
it('registered Main/preload reads the original frozen C association witness without preparing endpoints or changing its existing inspect result', async () => {
  const f = await fixture(), before = await readFile(join(f.root, 'bindings.sqlite')), starts = f.resolveHost.mock.calls.length
  expect(await f.api.executionCoordinatorTarget()).toEqual(f.coordinator)
  const target = { coordinator: f.coordinator, reference: f.reference }, plain = await f.api.executionBinding(target)
  expect(plain).not.toHaveProperty('association')
  const witnessed = await f.api.executionBinding(target, 'association')
  expect(witnessed?.association).toEqual({ state: 'confirmed', reference: f.reference, agentRuntimeId: 'original-A', resourceRuntimeId: 'original-B', resourceWorkspacePath: '/original/B/project' })
  expect(f.inspect.mock.calls).toEqual([[f.reference.bindingId, undefined], [f.reference.bindingId, 'association']])
  expect(f.resolveHost.mock.calls.length).toBe(starts); expect(f.continuation).not.toHaveBeenCalled()
  expect(await readFile(join(f.root, 'bindings.sqlite'))).toEqual(before)
})
it('the association read keeps its exact Coordinator and finite view and cannot request a write or another owner', async () => {
  const f = await fixture(), target = { coordinator: f.coordinator, reference: f.reference }
  await expect(f.api.executionBinding({ ...target, coordinator: { ...f.coordinator, runtimeId: 'other-A' } }, 'association')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(f.ipc.invoke('sessions:executionBinding', target, 'all-private-input')).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.inspect).not.toHaveBeenCalled(); expect(f.continuation).not.toHaveBeenCalled()
  expect((await f.api.executionBinding(target, 'association'))?.association?.state).toBe('confirmed')
})
