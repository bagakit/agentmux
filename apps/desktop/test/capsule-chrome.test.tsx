// @vitest-environment happy-dom
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CapsuleInputObservation, CapsuleInteraction, CapsuleMethod, CapsuleParamsMap, CapsulePort, CapsulePreparedReply, CapsuleReplyResult, CapsuleResultMap } from '@agentmux/core/capsule'

const fault = vi.hoisted(() => ({ dispatchSave: false }))
vi.mock('../../../packages/capsule/src/storage', async original => {
  const actual = await original<typeof import('../../../packages/capsule/src/storage')>()
  return { ...actual, writeJson: async (path: string, value: any) => {
    if (fault.dispatchSave && path.includes('/interactions/') && value.interaction?.reply?.phase === 'dispatch-started') {
      fault.dispatchSave = false
      throw new Error('The pre-dispatch persistence boundary was interrupted')
    }
    return actual.writeJson(path, value)
  } }
})

import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { api } from '../src/renderer/src/lib/api'
import { CapsuleInteractionChrome } from '../src/renderer/src/components/CapsuleInteractionChrome'
import { createClientUiRoot } from './helpers/client-ui-render'

let directory: string, owner: NodeCapsuleOwner, service: AgentMuxRpcService, capsuleId: string, interaction: CapsuleInteraction
let container: HTMLDivElement, toolbarHost: HTMLDivElement, root: Root, calls: Array<{ method: CapsuleMethod; params: CapsuleParamsMap[CapsuleMethod] }>
let nativeConfirm: ReturnType<typeof vi.fn<(params: CapsuleParamsMap['capsule.interaction.reply']) => Promise<CapsuleReplyResult>>>
let transport: CapsulePort['call'], inFlight: Set<Promise<unknown>>, submissions: CapsulePreparedReply[]
let inputStatus: CapsuleInputObservation['status']
let coreInputStatus: CapsuleInputObservation['inputStatus']
const principal = { kind: 'user' as const, id: 'original-local-user' }
const caller = { transport: 'unix' as const, principal }
const question = 'Review <section> & confirm the original build?'

function track<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise); void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise)); return promise
}
const observation = (prepared: CapsulePreparedReply): CapsuleInputObservation => ({ status: inputStatus,
  inputOperationId: prepared.inputOperationId, expectedRun: prepared.expectedRun,
  ...(inputStatus === 'submitted' ? { ...(coreInputStatus ? { inputStatus: coreInputStatus } : {}) } : { reason: 'Original input observation is unavailable.' }) })

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  directory = await mkdtemp(join(tmpdir(), 'capsule-chrome-'))
  const sourcePath = join(directory, 'page'); await mkdir(sourcePath); await writeFile(join(sourcePath, 'index.html'), '<title>Original review</title>')
  submissions = []; inputStatus = 'submitted'; coreInputStatus = 'admitted'; fault.dispatchSave = false
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'state'), replies: {
    prepare: async ({ interaction: original, answer, inputOperationId, operationId }, context) => ({
      version: 1, operationId, capsuleId: original.capsuleId, interactionId: original.interactionId, inputOperationId,
      target: original.target!, expectedRun: { runId: 'original-run' }, principal: context.principal!, prompt: answer
    }),
    submit: async prepared => { submissions.push(structuredClone(prepared)); return observation(prepared) },
    inspect: async prepared => observation(prepared)
  } })
  const page = await owner.call('capsule.create', { operationId: 'create-original-review', sourcePath, title: 'Original review',
    mode: 'injected', target: { hostId: 'local', agentSessionId: 'original-recipient-session' } })
  capsuleId = page.record.capsuleId
  interaction = (await owner.call('capsule.interaction.request', { capsuleId, operationId: 'original-question', question })).interaction
  service = new AgentMuxRpcService({ coreClients: () => [], capsules: owner }); calls = []; inFlight = new Set()
  transport = (<M extends CapsuleMethod>(method: M, params: CapsuleParamsMap[M]) => service.call(method, params, caller)) as CapsulePort['call']
  vi.spyOn(api.capsules, 'call').mockImplementation(((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    calls.push({ method, params: structuredClone(params) }); return track(transport(method, params))
  }) as CapsulePort['call'])
  nativeConfirm = vi.fn(params => owner.call('capsule.interaction.reply', params, { principal }))
  vi.spyOn(api.capsuleReplies, 'confirm').mockImplementation(params => track(nativeConfirm(params)))
  container = document.createElement('div'); document.body.append(container); toolbarHost = document.createElement('div'); toolbarHost.className = 'browser-toolbar'; document.body.append(toolbarHost); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); toolbarHost.remove(); service.dispose(); await owner.close()
  await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks()
})

async function settle() { while (inFlight.size) await act(async () => { await Promise.allSettled([...inFlight]) }) }
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === text)
  expect(found, `Connected action: ${text}`).toBeDefined(); return found!
}
async function click(text: string, wait = true) { await act(async () => button(text).click()); if (wait) await settle() }
function editor(): HTMLTextAreaElement { const value = container.querySelector<HTMLTextAreaElement>('textarea'); expect(value).not.toBeNull(); return value! }
async function change(value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor(), value)
    editor().dispatchEvent(new Event('input', { bubbles: true })); editor().dispatchEvent(new Event('change', { bubbles: true })) })
}
async function mount(active = true) {
  await act(async () => root.render(<CapsuleInteractionChrome capsuleId={capsuleId} active={active} toolbarHost={toolbarHost} />)); await settle()
  const trigger = toolbarHost.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')
  expect(trigger, 'Questions belongs to the original Browser toolbar').not.toBeNull()
  expect(container.querySelector<HTMLElement>('.capsule-chrome')!.hidden).toBe(true)
  await act(async () => trigger!.click()); await settle()
}
const mutations = (method: CapsuleMethod) => calls.filter(call => call.method === method)

it('reads original requests through public RPC, retains draft bytes, and confirms only through the trusted App boundary', async () => {
  await mount(false)
  expect(toolbarHost.textContent).toContain('Original review'); expect(container.textContent).toContain(question)
  expect(container.textContent).toContain('Browsing another site'); expect(container.textContent).toContain('original-recipient-session')
  const recipient = container.querySelector<HTMLDetailsElement>('.capsule-question__recipient')!
  expect(recipient.open).toBe(false); expect(recipient.querySelector('dd')?.textContent).toBe('local')
  expect(container.querySelector('section section')).toBeNull()
  expect(mutations('capsule.interaction.ls').length).toBeGreaterThan(0)
  await change('Use the original build.'); await click('Save draft')
  expect((await owner.call('capsule.interaction.inspect', { capsuleId, interactionId: interaction.interactionId })).interaction.draft).toBe('Use the original build.')
  expect(mutations('capsule.interaction.draft')).toHaveLength(1)
  await click('Confirm answer')
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(mutations('capsule.interaction.reply')).toHaveLength(0)
  expect(submissions).toHaveLength(1); expect(submissions[0]).toMatchObject({ capsuleId, interactionId: interaction.interactionId,
    target: { hostId: 'local', agentSessionId: 'original-recipient-session' }, expectedRun: { runId: 'original-run' }, prompt: 'Use the original build.', principal })
  expect(container.textContent).toContain('input admitted by Provider'); expect(editor().readOnly).toBe(true)
})

it('preserves uncertain confirmation identity across inspection and reopening without submitting again', async () => {
  inputStatus = 'unknown'; await mount(); await change('Original uncertain answer'); await click('Confirm answer')
  expect(container.querySelector<HTMLDetailsElement>('.capsule-question__history')!.open).toBe(true)
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(1)
  const original = structuredClone(nativeConfirm.mock.calls[0]![0])
  expect(container.textContent).toContain(original.operationId); expect(container.textContent).toContain('input unconfirmed')
  expect(container.textContent).not.toContain('Continue saved confirmation')
  await click('Inspect original operation')
  expect(mutations('capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: original.operationId })
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(1)
  await act(async () => root.unmount()); root = createClientUiRoot(container); await mount()
  expect(editor().value).toBe('Original uncertain answer'); expect(container.textContent).toContain(original.operationId)
  inputStatus = 'submitted'; await click('Inspect original operation')
  expect(container.textContent).toContain('input admitted by Provider'); expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(1)
})

it('continues only a durably prepared confirmation with its saved operation, answer, revision and input identity', async () => {
  fault.dispatchSave = true; await mount(); await change('Saved exact answer'); await click('Confirm answer')
  const original = structuredClone(nativeConfirm.mock.calls[0]![0])
  expect(submissions).toHaveLength(0)
  const saved = JSON.parse(await readFile(join(directory, 'state', 'interactions', capsuleId, interaction.interactionId + '.json'), 'utf8'))
  expect(saved.interaction.reply.phase).toBe('prepared')
  await act(async () => root.unmount()); root = createClientUiRoot(container); await mount()
  expect(container.textContent).toContain('Continue saved confirmation'); expect(submissions).toHaveLength(0)
  await click('Continue saved confirmation')
  expect(nativeConfirm).toHaveBeenCalledTimes(2); expect(nativeConfirm.mock.calls[1]![0]).toEqual(original)
  expect(submissions).toHaveLength(1); expect(submissions[0]!.inputOperationId).toBe(saved.preparedReply.inputOperationId)
  expect(container.textContent).toContain('input admitted by Provider')
})

it('keeps unknown draft saves locked to their original operation while preserving later editable text', async () => {
  await mount(); const real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    if (method === 'capsule.interaction.draft') { await real(method, params); throw new Error('Transport reply was lost') }
    return real(method, params)
  }) as CapsulePort['call']
  await change('Saved first draft'); await click('Save draft'); await change('Later local text')
  expect(button('Confirm answer').disabled).toBe(true); expect(button('Save draft').disabled).toBe(true)
  await click('Inspect original operation')
  expect(mutations('capsule.interaction.draft')).toHaveLength(1); expect(editor().value).toBe('Later local text')
  expect(button('Save draft').disabled).toBe(false); expect(nativeConfirm).not.toHaveBeenCalled()
})

it('rejects invalid draft and answer parameters before occupying an unknown operation', async () => {
  await mount(); await change('Invalid\0draft'); await click('Save draft')
  expect(mutations('capsule.interaction.draft')).toHaveLength(0); expect(container.textContent).not.toContain('Inspect original operation')
  await click('Confirm answer'); expect(nativeConfirm).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('Inspect original operation')
  await change('Corrected editable answer'); await click('Confirm answer')
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(1)
})

it('accepts an explicit not-applied receipt as a fresh human action while keeping unknown failures inspect-only', async () => {
  await mount(); await change('Original answer')
  nativeConfirm.mockRejectedValueOnce(Object.assign(new Error('Preflight unavailable'), { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }))
  await click('Confirm answer'); expect(button('Confirm answer').disabled).toBe(false); expect(submissions).toHaveLength(0)
  await click('Confirm answer'); expect(nativeConfirm).toHaveBeenCalledTimes(2); expect(submissions).toHaveLength(1)
  expect(nativeConfirm.mock.calls[0]![0].operationId).not.toBe(nativeConfirm.mock.calls[1]![0].operationId)
})

it('keeps an unobserved confirmation frozen and inspect-only without guessing that a missing operation was not applied', async () => {
  await mount(); await change('The frozen original answer')
  nativeConfirm.mockRejectedValueOnce(new Error('The original transport outcome is unknown'))
  await click('Confirm answer')
  const original = nativeConfirm.mock.calls[0]![0]
  expect(button('Confirm answer').disabled).toBe(true); expect(editor().readOnly).toBe(true)
  await click('Inspect original operation')
  expect(mutations('capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: original.operationId })
  expect(button('Confirm answer').disabled).toBe(true); expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(0)
  expect(editor().value).toBe(original.answer); expect(container.textContent).toContain('still unconfirmed')
})

it('retains current editor text across a late request refresh and keeps the native page in a separate bounded surface', async () => {
  await mount(); const real = transport
  let resolve!: (value: CapsuleResultMap['capsule.interaction.ls']) => void
  const late = new Promise<CapsuleResultMap['capsule.interaction.ls']>(yes => { resolve = yes })
  transport = ((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => method === 'capsule.interaction.ls' ? late : real(method, params)) as CapsulePort['call']
  await click('Refresh', false); await change('Keep my later text')
  await act(async () => resolve(await real('capsule.interaction.ls', { capsuleId }))); await settle()
  expect(editor().value).toBe('Keep my later text')
  const panel = container.querySelector<HTMLElement>('.capsule-chrome')!
  expect(panel.hidden).toBe(false); expect(panel.querySelector('webview, iframe')).toBeNull(); expect(container.querySelector('.capsule-chrome__bar')).toBeNull(); expect(toolbarHost.querySelector('[aria-label="Page questions"]')).not.toBeNull()
  await act(async () => toolbarHost.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!.click())
  expect(panel.hidden).toBe(true); expect(editor().value).toBe('Keep my later text')
})


it.each([
  ['waiting', 'input waiting in Core'],
  ['stopped', 'input stopped before dispatch'],
  ['not-applied', 'input not applied'],
  ['terminal-confirmed', 'terminal input confirmed'],
  ['admitted', 'input admitted by Provider']
] as const)('distinguishes Core input %s without certifying Agent completion', async (status, label) => {
  coreInputStatus = status
  await mount(); await change('The exact registered answer'); await click('Confirm answer')
  expect(container.textContent).toContain(label)
  expect(container.textContent).not.toContain('input submitted')
  expect(button('Inspect original operation').disabled).toBe(false)
  expect(container.textContent).not.toContain('Continue saved confirmation')
  expect([...container.querySelectorAll('button')].some(node => node.textContent === 'Confirm answer')).toBe(false)
  const original = nativeConfirm.mock.calls[0]![0]
  await click('Inspect original operation')
  expect(mutations('capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: original.operationId })
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(1)
})

it.each([
  ['terminal-confirmed', 'terminal input confirmed'],
  ['not-applied', 'input not applied']
] as const)('reopens a waiting answer and reads its original %s receipt without another confirmation', async (status, label) => {
  coreInputStatus = 'waiting'
  await mount(); await change('The exact waiting answer'); await click('Confirm answer')
  const original = structuredClone(nativeConfirm.mock.calls[0]![0]), input = structuredClone(submissions[0]!)
  await act(async () => root.unmount()); root = createClientUiRoot(container); await mount()
  expect(container.textContent).toContain('input waiting in Core')
  coreInputStatus = status; await click('Inspect original operation')
  expect(container.textContent).toContain(label)
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toEqual([input])
  expect(mutations('capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: original.operationId })
  expect(editor().value).toBe(original.answer)
})

it('does not invent a delivery stage when a registered input has no protocol status', async () => {
  coreInputStatus = undefined
  await mount(); await change('Original registered answer'); await click('Confirm answer')
  expect(container.textContent).toContain('input registered in Core')
  expect(container.textContent).not.toContain('input submitted')
  expect(container.textContent).not.toContain('input admitted')
  expect(button('Inspect original operation')).toBeDefined()
})

it('keeps waiting answers prominent and folds confirmed history without losing its original inspection path', async () => {
  coreInputStatus = 'waiting'
  await mount(); await change('Keep the original answer observable'); await click('Confirm answer')
  const original = structuredClone(nativeConfirm.mock.calls[0]![0])
  const history = container.querySelector<HTMLDetailsElement>('.capsule-question__history')!
  expect(history.open).toBe(true); expect(history.querySelector('summary')!.hidden).toBe(true)
  coreInputStatus = 'terminal-confirmed'; await click('Inspect original operation')
  expect(history.open).toBe(false)
  const summary = history.querySelector<HTMLElement>('summary')!
  expect(summary.hidden).toBe(false); expect(summary.textContent).toContain(question)
  expect(summary.textContent).toContain('terminal input confirmed')
  await act(async () => summary.click())
  expect(history.open).toBe(true)
  await click('Inspect original operation'); await click('Refresh')
  expect(history.open).toBe(true); expect(editor().value).toBe(original.answer)
  expect(mutations('capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: original.operationId })
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(1)
})

it('reopens saved terminal answers as compact history with a reachable original operation', async () => {
  await mount(); await change('Original settled history'); await click('Confirm answer')
  const operationId = nativeConfirm.mock.calls[0]![0].operationId
  await act(async () => root.unmount()); root = createClientUiRoot(container); await mount()
  const history = container.querySelector<HTMLDetailsElement>('.capsule-question__history')!
  expect(history.open).toBe(false)
  await act(async () => history.querySelector<HTMLElement>('summary')!.click())
  expect(history.open).toBe(true); expect(editor().value).toBe('Original settled history')
  await click('Inspect original operation')
  expect(history.open).toBe(true); expect(history.querySelector('summary')!.hidden).toBe(false)
  expect(container.textContent).toContain('input admitted by Provider')
  expect(mutations('capsule.operation.inspect').at(-1)!.params).toEqual({ operationId })
  expect(nativeConfirm).toHaveBeenCalledOnce(); expect(submissions).toHaveLength(1)
})
