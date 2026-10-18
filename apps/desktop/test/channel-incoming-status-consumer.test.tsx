// @vitest-environment node
import { act } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
const browser = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const window = new Window({ url: 'http://incoming-status.test/' })
  for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Event', 'CustomEvent', 'MouseEvent',
    'KeyboardEvent', 'FocusEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']) vi.stubGlobal(name, name === 'window' ? window : (window as unknown as Record<string, unknown>)[name])
  return window
})
import '../../mobile/test/device-locks'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { groupConversationFixture as fixture, cleanup } from '../../../packages/connectors/test/helpers/group-conversation-fixture.js'
import { composerDOM } from './helpers/composer-dom-fixture'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'

const sceneDirectory = process.env.T13_SCENE_DIRECTORY
const scene = async (name: string, f: Awaited<ReturnType<typeof fixture>>) => {
  if (!sceneDirectory) return
  await mkdir(sceneDirectory, { recursive: true })
  await writeFile(join(sceneDirectory, name + '-scene.json'), JSON.stringify(await f.hosted.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' }), null, 2))
}
const dom = composerDOM()
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 2)); await browser.close(); vi.unstubAllGlobals() })
const mount = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await dom.render(<MobileConversationSurface client={f.hosted} agentSessionId="original-agent" connection={{ state: 'connected', message: 'Original Hosted owner' }} platform={createBrowserPlatform()} onShowTerminal={() => {}} />)
}
const ready = async (text: string) => vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain(text) }, { timeout: 8000 })
const grant = async (f: Awaited<ReturnType<typeof fixture>>) => f.rpc.call('connection.grant', { operationId: 'grant-input', bindingId: f.binding.bindingId, expectedBindingRevision: 1,
  grantId: 'input-member', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
const summary = () => dom.container.querySelector('.conversation-submission-summary')!

it('real group recording and exact no-grant refusal reach the mounted Hosted card without claiming input or replaying after a grant', async () => {
  const f = await fixture(), received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.externalInput).toMatchObject({ ingressId: received.ingressId, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  const original = (await f.captured())[0]!
  const diagnosis = await f.rpc.call('connection.diagnose', { executionHostId: 'local', agentSessionId: 'original-agent', bindingId: f.binding.bindingId })
  expect(diagnosis.groups.value!.items[0]!.binding.value!.activeInputGrants).toBe(0)
  expect(diagnosis.groups.value!.items[0]!.incoming.value!.rows).toContainEqual(expect.objectContaining({ ingressId: received.ingressId, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED', recording: { state: 'recorded' }, inputOperationId: null, coreStatus: null }))
  await mount(f); await ready('对话已收录 · 未提交 Agent：成员未获输入权限')
  expect(summary().textContent).not.toContain('提交已记录')
  await scene('refused', f)
  expect(original.item.inputRef).toBeUndefined(); expect(original.item.inputSubmission).toBeUndefined(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await act(async () => summary().closest('summary')!.click())
  expect(dom.container.textContent).toContain('AgentMux 记录'); expect(dom.container.textContent).not.toContain('AgentMux 提交记录')
  const info = [...dom.container.querySelectorAll<HTMLButtonElement>('[aria-label="Message details"]')].find(button => button.closest('[data-submission-id]'))
  if (!info) throw Error('The original captured card has no discoverable details')
  await act(async () => info.click()); await ready('Member access')
  expect(dom.container.textContent).toContain('查看或修改权限不会重发这条旧消息')
  await grant(f); await f.services.ingress!.dispatch(received.ingressId); await f.reopen(); await f.services.ingress!.dispatch(received.ingressId)
  expect((await f.captured()).map(x => x.item.id)).toEqual([original.item.id]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.captured())[0]!.item.externalInput?.state).toBe('refused')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it('real external waiting stop and byte acknowledgement update one mounted original card without treating bytes as native acceptance', async () => {
  const f = await fixture(); await grant(f); await mount(f)
  const submit = vi.spyOn(f.client, 'submitAgentMessage')
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
  const submissionError = await Promise.resolve(submit.mock.results[0]!.value).then(() => null, error => ({ code: error.code, message: error.message, stack: error.stack }))
  expect(submissionError, JSON.stringify(submissionError)).toBeNull()
  let receipt: Awaited<ReturnType<typeof f.hosted.inspectAgentInput>>
  await vi.waitFor(async () => { receipt = (await f.services.ingress!.inspect({ ingressId: received.ingressId })).inputReceipt; expect(receipt?.status, JSON.stringify((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress)).toBe('waiting') })
  await ready('已保存 · 等待 Agent')
  await scene('waiting', f)
  const id = (await f.captured())[0]!.item.id, born = (await f.captured())[0]!.item.createdAt
  expect((await f.captured())[0]!.item.inputRef).toEqual(receipt!.key)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.hosted.stopAgentInputWaiting({ ref: receipt!.ref, cancelOperationId: 'stop-original-wait' }); await ready('已保存 · 已停止送达')
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  await f.hosted.rejoinAgentInputWaiting({ ref: receipt!.ref })
  await ready('已送入终端 · Agent 接收未确认')
  await scene('terminal', f)
  expect(summary().textContent).not.toContain('Agent 已接收')
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const records = await f.captured(); expect(records).toHaveLength(1); expect(records[0]!.item).toMatchObject({ id, createdAt: born, inputSubmission: { status: 'terminal-confirmed' }, authorExternal: { actor: f.actor } })
  expect(records[0]!.item.authorHuman).not.toBe(true)
  await f.reopen(); await f.services.ingress!.dispatch(received.ingressId)
  expect((await f.captured())[0]!.item).toMatchObject({ id, inputSubmission: { status: 'terminal-confirmed' } }); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(dom.container.querySelectorAll('[data-submission-id]')).toHaveLength(1)
}, 30_000)

it.each([['admitted', 'Agent 已接收'], ['unknown', '已保存 · 送达 Agent 未确认'], ['not-applied', '未送达 Agent']] as const)('original native %s receipt traverses Hosted strict decoding into the same external card', async (outcome, caption) => {
  const f = await fixture(true, false, outcome); await grant(f); await mount(f)
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => { const inspected = await f.services.ingress!.inspect({ ingressId: received.ingressId }); expect(inspected.inputReceipt?.status, JSON.stringify(inspected)).toBe(outcome) }, { timeout: 8000 })
  await ready(caption)
  await scene(outcome, f)
  expect(f.nativeSend).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const [original] = await f.captured(); expect(await f.captured()).toHaveLength(1)
  expect(original!.item.inputSubmission?.status).toBe(outcome); expect(original!.item.inputRef?.kind).toBe('message')
  await f.services.ingress!.dispatch(received.ingressId); await f.reopen(); await f.services.ingress!.dispatch(received.ingressId)
  expect(f.nativeSend).toHaveBeenCalledOnce(); expect((await f.captured())[0]!.item.id).toBe(original!.item.id)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)


it('an original record without ingress or input observation remains conversation-only rather than guessing a refusal', async () => {
  const f = await fixture(), authority = f.services.ingress!.recordAuthority.bind(f.services.ingress!)
  vi.spyOn(f.services.ingress!, 'recordAuthority').mockImplementation(async input => {
    const result = await authority(input)
    if (!result.message) return result
    const { inputMetadata: _unobserved, ...message } = result.message
    return { ...result, message }
  })
  await f.receive({ addressing: 'response' })
  await mount(f); await ready('对话已收录')
  expect(summary().textContent).not.toContain('未提交 Agent'); expect(summary().textContent).not.toContain('提交已记录')
  await scene('record-only', f)
  expect((await f.captured())[0]!.item.externalInput).toBeUndefined()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it('an active revised grant cannot wake the original external waiting generation or fabricate a refusal on its recorded card', async () => {
  const f = await fixture(); await grant(f)
  const errors: string[] = [], unsubscribe = f.client.onEvent(event => { if (event.type === 'agent-error') errors.push(event.code) }); cleanup.push(unsubscribe)
  const apply = f.store.applyTimelineMutation.bind(f.store)
  const failedProjection = vi.spyOn(f.store, 'applyTimelineMutation').mockImplementation(async (mutation, signal) => {
    if (mutation.type === 'upsert' && mutation.item.inputRef?.kind === 'message') throw Error('Original captured input IO unavailable')
    return await apply(mutation, signal)
  })
  const received = await f.receive({ addressing: 'response' })
  let receipt: Awaited<ReturnType<typeof f.hosted.inspectAgentInput>>
  await vi.waitFor(async () => { receipt = (await f.services.ingress!.inspect({ ingressId: received.ingressId })).inputReceipt; expect(receipt?.status).toBe('waiting') })
  await vi.waitFor(() => expect(errors).toContain('AGENT_INPUT_CONVERSATION_UNCONFIRMED'), { timeout: 8000 })
  await f.hosted.stopAgentInputWaiting({ ref: receipt!.ref, cancelOperationId: 'stop-unprojected-original' })
  failedProjection.mockRestore()
  await f.rpc.call('connection.grant', { operationId: 'revise-original-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1,
    grantId: 'input-member', expectedRevision: 1, actor: f.actor, capabilities: ['input', 'answer'], state: 'active' })
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  await expect(f.hosted.rejoinAgentInputWaiting({ ref: receipt!.ref })).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  expect((await f.hosted.inspectAgentInput({ key: receipt!.key }))?.status).toBe('stopped')
  const read = await f.hosted.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' })
  expect(read.items.some(x => x.kind === 'item' && x.item.records.some(r => r.original.kind === 'captured' && r.original.item.inputRef?.kind === 'message')), JSON.stringify(read)).toBe(true)
  await mount(f); await ready('已保存 · 已停止送达')
  expect(summary().textContent).not.toContain('成员未获输入权限')
  expect((await f.captured())[0]!.item.inputRef).toEqual(receipt!.key)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)


it('concurrent original ingress refresh cannot replace the saved external input membership with a stale record-only snapshot', async () => {
  const f = await fixture(); await grant(f)
  let originalClaimed!: () => void, releaseSubmit!: () => void
  const claimed = new Promise<void>(resolve => { originalClaimed = resolve }), submitReady = new Promise<void>(resolve => { releaseSubmit = resolve })
  const submit = f.client.submitAgentMessage.bind(f.client)
  vi.spyOn(f.client, 'submitAgentMessage').mockImplementation(async (...args) => { originalClaimed(); await submitReady; return await submit(...args) })
  const received = await f.receive({ addressing: 'response' }); await claimed
  let refreshStarted!: () => void, releaseRefresh!: () => void
  const refreshing = new Promise<void>(resolve => { refreshStarted = resolve }), refreshReady = new Promise<void>(resolve => { releaseRefresh = resolve })
  const read = f.store.readCapturedHistory.bind(f.store)
  let delayOriginalSnapshot = true
  vi.spyOn(f.store, 'readCapturedHistory').mockImplementation(async (...args) => {
    const page = await read(...args)
    if (delayOriginalSnapshot && args[1]?.recordId && page.records[0] && !page.records[0].item.inputRef) {
      delayOriginalSnapshot = false; refreshStarted(); await refreshReady
    }
    return page
  })
  const refresh = f.hosted.recordExternalConversationMessage({ agentSessionId: 'original-agent', ingressId: received.ingressId })
  await refreshing; releaseSubmit()
  const dispatch = f.services.ingress!.dispatch(received.ingressId)
  let boundedRelease: ReturnType<typeof setTimeout> | undefined
  try {
    await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).inputReceipt?.status).toBe('waiting'))
    // Let the original dispatch finish if it can; a serialized projection must
    // instead wait for this delayed original record write. No new input is run.
    await Promise.race([dispatch, new Promise<void>(resolve => { boundedRelease = setTimeout(resolve, 1000) })])
  } finally { if (boundedRelease) clearTimeout(boundedRelease); releaseRefresh() }
  await Promise.all([refresh, dispatch])
  const original = (await f.captured())[0]!
  expect(await f.captured()).toHaveLength(1)
  expect(original.item).toMatchObject({ status: 'recorded', inputRef: { kind: 'message' }, inputOrigin: { sequence: expect.any(Number) }, inputSubmission: { status: 'waiting' }, externalInput: { state: 'claimed' } })
  await mount(f); await ready('已保存 · 等待 Agent')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)
