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
async function edit(content: string) {
  const editor = container.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, content); editor.dispatchEvent(new Event('input', { bubbles: true })) })
}
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
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text)!

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
  expect(container.textContent).not.toContain('Experience ready to review')
  expect(container.querySelector('textarea')).toBeNull()
  const confirmedCandidate = container.querySelector<HTMLDetailsElement>('.session-learning__candidate')!
  expect(confirmedCandidate.open).toBe(false)
  expect(confirmedCandidate.querySelector('pre')!.textContent).toBe(text)
  expect(container.querySelector('.session-learning__status')!.textContent).toContain('Reviewed candidate confirmed')
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

it('retains a later edit across an outstanding save and remount, then saves it against the exact returned original revision', async () => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  await f.render(); await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  const original = api.agentLearning.call.bind(api.agentLearning)
  let release!: () => void, saved!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), received = new Promise<void>(resolve => { saved = resolve })
  vi.spyOn(api.agentLearning, 'call').mockImplementation(async (method, input) => {
    const result = await original(method, input)
    if (method === 'agent.learning.revise') { saved(); await held }
    return result
  })
  const submitted = 'First human correction, with explicit original uncertainty.', later = submitted + '\nA later edit entered while its save reply was pending.'
  await edit(submitted); await click(button('Save draft'), false); await received; await edit(later)
  await act(async () => release()); await waitFor(() => expect(button('Save draft').disabled).toBe(false))
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(later)
  const key = JSON.stringify(['local', 'source']), retained = useAppStore.getState().agentLearningReviewDrafts[key]!
  expect(retained.draft).toEqual({ content: later, expectedRevision: proposed.revision + 1 })
  const persistence = useAppStore.persist.getOptions()
  const written = JSON.parse(JSON.stringify(persistence.partialize!(useAppStore.getState())))
  expect(written.agentLearningReviewDrafts[key]).toEqual(retained)
  const restored = persistence.merge!(written, { ...initial, config: f.config })
  useAppStore.setState(restored, true)
  await act(async () => { root.unmount(); root = createClientUiRoot(container) }); await f.render()
  await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(later)
  await waitFor(() => expect(button('Save draft').disabled).toBe(false))
  await click(button('Save draft'))
  const current = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(current.revision).toBe(proposed.revision + 2); expect(current.candidate!.content).toBe(later)
  expect(useAppStore.getState().agentLearningReviewDrafts[key]!.draft).toBeNull()
  expect(f.started).toHaveLength(1)
})

it('keeps a later edit visibly outside an already confirmed candidate when its exact confirmation reply arrives late', async () => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  await f.render(); await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  await choose('Learning destination', 'Topic · local'); await choose('Learning Agent', 'Original saved Executor')
  const actualCreate = f.core.createAgentWithDelivery.bind(f.core)
  const create = vi.spyOn(f.core, 'createAgentWithDelivery').mockRejectedValueOnce(new Error('Private learner dispatch returned no Core result'))
  const original = api.agentLearning.confirm.bind(api.agentLearning)
  let release!: () => void, confirmed = false
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(api.agentLearning, 'confirm').mockImplementation(async input => { const result = await original(input); confirmed = true; await held; return result })
  await click(button('Confirm & send for learning'), false)
  await vi.waitFor(() => expect(confirmed, container.textContent ?? '').toBe(true), { timeout: 5_000 })
  const later = proposed.candidate!.content + '\nAn edit entered after the explicit confirmation action.'
  await edit(later); await act(async () => release()); await waitFor(() => expect(container.textContent).toContain('Reviewed candidate confirmed'))
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(later)
  expect(container.textContent).toContain('outside the confirmed candidate')
  expect(container.querySelector('details pre')!.textContent).toBe(proposed.candidate!.content)
  const retained = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(retained.candidate!.content).toBe(proposed.candidate!.content); expect(retained.approved!.target).toEqual(f.targets[1])
  expect(retained.learner!.state).toBe('unknown'); expect(f.started).toHaveLength(1)
  create.mockImplementation(actualCreate)
  await click(button('Continue original delivery')); await waitFor(() => expect(f.started).toHaveLength(2))
  const retainedEditor = container.querySelector<HTMLTextAreaElement>('textarea')
  expect(retainedEditor, 'The later edit must remain outside the approved candidate after original delivery continues').not.toBeNull()
  expect(retainedEditor!.value).toBe(later)
  expect(container.textContent).toContain('outside the confirmed candidate')
  expect((await f.store.readMetadata(retained.learner!.agentSessionId))!.initialInput!.message.systemContext).not.toContain(later)
  expect(useAppStore.getState().agentLearningReviewDrafts[JSON.stringify(['local', 'source'])]!.draft!.content).toBe(later)
  expect(f.started).toHaveLength(2)
})

it('keeps a conflicting local draft, shows the exact current candidate and saves only an explicitly merged version', async () => {
  const f = await consumer(), proposed = await f.propose(await f.prepare())
  await f.render(); await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  const local = 'My retained change based on the candidate I saw.', other = 'Another editor preserved an additional original limitation.'
  await edit(local)
  const current = (await f.client.call('agent.learning.revise', { hostId: 'local', operationId: proposed.operationId, expectedRevision: proposed.revision, content: other })).operation
  await click(button('Check original')); await waitFor(() => expect(container.querySelector('details pre')!.textContent).toBe(other))
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(local)
  expect(button('Save draft').disabled).toBe(true)
  expect(useAppStore.getState().agentLearningReviewDrafts[JSON.stringify(['local', 'source'])]!.draft!.expectedRevision).toBe(proposed.revision)
  const merged = other + '\n' + local
  await edit(merged); await click(button('Save merged draft against revision ' + current.revision))
  const saved = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(saved.revision).toBe(current.revision + 1); expect(saved.candidate!.content).toBe(merged)
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
  const confirmation = button('Confirm & send for learning')
  confirmation.focus()
  await click(confirmation); await waitFor(() => expect(container.textContent).toContain('Original result needs attention'))
  expect(document.activeElement).toBe(confirmation)
  expect(confirmation.textContent).toBe('Result needs attention · Inspect original result')
  expect(confirmation.getAttribute('aria-label')).toBe(confirmation.textContent)
  expect(confirmation.parentElement!.querySelector('[role="status"]')!.textContent).toContain('Original result needs attention')
  expect(button('Inspect original request')).toBeDefined()
  vi.spyOn(api.topics, 'call').mockImplementation((method, input) => track(f.client.call(method, input)))
  await click(button('Check original'))
  expect(confirmation.getAttribute('aria-label')).toBe('Result needs attention · Inspect original result')
  expect(container.textContent).toContain('Original result needs attention')
  const current = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation!
  expect(current.approved).toBeNull(); expect(current.learner).toBeNull(); expect(current.candidate!.content).toBe(local)
  expect(f.started).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
