// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { registerNativeDesktopIpc } from '../src/main/native-desktop-ipc'
import { AgentMuxError } from '@agentmux/core'
import { sourceCreationFixture } from '../../../packages/core/test/helpers/source-creation-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { SourceLauncherRequest } from '../src/renderer/src/components/SourceLauncherRequest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AgentMuxHostedForwardRpc } from '../../../packages/core/src/hosted-client-contract'
import type { MountedAgentOpenInput } from '../src/renderer/src/lib/space-mount-launch'

const clipboardBridge = vi.hoisted(() => ({ exposed: undefined as any, invoke: undefined as any }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { clipboardBridge.exposed = value } },
 ipcRenderer: { invoke: (...args: unknown[]) => clipboardBridge.invoke(...args), on() {}, off() {}, removeListener() {}, sendSync() {} }, webFrame: {}, webUtils: {} }))
const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const button = (label: string) => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!
const creation = () => dom.container.querySelector('[aria-label="Original creation failures"]')

/** Actual Source/public service and Unix RPC → production Main/trusted IPC,
 * Preload, Renderer and component. Binding/native/create and controlled later
 * response delivery are leaves; no production writer or original task is run. */
async function fixture(kind: 'writer' | 'prepare' | 'attach' = 'writer', privateInput = false, realBindings = false) {
  const source = await sourceCreationFixture(cleanup, undefined, { realBindings })
  if (privateInput) Object.assign(source.input.content, { prompt: 'PRIVATE_TASK_PAYLOAD', agentMuxNote: 'PRIVATE_NOTE_PAYLOAD' })
  if (kind === 'writer') source.bindings.continueOriginal.mockRejectedValueOnce(new AgentMuxError('The original execution coordinator already has a writer.', 'EXECUTION_OWNER_UNAVAILABLE'))
  else if (kind === 'attach') source.bindings.continueOriginal.mockImplementationOnce(async reference => { throw new AgentMuxError("Expected ',' or ']' after array element: PRIVATE_NATIVE_PAYLOAD", 'EXECUTION_CREATION_UNCONFIRMED', undefined, undefined, undefined, undefined, undefined, { reference, hostId: 'local', role: 'executor', stage: 'attach' }) })
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

test.each(['writer', 'prepare'] as const)('the real Source %s failure has compact status and complete folded cause, with zero read effects', async kind => {
  const f = await fixture(kind)
  const code = kind === 'writer' ? 'EXECUTION_OWNER_UNAVAILABLE' : 'EXECUTION_HELPER_UNAVAILABLE'
  expect(creation()?.textContent).toContain(code)
  expect(creation()?.textContent).toContain(kind === 'writer' ? 'already has a writer' : 'Original helper preparation')
  expect(creation()?.closest('details')?.open).toBe(false)
  expect(dom.container.querySelector('.source-launch-feedback__status')?.textContent).toContain('Launch not confirmed')
  expect(f.calls).toHaveLength(0)
  await act(async () => button('Check original status').click())
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
  await act(async () => button('Check original status').click())
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Source observation issues"]')?.textContent).toContain('HOST_ROUTE_AUTHORIZATION_REQUIRED'))
  expect(creation()?.textContent).toContain('EXECUTION_OWNER_UNAVAILABLE')
  expect(creation()?.textContent).not.toContain('HOST_ROUTE_AUTHORIZATION_REQUIRED')
  f.delivery.failure = Error('Transport observation failed')
  await act(async () => button('Check original status').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Transport observation failed'))
  expect(creation()?.textContent).toContain('already has a writer')
  expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.onContinue).not.toHaveBeenCalled()
})

test('the Source keeps a prior preparation cause readable after the Launcher loses its original receipt', async () => {
  const f = await fixture('prepare', true, true), clipboard = await clipboardConsumer()
  const { receipt: _receipt, ...input } = f.input
  await f.render(input)
  await act(async () => button('Check original status').click())
  const details = () => dom.container.querySelector('[aria-label="Last recorded creation failure"]')
  await vi.waitFor(() => expect(details()?.textContent).toContain('EXECUTION_HELPER_UNAVAILABLE'))
  expect(details()?.closest('details')?.open).toBe(false)
  expect(dom.container.querySelector('.source-launch-feedback__status')?.textContent).toContain('Tool helper preparation is unconfirmed')
  await act(async () => button('Copy diagnostics').click())
  await vi.waitFor(() => expect(clipboard.values).toHaveLength(1))
  expect(JSON.parse(clipboard.values[0]!).execution.diagnostics).toMatchObject({
    connection: { state: 'unconfirmed', code: 'EXECUTION_OBSERVATION_UNCONFIRMED' },
    lastCreationFailure: { role: 'executor', stage: 'prepare', code: 'EXECUTION_HELPER_UNAVAILABLE' },
  })
  expect(clipboard.values[0]).not.toContain('PRIVATE_')
  expect(f.source.prepare).toHaveBeenCalledOnce(); expect(f.source.starts).not.toHaveBeenCalled()
  expect(f.source.create).not.toHaveBeenCalled(); expect(f.source.agentInput).not.toHaveBeenCalled()
})

test.each(['operation', 'session', 'runtime'] as const)('a foreign %s report cannot replace this original diagnosis or actions', async kind => {
  const f = await fixture()
  const report = structuredClone(f.receipt)
  report.issues = [{ step: 'creation', code: 'FOREIGN_CREATION', message: 'Unrelated failure', recovery: 'Inspect its own request.' }]
  if (kind === 'operation') report.operationId = 'other-operation'
  if (kind === 'session') report.execution!.reference.agentSessionId = 'other-session'
  if (kind === 'runtime') report.execution!.coordinatorRuntimeId = 'other-runtime'
  f.delivery.override = { request: { known: true, operationId: f.input.request.operationId, report } }
  await act(async () => button('Check original status').click())
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
  await act(async () => button('Check original status').click())
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
  await act(async () => button('Check original status').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain(kind === 'retired' ? 'Agent retired' : 'Agent created'))
  expect(creation()?.textContent).toContain('Earlier creation')
  expect(creation()?.textContent).toContain('EXECUTION_HELPER_UNAVAILABLE')
  if (kind === 'retired') expect(button('Continue original task')).toBeUndefined()
  expect(f.source.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.source.agentInput).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([f.healthy])
})

async function clipboardConsumer() {
 const handlers = new Map<string, Function>(), values: string[] = []
 let wait: Promise<void> | undefined, failure: Error | undefined
 registerNativeDesktopIpc({ capture: async () => null, handle: (channel, handler) => { handlers.set(channel, handler) },
  native: () => ({ captureScreenshot: async () => { throw Error('No screenshot belongs to copy') }, readClipboardText: async () => values.at(-1) ?? '', writeClipboardImage: async () => { throw Error('No image belongs to copy') },
   writeClipboardText: async (value: string) => { await wait; if (failure) throw failure; values.push(value) } }) as never })
 clipboardBridge.invoke = async (channel: string, ...args: unknown[]) => { const handler = handlers.get(channel); if (!handler) throw Error(channel); return handler({}, ...args) }
 await import('../src/preload/index')
 vi.spyOn(api.ui, 'writeClipboardText').mockImplementation(text => clipboardBridge.exposed.ui.writeClipboardText(text))
 return { values, hold: (value: Promise<void> | undefined) => { wait = value }, fail: (value: Error) => { failure = value } }
}
test('real clipboard Preload/Main consumer acknowledges only safe original metadata, and copy has zero Source effects', async () => {
 const f = await fixture('writer', true), clipboard = await clipboardConsumer()
 f.input.receipt!.issues[0]!.message = 'PRIVATE_NATIVE_PAYLOAD and env=PRIVATE_ENV'
 const execution = f.input.receipt!.execution!
 execution.diagnostics = { sourceRuntimeId: execution.coordinatorRuntimeId, reference: execution.reference, state: 'matched',
   helpers: { executor: { start: { outcome: 'confirmed', runId: 'original-helper-run' }, cursor: 42, ownerInstanceId: 'original-native-instance' }, frontend: { start: { outcome: 'unknown', runId: null }, cursor: null, ownerInstanceId: null } },
   failure: { hostId: 'local', role: 'executor', stage: 'attach', code: 'EXECUTION_PROTOCOL_INVALID_FRAME', frame: { startByte: 42, endByte: 52, bytes: 9, sha256: 'c'.repeat(64), syntax: 'invalid-json' } } }
 Reflect.set(execution.diagnostics, 'rawOutput', 'PRIVATE_HELPER_BYTES')

 await f.render({ ...f.input, receipt: { ...f.input.receipt! } })
 let release!: () => void; clipboard.hold(new Promise<void>(done => { release = done }))
 await act(async () => button('Copy diagnostics').click())
 expect(dom.container.textContent).toContain('Copying diagnostics'); expect(dom.container.textContent).not.toContain('Diagnostics copied'); expect(clipboard.values).toEqual([])
 await act(async () => release())
 await vi.waitFor(() => expect(dom.container.textContent).toContain('Diagnostics copied'))
 const text = clipboard.values[0]!, diagnosis = JSON.parse(text)
 expect(text).not.toMatch(/PRIVATE_|newer private draft|Original helper preparation/)
 expect(diagnosis).not.toHaveProperty('privateRequest'); expect(diagnosis).not.toHaveProperty('request')
 expect(diagnosis).toMatchObject({ operationId: f.input.request.operationId, source: { hostId: 'original-source' }, execution: { reference: f.receipt.execution!.reference }, cli: { command: 'space inspect', operationId: f.input.request.operationId } })
 expect(diagnosis.execution.diagnostics).toMatchObject({ state: 'matched', helpers: { executor: { start: { runId: 'original-helper-run' } } }, failure: { code: 'EXECUTION_PROTOCOL_INVALID_FRAME', frame: { sha256: 'c'.repeat(64) } } })
 expect(diagnosis.original.issues).toContainEqual(expect.objectContaining({ category: 'source-operation-unconfirmed' }))
 expect(f.calls).toEqual([]);expect(f.onContinue).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts['original-launcher']).toBe('Keep this newer private draft unsent')
})
test('clipboard failure is visible, while a late ACK after request replacement cannot mark the new diagnosis copied', async () => {
 const f = await fixture(), clipboard = await clipboardConsumer();clipboard.fail(Error('Clipboard unavailable'))
 await act(async () => button('Copy diagnostics').click());await vi.waitFor(() => expect(dom.container.textContent).toContain('Could not copy diagnostics'))
 expect(clipboard.values).toEqual([]);expect(f.calls).toEqual([])
})
test('late copy ACK is scoped to the snapshot and original request that the person clicked', async () => {
 const f = await fixture(), clipboard = await clipboardConsumer();let release!: () => void;clipboard.hold(new Promise<void>(done => { release = done }))
 await act(async () => button('Copy diagnostics').click())
 const { receipt: _receipt, ...retained } = f.input
 const next: MountedAgentOpenInput = { ...retained, request: { ...f.input.request, operationId: 'new-copy-request' } }
 await f.render(next);await act(async () => release())
 expect(dom.container.textContent).not.toContain('Diagnostics copied');expect(JSON.parse(clipboard.values[0]!).operationId).toBe(f.input.request.operationId);expect(f.onContinue).not.toHaveBeenCalled()
})

test('actual typed attach failure stays concise with complete local cause, and copy preserves its stage without Native text', async () => {
 const f = await fixture('attach'), clipboard = await clipboardConsumer()
 expect(dom.container.querySelector('.source-launch-feedback__status')?.textContent).toContain('Tool helper attachment is unconfirmed')
 expect(dom.container.querySelector('.source-launch-feedback__status')?.textContent).not.toContain('Expected')
 expect(creation()?.textContent).toContain('PRIVATE_NATIVE_PAYLOAD');expect(creation()?.closest('details')?.open).toBe(false)
 await act(async () => button('Copy diagnostics').click());await vi.waitFor(() => expect(clipboard.values).toHaveLength(1))
 expect(clipboard.values[0]).not.toContain('PRIVATE_NATIVE_PAYLOAD');expect(JSON.parse(clipboard.values[0]!).original.issues).toContainEqual(expect.objectContaining({failure:expect.objectContaining({hostId:'local',role:'executor',stage:'attach',reference:f.receipt.execution!.reference})}))
 expect(f.calls).toEqual([]);expect(f.onContinue).not.toHaveBeenCalled()
})

test('a same-operation receipt from another Source cannot supply copied binding facts', async () => {
 const f = await fixture(), clipboard = await clipboardConsumer()
 await f.render({ ...f.input, target: { ...f.input.target, reference: { ...f.input.target.reference, runtimeId: 'new-source-runtime' } } })
 await act(async () => button('Copy diagnostics').click());await vi.waitFor(() => expect(clipboard.values).toHaveLength(1))
 const diagnosis=JSON.parse(clipboard.values[0]!)
 expect(diagnosis.source.reference.runtimeId).toBe('new-source-runtime');expect(diagnosis).not.toHaveProperty('execution');expect(diagnosis.original.outcome).toBe('unobserved');expect(f.calls).toEqual([])
})
