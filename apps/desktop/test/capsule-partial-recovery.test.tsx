// @vitest-environment happy-dom
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import type { CapsuleInteraction, CapsuleMethod, CapsuleParamsMap, CapsulePort, CapsuleResultMap } from '@agentmux/core/capsule'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { api } from '../src/renderer/src/lib/api'
import { CapsuleInteractionChrome } from '../src/renderer/src/components/CapsuleInteractionChrome'
import { createClientUiRoot } from './helpers/client-ui-render'

vi.mock('../src/renderer/src/lib/api', () => ({ api: { capsules: { call: vi.fn() }, capsuleReplies: { confirm: vi.fn() } } }))

let directory: string, owner: NodeCapsuleOwner, service: AgentMuxRpcService, capsuleId: string
let original: CapsuleInteraction, healthy: CapsuleInteraction, container: HTMLDivElement, toolbar: HTMLDivElement, root: Root
let transport: CapsulePort['call'], flights: Set<Promise<unknown>>
let calls: Array<{ method: CapsuleMethod; params: CapsuleParamsMap[CapsuleMethod] }>
let lists: CapsuleResultMap['capsule.interaction.ls'][]
const context = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'partial-recovery-user' } }
const originalQuestion = 'Original recovery question?'
const healthyQuestion = 'Healthy recovery question?'

function track<T>(promise: Promise<T>): Promise<T> {
  flights.add(promise)
  void promise.then(() => flights.delete(promise), () => flights.delete(promise))
  return promise
}
async function settle() { while (flights.size) await act(async () => { await Promise.allSettled([...flights]) }) }
function editor(question = originalQuestion) {
  const found = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].find(node => node.getAttribute('aria-label') === 'Answer to ' + question)
  expect(found, 'The original question has a connected editor').toBeDefined(); return found!
}
function button(text: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(found, 'Connected action: ' + text).toBeDefined(); return found!
}
async function click(text: string, scope: ParentNode = container) { await act(async () => button(text, scope).click()); await settle() }
async function change(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor(), value)
    editor().dispatchEvent(new Event('input', { bubbles: true })); editor().dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function mount() {
  await act(async () => root.render(<CapsuleInteractionChrome capsuleId={capsuleId} active toolbarHost={toolbar} />)); await settle()
  await act(async () => toolbar.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!.click()); await settle()
}
const interactionPath = () => join(directory, 'state', 'interactions', capsuleId, original.interactionId + '.json')

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  directory = await mkdtemp(join(tmpdir(), 'capsule-partial-recovery-'))
  const sourcePath = join(directory, 'source'); await mkdir(sourcePath); await writeFile(join(sourcePath, 'index.html'), '<title>Recovery fixture</title>')
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'state'), replies: {
    prepare: async ({ interaction, answer, inputOperationId, operationId }, callContext) => ({ version: 1, operationId,
      capsuleId: interaction.capsuleId, interactionId: interaction.interactionId, inputOperationId,
      target: interaction.target!, expectedRun: { runId: 'unexecuted-recovery-run' }, principal: callContext.principal!, prompt: answer }),
    submit: async prepared => ({ status: 'submitted', inputStatus: 'admitted', inputOperationId: prepared.inputOperationId, expectedRun: prepared.expectedRun }),
    inspect: async prepared => ({ status: 'submitted', inputStatus: 'admitted', inputOperationId: prepared.inputOperationId, expectedRun: prepared.expectedRun })
  } })
  capsuleId = (await owner.call('capsule.create', { operationId: 'recovery-page', sourcePath,
    mode: 'injected', target: { hostId: 'local', agentSessionId: 'unexecuted-recovery-target' } })).record.capsuleId
  original = (await owner.call('capsule.interaction.request', { capsuleId, operationId: 'original-question', question: originalQuestion, draft: 'Saved original draft' })).interaction
  healthy = (await owner.call('capsule.interaction.request', { capsuleId, operationId: 'healthy-question', question: healthyQuestion, draft: 'Saved healthy draft' })).interaction
  service = new AgentMuxRpcService({ coreClients: () => [], capsules: owner })
  transport = ((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => service.call(method, params, context)) as CapsulePort['call']
  flights = new Set(); calls = []; lists = []
  vi.mocked(api.capsules.call).mockImplementation(((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    calls.push({ method, params: structuredClone(params) })
    return track(transport(method, params).then(result => {
      if (method === 'capsule.interaction.ls') lists.push(result as CapsuleResultMap['capsule.interaction.ls'])
      return result
    }))
  }) as CapsulePort['call'])
  // The uncertain confirmation port is controlled. No Native input is performed.
  vi.mocked(api.capsuleReplies.confirm).mockImplementation(() => track(Promise.reject(new Error('Original confirmation outcome unknown'))))
  container = document.createElement('div'); toolbar = document.createElement('div'); document.body.append(container, toolbar); root = createClientUiRoot(container)
  // Hold only the 750ms form autosave window; owner I/O and ReactDOM still execute.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(async () => {
  await act(async () => root.unmount()); await settle(); vi.useRealTimers()
  container.remove(); toolbar.remove(); service.dispose(); await owner.close(); await rm(directory, { recursive: true, force: true })
  vi.clearAllMocks(); vi.unstubAllGlobals()
})

it('keeps the original mounted form and unsaved answer through a real partial owner read while healthy questions update', async () => {
  await mount(); const before = editor(), saved = await readFile(interactionPath(), 'utf8')
  await change('Unsaved original answer')
  await owner.call('capsule.interaction.draft', { capsuleId, interactionId: healthy.interactionId, expectedRevision: healthy.revision,
    operationId: 'healthy-draft-update', draft: 'New confirmed healthy draft' })
  await writeFile(interactionPath(), '{unreadable original interaction')
  await click('Refresh')
  expect(lists.at(-1)!.issues.length).toBeGreaterThan(0)
  expect(lists.at(-1)!.interactions.map(item => item.interactionId)).toEqual([healthy.interactionId])
  expect(before.isConnected, 'Partial interaction reads must preserve the original mounted reply form').toBe(true)
  expect(editor()).toBe(before); expect(editor().value).toBe('Unsaved original answer')
  expect(editor(healthyQuestion).value).toBe('New confirmed healthy draft')
  expect(container.textContent).toContain('One original interaction cannot be read')
  expect(container.textContent).not.toContain('No saved questions.')
  await writeFile(interactionPath(), saved); await click('Refresh')
  expect(editor()).toBe(before); expect(editor().value).toBe('Unsaved original answer')
  expect(container.textContent).not.toContain('One original interaction cannot be read')
  expect(calls.filter(call => call.method === 'capsule.interaction.draft')).toHaveLength(0)
})

it('retains the original unknown confirmation identity and inspect-only form through partial reads and recovery', async () => {
  await mount(); const before = editor(), scope = before.closest('article')!
  await click('Confirm answer', scope)
  const held = vi.mocked(api.capsuleReplies.confirm).mock.calls[0]![0]
  expect(before.readOnly).toBe(true); expect(scope.textContent).toContain(held.operationId)
  const saved = await readFile(interactionPath(), 'utf8')
  await writeFile(interactionPath(), '{unreadable original interaction'); await click('Refresh')
  expect(before.isConnected, 'Partial interaction reads must retain the original unknown operation form').toBe(true)
  expect(editor()).toBe(before); expect(scope.textContent).toContain(held.operationId)
  expect(button('Confirm answer', scope).disabled).toBe(true)
  await writeFile(interactionPath(), saved); await click('Refresh'); await click('Inspect original operation', scope)
  expect(editor()).toBe(before); expect(before.readOnly).toBe(true)
  expect(calls.filter(call => call.method === 'capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: held.operationId })
  expect(button('Confirm answer', scope).disabled).toBe(true)
  await click('Confirm answer', scope); expect(api.capsuleReplies.confirm).toHaveBeenCalledOnce()
  expect(scope.textContent).toContain(held.operationId)
})

it('keeps a higher confirmed revision when a later complete list contains an older snapshot', async () => {
  await mount(); const before = editor(), older = structuredClone(lists.at(-1)!)
  await owner.call('capsule.interaction.draft', { capsuleId, interactionId: original.interactionId, expectedRevision: original.revision,
    operationId: 'newer-original-draft', draft: 'Newer confirmed original draft' })
  await owner.call('capsule.interaction.reply', { capsuleId, interactionId: healthy.interactionId, expectedRevision: healthy.revision,
    operationId: 'confirmed-healthy-answer', answer: 'Confirmed healthy answer' }, { principal: context.principal })
  await click('Refresh'); expect(editor().value).toBe('Newer confirmed original draft')
  const real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => method === 'capsule.interaction.ls' ? older : real(method, params)) as CapsulePort['call']
  await click('Refresh')
  expect(editor()).toBe(before)
  expect(toolbar.querySelector('button')!.title, 'A lower list revision must not replace the confirmed projection').toContain('1 pending questions')
  expect(button('Save draft', before.closest('article')!).disabled, 'A lower list revision must not replace the confirmed projection').toBe(true)
  await change('Next explicit draft'); await click('Save draft', before.closest('article')!)
  const saved = calls.find(call => call.method === 'capsule.interaction.draft')!.params as CapsuleParamsMap['capsule.interaction.draft']
  expect(saved.expectedRevision, 'The next write must retain the higher confirmed revision').toBe(original.revision + 1)
  expect((await owner.call('capsule.interaction.inspect', { capsuleId, interactionId: original.interactionId })).interaction.draft).toBe('Next explicit draft')
})

it('limits retained interaction identities to the exact Capsule after a prop change', async () => {
  await mount(); await change('Original Capsule unsaved answer')
  const before = editor()
  const next = await owner.call('capsule.create', { operationId: 'next-page', sourcePath: join(directory, 'source'),
    mode: 'injected', target: { hostId: 'local', agentSessionId: 'different-unexecuted-target' } })
  const nextQuestion = (await owner.call('capsule.interaction.request', { capsuleId: next.record.capsuleId,
    operationId: 'next-page-question', question: 'Next Capsule question?', draft: 'Next Capsule draft' })).interaction
  await act(async () => root.render(<CapsuleInteractionChrome capsuleId={next.record.capsuleId} active toolbarHost={toolbar} />)); await settle()
  expect(before.isConnected, 'A different Capsule must not inherit the original Capsule form or recipient').toBe(false)
  expect(container.textContent).not.toContain(originalQuestion)
  expect(container.textContent).not.toContain('unexecuted-recovery-target')
  expect(editor('Next Capsule question?').value).toBe('Next Capsule draft')
  expect(container.textContent).toContain(nextQuestion.target!.agentSessionId)
  expect(api.capsuleReplies.confirm).not.toHaveBeenCalled()
})

it('keeps already known questions when a later list has no authoritative deletion fact', async () => {
  await mount(); const before = editor(), real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => method === 'capsule.interaction.ls' ? { interactions: [], issues: [] } : real(method, params)) as CapsulePort['call']
  await click('Refresh')
  expect(editor()).toBe(before); expect(before.isConnected).toBe(true)
  expect(container.textContent).not.toContain('No saved questions.')
})

it('shows the genuine initial empty state from the owner and accepts a later original request', async () => {
  capsuleId = (await owner.call('capsule.create', { operationId: 'empty-page', sourcePath: join(directory, 'source') })).record.capsuleId
  await mount()
  expect(lists.at(-1)).toEqual({ interactions: [], issues: [] })
  expect(container.querySelectorAll('textarea')).toHaveLength(0)
  expect(container.textContent).toContain('No saved questions.')
  await owner.call('capsule.interaction.request', { capsuleId, operationId: 'later-original-question', question: originalQuestion, draft: 'First saved draft' })
  await click('Refresh'); expect(editor().value).toBe('First saved draft')
  expect(container.textContent).not.toContain('No saved questions.')
})
