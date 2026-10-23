// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { learningPublicFixture } from './agent-learning-public-fixture.js'
import { registerAgentLearningIpc } from '../../desktop/src/main/agent-learning-ipc.js'
import { unwrapSessionInputOperationResult } from '../../desktop/src/shared/session-input-result.js'
import { SessionLearningSurface } from '../../desktop/src/renderer/src/components/SessionLearningSurface.js'
import { api } from '../../desktop/src/renderer/src/lib/api.js'
import { useAppStore } from '../../desktop/src/renderer/src/store.js'
import { createClientUiRoot } from '../../desktop/test/helpers/client-ui-render.js'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root
let pending: Set<Promise<unknown>>
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  pending = new Set()
})
afterEach(async () => { await act(async () => root.unmount()); useAppStore.setState(initial, true); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function track<T>(promise: Promise<T>): Promise<T> { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
async function settle() { await act(async () => { while (pending.size) await Promise.all([...pending]) }) }
async function click(node: HTMLElement, wait = true) { await act(async () => node.click()); if (wait) await settle() }
async function choose(label: string, text: string) {
  const field = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  await waitFor(() => expect(field.disabled).toBe(false))
  await act(async () => { field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  let option: HTMLElement | undefined
  await waitFor(() => { const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]; option = rows.find(node => node.textContent?.includes(text)); expect(option, JSON.stringify({ options: rows.map(node => node.textContent), surface: container.textContent })).toBeDefined() })
  expect(option, `Real selection option ${text}`).toBeDefined()
  await click(option!)
}
async function waitFor(test: () => void) { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); test() }) }
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!

async function consumer() {
  const f = await learningPublicFixture(), frame = {}, contents = { mainFrame: frame }
  const runtime = { callOriginalCore: async (_host: string, method: any, input: any) => f.client.call(method, input) } as any
  const handlers = new Map<string, (event: { sender: unknown; senderFrame: unknown }, ...values: unknown[]) => unknown>()
  registerAgentLearningIpc({ handle: (channel, handler) => handlers.set(channel, handler), contents, authority: f.authority, runtime })
  const invoke = (channel: string, values: unknown[], event = { sender: contents as unknown, senderFrame: frame as unknown }) =>
    Promise.resolve().then(() => handlers.get(channel)!(event, ...values))
  // Only the Electron bridge is substituted; production IPC handlers, live authority,
  // original Unix transport, Host resource readers and Core creation/input execute.
  const bridge = {
    call: async (method: any, input: any) => unwrapSessionInputOperationResult(await track(invoke('agentLearning:call', [method, input])) as any),
    confirm: async (input: any) => unwrapSessionInputOperationResult(await track(invoke('agentLearning:confirm', [input])) as any)
  }
  vi.spyOn(api.agentLearning, 'call').mockImplementation(bridge.call)
  vi.spyOn(api.agentLearning, 'confirm').mockImplementation(bridge.confirm)
  vi.spyOn(api.topics, 'call').mockImplementation((method, input) => track(f.client.call(method, input)))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => track(f.spatial.read()))
  useAppStore.setState({ config: f.config, executorDetections: {}, hostExecutorInventories: {}, executeControl: async () => ({ operation: 'space.ls', ...(await track(f.client.call('space.ls', { target: {} }))) }) })
  const close = vi.fn(), render = async (active = true) => { await act(async () => root.render(<SessionLearningSurface source={{ hostId: 'local', agentSessionId: 'source' }} label="Original source work" active={active} onClose={close} />)); await settle() }
  return { ...f, frame, contents, invoke, close, render }
}

it('lets the real review surface edit a candidate and explicitly hand its exact bytes to a selected original Topic', async () => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  const catalogue = await f.client.call('space.ls', { target: {} })
  expect(catalogue.catalog.spaces).toHaveLength(2)
  expect(useAppStore.getState().config?.workspaces).toEqual(f.config.workspaces)
  await f.render(); await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(f.started).toHaveLength(1)
  const editor = container.querySelector<HTMLTextAreaElement>('textarea')!, text = proposed.candidate!.content + '\nHuman reviewed scope: preserve uncertainty.'
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text); editor.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button('Save draft')); await waitFor(() => expect(button('Save draft').disabled).toBe(true))
  await waitFor(() => expect(button('Check original').disabled).toBe(false))
  expect((await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!.candidate!.content).toBe(text)
  await choose('Learning destination', 'Topic · local')
  await choose('Learning Agent', 'Original saved Executor')
  expect(f.started).toHaveLength(1)
  await click(button('Confirm & send for learning'))
  await waitFor(() => expect(container.textContent).toContain('Reviewed candidate confirmed'))
  const retained = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(retained.approved!.target).toEqual(f.targets[1]); expect(retained.learner!.context).toBe('confirmed')
  expect((await f.store.readMetadata(retained.learner!.agentSessionId))!.initialInput!.message.systemContext).toContain(text)
  expect(f.started).toHaveLength(2)
  await f.render(false); await f.render(true); await waitFor(() => expect(container.textContent).toContain(retained.learner!.agentSessionId))
  expect(f.started).toHaveLength(2); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps edits entered while a read is pending and rejects ordinary, stale-byte and child-frame confirmation', async () => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  await f.render(); await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  const originalCall = api.agentLearning.call.bind(api.agentLearning)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(api.agentLearning, 'call').mockImplementation(async (method, input) => {
    const result = await originalCall(method, input)
    if (method === 'agent.learning.inspect') await held
    return result
  })
  await click(button('Check original'), false)
  const editor = container.querySelector<HTMLTextAreaElement>('textarea')!, later = 'A human edit entered while the original read is pending.'
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, later); editor.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => release()); await waitFor(() => expect(button('Check original').disabled).toBe(false))
  expect(editor.value).toBe(later)
  const confirmation = f.confirmation(proposed)
  await expect(f.authority.confirm({ ...confirmation, candidateDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'LEARNING_REVISION_CONFLICT' })
  await expect(f.invoke('agentLearning:confirm', [confirmation], { sender: f.contents, senderFrame: {} })).rejects.toThrow('main frame')
  await expect(f.invoke('agentLearning:confirm', [confirmation], { sender: {}, senderFrame: f.frame })).rejects.toThrow('Untrusted')
  await expect(f.invoke('agentLearning:call', ['agent.learning.confirm', confirmation]).then(value => unwrapSessionInputOperationResult(value as any))).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.started).toHaveLength(1)
})

it('rejects a foreign native sender before reading or editing a private candidate through the registered Main handler', async () => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  const foreign = { sender: {}, senderFrame: f.frame }
  await expect(f.invoke('agentLearning:call', ['agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId }], foreign)).rejects.toThrow('Untrusted Agent experience review sender')
  await expect(f.invoke('agentLearning:call', ['agent.learning.revise', { hostId: 'local', operationId: proposed.operationId, expectedRevision: proposed.revision, content: 'A foreign frame changed this private candidate.' }], foreign)).rejects.toThrow('Untrusted Agent experience review sender')
  const retained = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(retained).toEqual(proposed)
  expect(f.started).toHaveLength(1)
})

it.each(['topic', 'spatial'] as const)('keeps a confirmed Mote usable when independent %s discovery is unavailable', async failed => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  if (failed === 'topic') vi.spyOn(api.topics, 'call').mockRejectedValue(new Error('Original Topic owner is unavailable'))
  else vi.spyOn(api.spatial, 'read').mockRejectedValue(new Error('Original Topic owner is unavailable'))
  await f.render(); await waitFor(() => expect(container.textContent).toContain('Original Topic owner is unavailable'))
  await choose('Learning destination', 'Mote · local'); await choose('Learning Agent', 'Original saved Executor')
  await click(button('Confirm & send for learning'))
  const current = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(current.approved!.target).toEqual(f.targets[0]); expect(current.learner!.state).toBe('created')
  expect(f.started).toHaveLength(2); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('retains a known Topic selection and draft through an unavailable observation, while its original resource still fences confirmation', async () => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  await f.render(); await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  await choose('Learning destination', 'Topic · local'); await choose('Learning Agent', 'Original saved Executor')
  const editor = container.querySelector<HTMLTextAreaElement>('textarea')!, local = proposed.candidate!.content + '\nRetain my original qualification.'
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, local); editor.dispatchEvent(new Event('input', { bubbles: true })) })
  vi.spyOn(api.topics, 'call').mockRejectedValue(new Error('Original Topic owner is unavailable'))
  await click(button('Check original')); await waitFor(() => expect(container.textContent).toContain('Original Topic owner is unavailable'))
  expect(editor.value).toBe(local); expect(container.querySelector('[aria-label="Learning destination"]')!.textContent).toContain('Same displayed destination')
  await click(button('Save draft')); await waitFor(() => expect(button('Confirm & send for learning').disabled).toBe(false))
  const original = (await f.topics.read(f.workspace, f.targets[1]!.topicId))!.physicalDirectoryPath!
  await rename(original, original + '-moved')
  await click(button('Confirm & send for learning')); await waitFor(() => expect(container.textContent).toContain('Original result needs attention'))
  const current = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(current.approved).toBeNull(); expect(current.learner).toBeNull(); expect(current.candidate!.content).toBe(local)
  expect(f.started).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
