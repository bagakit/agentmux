// @vitest-environment happy-dom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import type { CapsuleInteraction, CapsuleMethod, CapsuleParamsMap, CapsulePort } from '@agentmux/core/capsule'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, compareAndSwapCapsuleQuestionEditor, flushCapsuleQuestionEditors } from '../src/renderer/src/store'
import { capsuleQuestionEditorKey, type CapsuleQuestionEditor } from '../src/renderer/src/lib/capsule-question-editors'
import { CapsuleInteractionChrome } from '../src/renderer/src/components/CapsuleInteractionChrome'
import { CapsuleQuestionReply } from '../src/renderer/src/components/CapsuleQuestionReply'
import { createClientUiRoot } from './helpers/client-ui-render'

let dispose: (() => void) | undefined
let directory: string, owner: NodeCapsuleOwner, service: AgentMuxRpcService, capsuleId: string, interaction: CapsuleInteraction
let root: Root, container: HTMLDivElement, toolbar: HTMLDivElement, reads: Set<Promise<unknown>>, writes: Set<Promise<unknown>>
let transport: CapsulePort['call'], calls: Array<{ method: CapsuleMethod; params: any }>
const browserId = 'original-page-browser', question = 'Keep this original editable answer?'
const context = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'question-editor-user' } }
const key = () => capsuleQuestionEditorKey(browserId, capsuleId, interaction.interactionId)
const stored = () => useAppStore.getState().capsuleQuestionEditors[key()]
function track<T>(set: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  set.add(promise); void promise.then(() => set.delete(promise), () => set.delete(promise)); return promise
}
async function settle(set = reads) { while (set.size) await act(async () => { await Promise.allSettled([...set]) }) }
function editor(scope: ParentNode = container) { const found = scope.querySelector<HTMLTextAreaElement>('textarea'); expect(found).not.toBeNull(); return found! }
function button(text: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(found, 'Connected action: ' + text).toBeDefined(); return found!
}
async function click(text: string, wait = true, scope: ParentNode = container) {
  await act(async () => button(text, scope).click()); if (wait) await settle(writes); await settle()
}
async function change(value: string, scope: ParentNode = container) {
  await act(async () => { const node = editor(scope); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function mount(visible = true) {
  await act(async () => root.render(<CapsuleInteractionChrome browserId={browserId} capsuleId={capsuleId} active visible={visible} toolbarHost={toolbar} />)); await settle()
  const trigger = toolbar.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!
  if (trigger.getAttribute('aria-expanded') === 'false') { await act(async () => trigger.click()); await settle() }
}
async function remove() { await act(async () => root.render(null)) }
const mutations = () => calls.filter(call => call.method === 'capsule.interaction.draft')

beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  useAppStore.setState({ capsuleQuestionEditors: {} }); localStorage.clear()
  directory = await mkdtemp(join(tmpdir(), 'capsule-question-editors-'))
  const sourcePath = join(directory, 'page'); await mkdir(sourcePath); await writeFile(join(sourcePath, 'index.html'), '<title>Editable page</title>')
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'state') })
  capsuleId = (await owner.call('capsule.create', { operationId: 'create-editable-page', sourcePath, mode: 'injected', target: { hostId: 'local', agentSessionId: 'unexecuted-editor-session' } })).record.capsuleId
  interaction = (await owner.call('capsule.interaction.request', { capsuleId, operationId: 'original-editable-question', question, draft: 'Original saved text' })).interaction
  service = new AgentMuxRpcService({ coreClients: () => [], capsules: owner }); reads = new Set(); writes = new Set(); calls = []
  transport = ((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => service.call(method, params, context)) as CapsulePort['call']
  vi.spyOn(api.capsules, 'call').mockImplementation(((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    calls.push({ method, params: structuredClone(params) }); return track(method === 'capsule.interaction.draft' ? writes : reads, transport(method, params))
  }) as CapsulePort['call'])
  vi.spyOn(api.capsuleReplies, 'confirm').mockRejectedValue(new Error('Original confirmation receipt unavailable'))
  container = document.createElement('div'); toolbar = document.createElement('div'); document.body.append(container, toolbar); root = createClientUiRoot(container)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(async () => {
  await act(async () => root.unmount()); await settle(); await settle(writes); vi.useRealTimers()
  container.remove(); toolbar.remove(); service.dispose(); await owner.close(); await rm(directory, { recursive: true, force: true })
  useAppStore.setState({ capsuleQuestionEditors: {} }); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('persists even an empty dirty answer through the real Workbench writer and restore without autosaving on remount', async () => {
  await mount(); await change('')
  await flushCapsuleQuestionEditors()
  const saved = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.capsuleQuestionEditors
  expect(saved[key()]?.answer, 'Original Workbench writer must include the empty dirty answer').toBe('')
  expect(Object.keys(saved[key()]).sort()).toEqual(['answer', 'attempt', 'autoSave', 'baseline', 'notice'])
  await remove(); useAppStore.setState({ capsuleQuestionEditors: {} })
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: useAppStore.persist.getOptions().version, state: { capsuleQuestionEditors: saved } }))
  await act(async () => useAppStore.persist.rehydrate()); await mount()
  expect(editor().value, 'Original dirty bytes must survive a real message unmount and Workbench rehydration').toBe('')
  await act(async () => { vi.advanceTimersByTime(1000) }); await settle(writes)
  expect(mutations(), 'Restoring an editor never resumes an automatic save').toHaveLength(0)
  expect(api.capsuleReplies.confirm).not.toHaveBeenCalled()
  await change('New explicit edit'); await act(async () => { vi.advanceTimersByTime(750) }); await settle(writes)
  expect(mutations()).toHaveLength(1)
  expect((await owner.call('capsule.interaction.inspect', { capsuleId, interactionId: interaction.interactionId })).interaction.draft).toBe('New explicit edit')
  expect(stored(), 'Confirmed clean bytes are recycled after their authoritative projection catches up').toBeUndefined()
})

it('retains unknown confirmation parameters and the original Inspect handle through actual message unmount and restore', async () => {
  await mount(); await change('Keep this exact confirmation'); await click('Confirm answer')
  const params = structuredClone(vi.mocked(api.capsuleReplies.confirm).mock.calls[0]![0])
  await flushCapsuleQuestionEditors(); const retained = localStorage.getItem('agentmux-workbench-v1')!
  await remove(); useAppStore.setState({ capsuleQuestionEditors: {} }); localStorage.setItem('agentmux-workbench-v1', retained)
  await act(async () => useAppStore.persist.rehydrate()); await mount()
  expect(stored()?.attempt?.params, 'Restored unknown confirmation must retain the exact original operation').toEqual(params)
  expect(editor().readOnly).toBe(true); expect(editor().value).toBe('Keep this exact confirmation')
  expect(button('Confirm answer').disabled).toBe(true)
  await click('Inspect original operation')
  expect(calls.filter(call => call.method === 'capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: params.operationId })
  expect(api.capsuleReplies.confirm).toHaveBeenCalledOnce()
})

it('restores a persisted pending handle as inspectable unknown without inventing a new operation', async () => {
  const pending: CapsuleQuestionEditor = { answer: 'Original pending text', baseline: { value: interaction.draft, revision: interaction.revision }, autoSave: true, notice: '',
    attempt: { method: 'capsule.interaction.draft', pending: true, params: { capsuleId, interactionId: interaction.interactionId, expectedRevision: interaction.revision, operationId: 'original-pending-draft', draft: 'Original pending text' } } }
  compareAndSwapCapsuleQuestionEditor(key(), undefined, pending); await flushCapsuleQuestionEditors(); const saved = localStorage.getItem('agentmux-workbench-v1')!
  useAppStore.setState({ capsuleQuestionEditors: {} }); localStorage.setItem('agentmux-workbench-v1', saved)
  await act(async () => useAppStore.persist.rehydrate())
  expect(stored()?.attempt?.pending, 'A restored handle cannot claim that its old JavaScript promise is still running').toBe(false)
  await mount(); expect(button('Inspect original operation').disabled).toBe(false)
  await click('Inspect original operation'); expect(mutations()).toHaveLength(0)
  expect(calls.filter(call => call.method === 'capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: 'original-pending-draft' })
})

it('keeps later editable bytes when the original save resolves after the message was unmounted and remounted', async () => {
  let resolveDraft!: (value: any) => void
  const actual = transport
  transport = ((method, params) => method === 'capsule.interaction.draft' ? new Promise(resolve => { resolveDraft = resolve }) : actual(method, params)) as CapsulePort['call']
  await mount(); await change('Captured original bytes'); await click('Save draft', false)
  const original = mutations()[0]!
  await remove(); await mount(); expect(stored()?.attempt?.pending).toBe(true)
  await change('Later unsent bytes')
  const result = await owner.call('capsule.interaction.draft', original.params)
  await act(async () => resolveDraft(result)); await settle(writes)
  expect(editor().value, 'A late original save cannot replace text entered after remount').toBe('Later unsent bytes')
  expect(stored()?.baseline).toEqual({ value: 'Captured original bytes', revision: result.interaction.revision })
  expect(stored()?.attempt).toBeNull(); expect(button('Save draft').disabled).toBe(false)
  await remove(); await mount(); expect(editor().value).toBe('Later unsent bytes')
})

it('rejects a stale original result after a newer exact editor attempt replaced its handle', async () => {
  let resolveDraft!: (value: any) => void
  const actual = transport
  transport = ((method, params) => method === 'capsule.interaction.draft' ? new Promise(resolve => { resolveDraft = resolve }) : actual(method, params)) as CapsulePort['call']
  await mount(); await change('Original captured bytes'); await click('Save draft', false)
  const old = mutations()[0]!, before = stored()!
  const replacement: CapsuleQuestionEditor = { ...before, answer: 'Newer editor bytes', attempt: { ...before.attempt!, pending: false,
    params: { ...before.attempt!.params, operationId: 'different-original-operation' } } }
  await act(async () => { compareAndSwapCapsuleQuestionEditor(key(), before, replacement) })
  const result = await owner.call('capsule.interaction.draft', old.params)
  await act(async () => resolveDraft(result)); await settle(writes)
  expect(stored()?.attempt?.params.operationId, 'Late outcomes must compare the exact original attempt before updating the current editor').toBe('different-original-operation')
  expect(stored()?.answer).toBe('Newer editor bytes')
})

it('broadcasts one exact editor and pending attempt to mounted forms while keeping other Browser workfaces separate', async () => {
  let resolveDraft!: (value: any) => void
  const actual = transport
  transport = ((method, params) => method === 'capsule.interaction.draft' ? new Promise(resolve => { resolveDraft = resolve }) : actual(method, params)) as CapsulePort['call']
  await act(async () => root.render(<>{[browserId, browserId, 'other-original-browser'].map((id, index) => <div data-editor={index} key={index}><CapsuleQuestionReply browserId={id} interaction={interaction} onUpdated={() => {}} /></div>)}</>))
  const scope = (index: number) => container.querySelector(`[data-editor="${index}"]`)!
  await change('Shared exact editor', scope(0)); expect(editor(scope(1)).value).toBe('Shared exact editor'); expect(editor(scope(2)).value).toBe(interaction.draft)
  await click('Save draft', false, scope(0))
  expect(button('Confirm answer', scope(1)).disabled, 'The same original workface cannot mint a second operation while its handle is pending').toBe(true)
  expect(button('Confirm answer', scope(2)).disabled).toBe(false)
  const result = await owner.call('capsule.interaction.draft', mutations()[0]!.params)
  await act(async () => resolveDraft(result)); await settle(writes)
  expect(editor(scope(0)).value).toBe('Shared exact editor'); expect(editor(scope(1)).value).toBe('Shared exact editor')
})

it('the original writer refuses a stale compare-and-swap without clearing newer retained bytes', () => {
  const first: CapsuleQuestionEditor = { answer: 'first', baseline: { value: interaction.draft, revision: interaction.revision }, attempt: null, autoSave: false, notice: '' }
  const next = { ...first, answer: 'later' }
  expect(compareAndSwapCapsuleQuestionEditor(key(), undefined, first)).toBe(true)
  expect(compareAndSwapCapsuleQuestionEditor(key(), first, next)).toBe(true)
  expect(compareAndSwapCapsuleQuestionEditor(key(), first, undefined), 'The existing editor owner must reject stale replacement').toBe(false)
  expect(stored()?.answer).toBe('later')
})

it('does not dispatch when the original Workbench durability receipt fails and keeps the editor usable', async () => {
  await mount(); await change('Retain without dispatch')
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('Original workbench commit unavailable'))
  await click('Save draft')
  expect(mutations()).toHaveLength(0); expect(editor().value).toBe('Retain without dispatch')
  expect(button('Save draft').disabled).toBe(false); expect(container.textContent).toContain('Original workbench commit unavailable')
})

it.each(['Save draft', 'Confirm answer'])('rechecks the exact original attempt after delayed durability before %s dispatch', async action => {
  await mount(); await change('Captured before delayed storage')
  let releaseFlush!: () => void
  const pendingFlush = new Promise<void>(resolve => { releaseFlush = resolve })
  vi.mocked(api.ui.requestStorageFlush).mockReturnValue(pendingFlush)
  await click(action, false)
  const before = stored()!
  expect(before.attempt?.pending).toBe(true)
  const replacement: CapsuleQuestionEditor = { ...before, answer: 'New retained bytes', attempt: { ...before.attempt!, pending: false,
    params: { ...before.attempt!.params, operationId: 'new-original-during-flush' } } }
  await act(async () => { compareAndSwapCapsuleQuestionEditor(key(), before, replacement); releaseFlush(); await pendingFlush })
  await settle(writes)
  expect(mutations(), 'A stale original attempt cannot dispatch after the durability await').toHaveLength(0)
  expect(api.capsuleReplies.confirm, 'A stale original attempt cannot confirm after the durability await').not.toHaveBeenCalled()
  expect(stored()).toBe(replacement)
})

it.each(['Save draft', 'Confirm answer'])('does not redispatch a restored unknown with unchanged parameters after delayed %s durability', async action => {
  await mount(); await change('Original bytes before restore')
  let releaseFlush!: () => void
  const pendingFlush = new Promise<void>(resolve => { releaseFlush = resolve })
  vi.mocked(api.ui.requestStorageFlush).mockReturnValue(pendingFlush)
  await click(action, false)
  const before = stored()!
  const restored: CapsuleQuestionEditor = { ...before, autoSave: false, attempt: { ...before.attempt!, pending: false } }
  await act(async () => { compareAndSwapCapsuleQuestionEditor(key(), before, restored); releaseFlush(); await pendingFlush })
  await settle(writes)
  expect(mutations(), 'Restored unknown must not regain the original live dispatch lease').toHaveLength(0)
  expect(api.capsuleReplies.confirm).not.toHaveBeenCalled(); expect(stored()).toBe(restored)
  expect(button('Inspect original operation').disabled).toBe(false)
})

it('keeps malformed retained bytes and their original handle with a local issue while another original editor stays usable', async () => {
  const malformed = { answer: 'Retained readable bytes', baseline: { value: interaction.draft, revision: interaction.revision }, autoSave: false, notice: '',
    attempt: { method: 'capsule.interaction.draft', pending: false, params: { capsuleId: 'ABCDEFGHJKLM', interactionId: interaction.interactionId,
      operationId: 'unreadable-original-operation', expectedRevision: interaction.revision, draft: 'Retained readable bytes' } } } as CapsuleQuestionEditor
  compareAndSwapCapsuleQuestionEditor(key(), undefined, malformed)
  await act(async () => root.render(<>{[browserId, 'healthy-original-browser'].map(id => <div data-original-browser={id} key={id}><CapsuleQuestionReply browserId={id} interaction={interaction} onUpdated={() => {}} /></div>)}</>))
  const bad = container.querySelector(`[data-original-browser="${browserId}"]`)!, healthy = container.querySelector('[data-original-browser="healthy-original-browser"]')!
  expect(editor(bad).value, 'An unreadable attempt must retain the original readable answer bytes').toBe('Retained readable bytes')
  expect(editor(bad).readOnly).toBe(true); expect(bad.textContent).toContain('unreadable-original-operation')
  expect(bad.textContent).toContain('retained page answer belongs to another original question')
  expect(button('Confirm answer', bad).disabled).toBe(true); expect(stored()).toBe(malformed)
  await change('Healthy independent draft', healthy); await click('Save draft', true, healthy)
  expect(mutations()).toHaveLength(1); expect(mutations()[0]!.params.draft).toBe('Healthy independent draft')
  expect(stored()).toBe(malformed); expect(api.capsuleReplies.confirm).not.toHaveBeenCalled()
})
