// @vitest-environment happy-dom
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { join } from 'node:path'
const environment = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const supplied = process.env.AMX_DELETE_HOME, root = supplied ?? mkdtempSync(join(tmpdir(), 'amx-delete-renderer-'))
  const { isolateCoreFixtureEnvironment } = await import('./helpers/isolate-core-environment')
  isolateCoreFixtureEnvironment(root); vi.stubEnv('HOME', root)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); await import('../src/renderer/src/lib/api'); vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  return { root, owned: !supplied }
})
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (environment.owned) await (await import('node:fs/promises')).rm(environment.root, { recursive: true, force: true }) })
const target = { hostId: 'selected-host', agentSessionId: 'retired-original' }, request = { ...target, operationId: 'retained-original-delete', expectedRetiredAt: 1, expectedRetirementRevision: '1'.repeat(64) }
const draft = 'Synthetic unassociated draft 中🙂\n exact end  ', queue = { operationId: 'original-unsent-input', text: 'Synthetic original queued text 中🙂\n exact end  ', status: 'deferred' as const,
  archived: true, awaitingExplicitSend: true, inputIntakeStarted: true, directInputControl: { kind: 'agent' as const, ...target, run: { runId: 'old-run' } } }
const reading = process.env.AMX_DELETE_PHASE === 'read', check = reading ? it.skip : it
async function desktop(seed = true) {
  const { WorkbenchUserStateStore } = await import('../src/main/workbench-user-state'), owner = new WorkbenchUserStateStore(join(environment.root, 'delete-user-state.json'))
  if (seed) await owner.write(JSON.stringify({ version: 1, state: { agentComposerDrafts: { 'unbound-original-region': draft }, agentSteerQueues: { [target.agentSessionId]: [queue] } } }))
  const { useAppStore: store } = await import('../src/renderer/src/store'), { api } = await import('../src/renderer/src/lib/api')
  const { AgentMuxSpatialStateStore } = await import('@agentmux/core/spatial-state'), spatial = new AgentMuxSpatialStateStore(join(environment.root, 'delete-spatial.json'))
  const { providerCatalogReader, historySourcesReader } = await import('./helpers/startup-observation-api-fixture')
  const config = { version: 9, hosts: [{ id: 'selected-host', kind: 'local' as const, label: 'Private selected Host' }], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' as const }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  store.setState({ config, sessions: [], tabs: {}, layouts: {}, sessionRecordDeletionRequests: {}, agentComposerDrafts: {}, agentSteerQueues: {} })
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => owner.read()); vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => owner.importIfAbsent(value)); vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => owner.write(value)); vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(config); vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader()); vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] }); vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined); vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout()); vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value)); vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener)); vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  cleanups.push(await store.getState().initialize())
  // Each UI test supplies a new original local input fixture. The first/native
  // checkpoint and separate fresh-process case exercise the real hydration owner.
  if (seed) store.setState({ sessionRecordDeletionRequests: {}, agentComposerDrafts: { 'unbound-original-region': draft }, agentSteerQueues: { [target.agentSessionId]: [queue] } })
  return { store, api, owner }
}
async function mount(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const unmount = async () => { await act(async () => root.unmount()); container.remove() }; cleanups.push(unmount)
  await act(async () => root.render(node)); return { container, unmount }
}
async function click(container: Element, label: string) { const button = [...container.querySelectorAll('button')].find(node => node.textContent === label); expect(button, 'delete-real-mounted-control-' + label).toBeDefined(); await act(async () => button!.click()) }

check('actual native user-state checkpoint saves only the immutable original deletion reference and preserves every local input', async () => {
  const f = await desktop(), { retainSessionRecordDeleteRequest, settleSessionRecordDeleteRequest } = await import('../src/renderer/src/store')
  await retainSessionRecordDeleteRequest(request)
  const saved = JSON.parse((await f.owner.read())!).state
  expect(saved.sessionRecordDeletionRequests, 'delete-original-reference-native-ACK').toEqual({ [JSON.stringify([target.hostId, target.agentSessionId])]: request })
  expect(saved.agentComposerDrafts['unbound-original-region'], 'delete-native-checkpoint-keeps-unbound-draft').toBe(draft)
  expect(saved.agentSteerQueues[target.agentSessionId]).toEqual([queue])
  await expect(retainSessionRecordDeleteRequest({ ...request, operationId: 'replacement-request' }), 'delete-does-not-mint-replacement-for-original').rejects.toThrow('Another original')
  await settleSessionRecordDeleteRequest({ ...request, operationId: 'another-operation' })
  expect(f.store.getState().sessionRecordDeletionRequests).toEqual(saved.sessionRecordDeletionRequests)
})

check('mounted unknown deletion is never automatically replayed; explicit Retry preserves the exact saved original operation and witness', async () => {
  const f = await desktop(), { SessionRecordDelete } = await import('../src/renderer/src/components/SessionRecordDelete')
  const inspect = vi.spyOn(f.api.sessions, 'inspectRecord').mockResolvedValue({ ...target, observedAt: 2, state: 'retired', retiredAt: 1, retirementRevision: '1'.repeat(64), pendingLifecycle: false })
  const deletion = vi.spyOn(f.api.sessions, 'deleteRecord').mockRejectedValueOnce(new Error('Private transport reply unknown'))
  const onDeleted = vi.fn(), view = await mount(<SessionRecordDelete target={target} onDeleted={onDeleted} />)
  await click(view.container, 'Delete AgentMux record'); await click(view.container, 'Delete AgentMux record')
  await act(async () => { await vi.waitFor(() => expect(deletion, view.container.textContent ?? 'actual delete UI').toHaveBeenCalledTimes(1)) })
  const first = deletion.mock.calls[0]!, state = JSON.parse((await f.owner.read())!).state, held = Object.values(state.sessionRecordDeletionRequests)[0]
  expect(held, 'delete-unknown-keeps-original-request-in-native-document').toEqual({ ...first[0], ...first[1] })
  await click(view.container, 'Check original result')
  expect(view.container.textContent, 'delete-retired-observation-keeps-unknown').toContain('does not prove that request was not applied')
  expect(deletion, 'delete-inspect-never-replays-original').toHaveBeenCalledTimes(1)
  deletion.mockImplementationOnce(async (reference, options) => ({ ...reference, retiredAt: 1, persistence: 'confirmed', deletion: { operationId: options.operationId, retirementRevision: options.expectedRetirementRevision, deletedAt: 3, phase: 'complete' } }))
  await click(view.container, 'Retry original deletion'); await click(view.container, 'Delete AgentMux record')
  await act(async () => { await vi.waitFor(() => expect(deletion, view.container.textContent ?? 'actual retry UI').toHaveBeenCalledTimes(2)) })
  expect(deletion.mock.calls[1]!.slice(0, 2), 'delete-explicit-retry-keeps-exact-original-target-and-witness').toEqual(first.slice(0, 2))
  await act(async () => { await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1)) }); expect(inspect.mock.calls.length).toBeGreaterThan(0)
  expect(f.store.getState().agentComposerDrafts['unbound-original-region']).toBe(draft); expect(f.store.getState().agentSteerQueues[target.agentSessionId]).toEqual([queue])
})

check('an undecodable saved request is kept without inventing a replacement; another operation ACK cannot settle it', async () => {
  const f = await desktop(), { retainedSessionRecordDelete } = await import('../src/renderer/src/lib/session-record-delete'), { SessionRecordDelete } = await import('../src/renderer/src/components/SessionRecordDelete')
  const original = { [JSON.stringify([target.hostId, target.agentSessionId])]: { ...request, originalUnknownField: true } }
  f.store.setState({ sessionRecordDeletionRequests: original })
  expect(retainedSessionRecordDelete(original, target).state).toBe('unavailable')
  vi.spyOn(f.api.sessions, 'inspectRecord').mockResolvedValue({ ...target, observedAt: 2, state: 'deleted', operationIdMatched: false, receipt: { ...target, retiredAt: 1, persistence: 'confirmed', deletion: { operationId: 'another-original-operation', retirementRevision: '1'.repeat(64), deletedAt: 3, phase: 'pending' } } })
  const deletion = vi.spyOn(f.api.sessions, 'deleteRecord')
  const view = await mount(<SessionRecordDelete target={target} onDeleted={() => {}} />)
  expect(f.store.getState().sessionRecordDeletionRequests).toBe(original)
  expect([...view.container.querySelectorAll('button')].filter(button => button.textContent === 'Finish recorded cleanup').every(button => button.disabled), 'delete-unknown-request-cannot-borrow-foreign-cleanup').toBe(true)
  expect(deletion).not.toHaveBeenCalled()
})

if (reading) it('a fresh process hydrates the same original deletion request and local inputs without replay or Session reconstruction', async () => {
  const f = await desktop(false), { retainedSessionRecordDelete } = await import('../src/renderer/src/lib/session-record-delete')
  expect(retainedSessionRecordDelete(f.store.getState().sessionRecordDeletionRequests, target), 'delete-fresh-process-finds-original-reference').toEqual({ state: 'retained', request })
  expect(f.store.getState().agentComposerDrafts['unbound-original-region']).toBe(draft); expect(f.store.getState().agentSteerQueues[target.agentSessionId]).toEqual([queue])
  expect(f.store.getState().sessions).toEqual([])
})

check('the actual Store terminal event keeps independent draft and queue objects reachable and copyable through the original local-input consumer', async () => {
  const f = await desktop(), before = { drafts: f.store.getState().agentComposerDrafts, queues: f.store.getState().agentSteerQueues }
  const { FocusScanActions } = await import('../src/renderer/src/components/FocusScanActions')
  const copy = vi.spyOn(f.api.ui, 'writeClipboardText').mockResolvedValue(undefined), send = vi.spyOn(f.api.sessions, 'submitPrompt')
  f.store.getState().applyEvent({ type: 'core', hostId: target.hostId, event: { type: 'agent-session-record-deleted', agentSessionId: target.agentSessionId, retiredAt: 1,
    recordDeletion: { operationId: request.operationId, retirementRevision: request.expectedRetirementRevision, deletedAt: 2, phase: 'complete' } } })
  expect(f.store.getState().agentComposerDrafts, 'delete-terminal-event-keeps-independent-original-drafts').toBe(before.drafts)
  expect(f.store.getState().agentSteerQueues, 'delete-terminal-event-keeps-independent-original-queue').toBe(before.queues)
  const view = await mount(<FocusScanActions order="priority" onOrderChange={() => {}} />); await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Drafts"]')!.click())
  const inputs = [...document.querySelectorAll<HTMLDetailsElement>('.local-input-record')]
  expect(inputs.length, 'delete-local-unsent-remains-reachable').toBe(2)
  await act(async () => { inputs[0]!.open = true; inputs[0]!.dispatchEvent(new Event('toggle')) })
  await click(inputs[0]!, 'Copy saved input'); expect(copy).toHaveBeenLastCalledWith(draft)
  await act(async () => { inputs[1]!.open = true; inputs[1]!.dispatchEvent(new Event('toggle')) })
  await click(inputs[1]!, 'Copy saved input'); expect(copy).toHaveBeenLastCalledWith(queue.text)
  expect(send).not.toHaveBeenCalled(); expect(view.container).toBeDefined()
})

check('a confirmed complete Core result hides Stop waiting while the original local reference checkpoint still awaits its native ACK', async () => {
  const f = await desktop(), { SessionRecordDelete } = await import('../src/renderer/src/components/SessionRecordDelete')
  let resolveCore!: (value: import('@agentmux/core/agent-session-record').AgentSessionRecordDeletionReceipt) => void, release!: () => void, enter!: () => void
  const held = new Promise<void>(done => { release = done }), entered = new Promise<void>(done => { enter = done })
  let completed = false, delayWrite = false
  const receipt = { ...target, retiredAt: 1, persistence: 'confirmed' as const, deletion: { operationId: 'unused-before-original-input', retirementRevision: '1'.repeat(64), deletedAt: 3, phase: 'complete' as const } }
  vi.spyOn(f.api.sessions, 'inspectRecord').mockImplementation(async (_target, options) => completed ? { ...target, observedAt: 4, state: 'deleted', receipt,
    ...(options.operationId ? { operationIdMatched: options.operationId === receipt.deletion.operationId } : {}) } : { ...target, observedAt: 1, state: 'retired', retiredAt: 1, retirementRevision: '1'.repeat(64), pendingLifecycle: false })
  const deletion = vi.spyOn(f.api.sessions, 'deleteRecord').mockImplementation(async (_target, options) => { receipt.deletion.operationId = options.operationId; return await new Promise(done => { resolveCore = done }) })
  const view = await mount(<SessionRecordDelete target={target} onDeleted={() => {}} />)
  await click(view.container, 'Delete AgentMux record'); await click(view.container, 'Delete AgentMux record')
  await act(async () => { await vi.waitFor(() => expect(deletion).toHaveBeenCalledTimes(1)) })
  expect([...view.container.querySelectorAll('button')].some(button => button.textContent === 'Stop waiting'), 'delete-still-waiting-has-original-stop-action').toBe(true)
  vi.spyOn(f.api.ui, 'writeWorkbenchState').mockImplementation(async value => { const result = await f.owner.write(value); if (delayWrite) { enter(); await held } return result })
  delayWrite = true; completed = true
  await act(async () => { resolveCore(receipt); await entered })
  try {
    expect(view.container.querySelector('[aria-label="Delete AgentMux record"]')!.getAttribute('aria-busy')).toBe('true')
    expect([...view.container.querySelectorAll('button')].some(button => button.textContent === 'Stop waiting'), 'delete-complete-hides-non-cancellable-local-flush-action').toBe(false)
  } finally { delayWrite = false; release() }
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(done => setTimeout(done, 0)) })
    expect(view.container.querySelector('[aria-label="Delete AgentMux record"]')!.getAttribute('aria-busy')).toBe('false')
  }, { timeout: 5000 })
})
