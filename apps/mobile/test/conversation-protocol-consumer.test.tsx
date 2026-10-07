// @vitest-environment node
import './device-locks'
import { act } from 'react'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { AgentMuxInteractionRequest, AgentProviderSessionHistoryObservation, AgentSessionHistoryPage } from '@agentmux/core'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { AgentTerminalScreen } from '../../../packages/core/src/agent-terminal-screen'
import { connectedClient, permission, completeNativeRequest, AGENT_SESSION_ID as sid, RUN_ID } from '../../../packages/core/test/fixtures/interaction-client'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { getDeviceWorkface, emptyDeviceWorkface, DEVICE_WORKFACE_KEY } from '../src/recovery/device-workface'
import { button, click, editor, mount, mounted, paste } from './conversation-fixture'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'

// Preserve Node's real HTTP/streams/AbortSignal primitives while mounting the original UI.
const browser = new Window({ url: 'http://mobile.test/' })
for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'FocusEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  vi.stubGlobal(name, name === 'window' ? browser : (browser as unknown as Record<string, unknown>)[name])
}
afterAll(() => { browser.close(); vi.unstubAllGlobals() })

const closes: Array<() => Promise<void>> = []
const source = { providerId: 'codex', nativeSessionId: 'mobile-original-native' }
const question = { id: 'exact-async-record', turnId: 'exact-async-turn', kind: 'assistant-message' as const,
  contentParts: [{ kind: 'text' as const, text: 'Original asynchronous question' }],
  questionRequest: { delivery: 'async' as const, questions: [{ id: 'exact-async-question', prompt: 'Keep this original work?', options: [{ id: 'keep', label: 'Keep original' }], acceptsText: true }] } }
const page = (): AgentSessionHistoryPage => ({ agentSessionId: sid, source, items: [question], nextCursor: 'original-older-window' })
const saved = () => JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
async function unmount(element: HTMLElement) {
  const index = mounted.findIndex(view => view.element === element), view = mounted.splice(index, 1)[0]!
  await act(async () => view.root.unmount()); element.remove()
}

/** Actual authenticated HTTP/JSON-RPC, Hosted codec/service and original Core owners.
 * Provider history/input/target witnesses, screen reads and ctxmux transport are controlled leaves.
 * Receipt-loss cases drop the consumer callback after actual original Core acceptance.
 * This is neither vendor Native qualification nor a physical mobile-device assertion. */
async function authenticatedFixture(request?: AgentMuxInteractionRequest) {
  const root = await mkdtemp(join(tmpdir(), 'mobile-conversation-protocol-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const providerId = request ? 'claude' : 'codex', fixtureSource = { ...source, providerId }
  const h = await connectedClient(request, providerId, source.nativeSessionId)
  closes.push(() => h.client.dispose())
  vi.spyOn(h.client, 'connect').mockResolvedValue()
  h.state.kernel.list = async () => [await (h.state.kernel.status as (id: string) => Promise<unknown>)(RUN_ID)]
  h.state.kernel.observeOutput = async () => ({ run: await (h.state.kernel.status as (id: string) => Promise<unknown>)(RUN_ID),
    gap: null, terminal: { type: 'not-requested' }, resizeRevision: 0, replay: [], close: async () => {} })
  const screen = new AgentTerminalScreen(80, 24)
  closes.push(async () => screen.dispose())
  vi.spyOn((h.client as unknown as { screenEvidence: import('../../../packages/core/src/screen-evidence').AgentScreenEvidenceStore }).screenEvidence,
    'wait').mockImplementation(async (_session, _byte, _after, predicate) => { predicate(screen); return 1 })
  // No native terminal renderer runs in this fixture. The Provider leaf contributes
  // a single-phase plan; Core keeps all original input ordering and byte receipts.
  const provider = h.client.providers.get(providerId)
  provider.planPromptInput = prompt => ({ kind: 'single-phase', data: prompt + '\r' })
  vi.spyOn(provider, 'discoverNativeSession').mockResolvedValue({ handle: { kind: 'provider', providerId, sessionId: source.nativeSessionId }, assertCurrent: async () => {} })
  let recent = { ...page(), source: fixtureSource }, older = { ...recent, nextCursor: null }
  let observe: ((event: AgentProviderSessionHistoryObservation) => void) | undefined
  vi.spyOn(provider, 'readSessionHistoryPage').mockImplementation(async context => structuredClone(context.cursor ? older : recent))
  vi.spyOn(provider, 'observeSessionHistory').mockImplementation(async context => {
    observe = context.onChange
    return { source: context.source, dispose() { observe = undefined } }
  })
  // The controlled leaf contributes the exact original target; Core still binds source,
  // Session, Run, predecessor, original operation and authenticated device before input.
  const prepareQuestion = request ? vi.fn() : vi.spyOn(provider, 'prepareSessionQuestionReply').mockImplementation(async input => {
    expect(input).toMatchObject({ source, recordId: question.id, turnId: question.turnId })
    expect(input.answers.every(answer => answer.questionId === 'exact-async-question')).toBe(true)
    return JSON.stringify({ question_answers: input.answers })
  })
  const submit = vi.spyOn(h.client, 'submitAgentPrompt'), reply = vi.spyOn(h.client, 'replySessionQuestion')
  const respond = vi.spyOn(h.client, 'respondAgentInteraction'), inspect = vi.spyOn(h.client, 'inspectAgentInteractionOperation')
  const hosted = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client))
  closes.push(() => hosted.dispose())
  const authenticated: string[] = [], device = { hostId: 'local', deviceId: 'approved-mobile-device', name: 'Controlled Mobile' }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'),
    coreClients: () => [{ hostId: 'local', client: h.client }], hostedRuntime: () => hosted,
    operationSource: context => context.principal?.id === device.deviceId ? device : undefined,
    http: { host: '127.0.0.1', port: 0, authorize(request) {
      if (request.headers.get('authorization') !== 'Bearer private-mobile-token') return null
      authenticated.push(device.deviceId)
      return { principal: { kind: 'device', id: device.deviceId }, assertCurrent() {
        expect(request.headers.get('authorization')).toBe('Bearer private-mobile-token')
      } }
    } } })
  await server.start(); closes.push(() => server.stop())
  const url = `http://127.0.0.1:${server.httpAddress!.port}/`
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url, token: 'private-mobile-token' } })
  closes.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); closes.push(() => client.dispose())
  const surface = () => <MobileConversationSurface client={client} agentSessionId={sid} connection={{ state: 'connected', message: 'Authenticated original Host' }} platform={createBrowserPlatform()} />
  const recordProof = async (name: string, evidence: unknown) => {
    if (!process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE) return
    const target = join(process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE, name + '.json')
    await mkdir(process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE, { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n')
  }
  return { ...h, core: h.client, client, rpc, url, authenticated, device, submit, reply, respond, inspect, prepareQuestion, surface, recordProof,
    setRecent(value: AgentSessionHistoryPage) { recent = value }, setOlder(value: AgentSessionHistoryPage) { older = value },
    invalidate() { observe?.({ kind: 'invalidated', source }) } }
}

it('ordinary input and exact asynchronous answers reach original Core through authenticated Hosted, without a forwarding facade or wire authority', async () => {
  const f = await authenticatedFixture(), view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.textContent).toContain('Original asynchronous question'))
  expect(f.client.forwardRpc).toBeUndefined()
  await click(button(view.element, 'Keep original')); await click(button(view.element, 'Submit reply'))
  await vi.waitFor(() => expect(f.reply).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(saved().questions[0][1].phase, JSON.stringify(saved().questions)).toBe('submitted'))
  expect(f.reply.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, source, recordId: question.id, turnId: question.turnId,
    authorHuman: true, sourceDevice: f.device, answers: [{ questionId: 'exact-async-question', answer: 'Keep original' }] })
  expect((await f.core.sessionTimeline(sid)).items.find(item => item.kind === 'user_message' && item.content?.includes('question_answers')))
    .toMatchObject({ authorHuman: true, sourceDevice: f.device })
  await paste(view.element, 'Ordinary original mobile message')
  await act(async () => { editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true, keyCode: 229 })) })
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.writes.join(''), view.element.textContent!).toContain('Ordinary original mobile message'))
  await vi.waitFor(() => expect(saved().attempts[0][1].phase).toBe('confirmed'))
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ authorHuman: true, sourceDevice: f.device })
  const before = f.writes.length
  const { sourceDevice: _authenticatedDevice, signal: _originalReaderSignal, ...originalReply } = f.reply.mock.calls[0]![0]
  await expect(f.client.replySessionQuestion({ ...originalReply,
    operationId: 'forged-agent-author', authorAgentSessionId: 'unrelated-agent' } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.reply).toHaveBeenCalledOnce()
  await expect(f.client.submitAgentPrompt({ agentSessionId: sid, expectedRun: { runId: RUN_ID }, operationId: 'forged-device',
    prompt: 'forged authority', sourceDevice: { ...f.device, deviceId: 'forged' }, authorHuman: true,
    admissionIntent: { kind: 'manual-actor', expectedRun: { runId: RUN_ID } } })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('runtime.owner.identity', { principal: { kind: 'user', id: 'forged' } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const denied = await fetch(f.url, { method: 'POST', headers: { Authorization: 'Bearer refused' }, body: '{}' })
  expect(denied.status).toBe(401)
  expect(f.writes).toHaveLength(before); expect(f.authenticated.length).toBeGreaterThan(4)
  await f.recordProof('authenticated-mobile-consumer', { passed: true, transport: 'authenticated HTTP JSON-RPC → Hosted SDK/service → original Core → mounted Mobile',
    ordinaryOperation: f.submit.mock.calls[0]![0].operationId, questionOperation: f.reply.mock.calls[0]![0].operationId,
    exactNativeSource: source, authenticatedDevice: f.device, inputWrites: f.writes.length,
    controlledLeaves: ['Provider page, single-phase input plan and exact question/target witness', 'screen read', 'ctxmux process transport'], claims: ['no physical-device or vendor Native qualification'] })
}, 15000)

it.each(['question', 'permission'] as const)('retains an unknown original synchronous %s operation through remount and queries it after native completion without another input', async kind => {
  const request: AgentMuxInteractionRequest = kind === 'permission' ? permission('exact-sync-permission') : {
    kind: 'question', id: 'exact-sync-question', agentSessionId: sid, nativeToolCallId: 'sync-native-call',
    evidence: { source: 'native-hook', observedAt: _historyTailFixtureEpoch(0, 0, 1), hookReceiptId: 'sync-hook', run: { runId: RUN_ID } },
    questions: [{ id: 'sync-question', prompt: 'Choose this original request', options: [{ id: 'keep', label: 'Keep sync original' }] }] }
  const f = await authenticatedFixture(request), original = f.client.respondAgentInteraction
  f.client.respondAgentInteraction = async input => { await original(input); throw new Error('Controlled reply loss after original Core acceptance') }
  const view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.querySelector('[data-request-id]')).not.toBeNull())
  await click(button(view.element, kind === 'permission' ? 'Reject' : 'Keep sync original'))
  await vi.waitFor(() => {
    expect(saved().responses).toHaveLength(1)
    expect(saved().responses[0][1].phase).toBe('unknown')
  })
  expect(f.respond).toHaveBeenCalledOnce(); const frozen = saved().responses[0][1].original
  expect(frozen.input).toMatchObject({ expectedRequest: request, operationId: expect.any(String), expectedRun: { runId: RUN_ID } })
  const inlineStatus = view.element.querySelector('[data-original-response]')!
  expect(inlineStatus.closest('[data-request-id]')).not.toBeNull()
  expect(view.element.querySelectorAll('[data-original-response]')).toHaveLength(1)
  expect(view.element.textContent).not.toContain('Check original response')
  await paste(view.element, 'New unsent draft remains')
  await unmount(view.element)
  const restored = await mount(f.surface())
  await vi.waitFor(() => expect(restored.element.querySelector('[data-original-response]')).not.toBeNull())
  expect(restored.element.querySelectorAll('[data-original-response]')).toHaveLength(1)
  expect(restored.element.querySelector('[data-original-response]')!.closest('[data-request-id]')).not.toBeNull()
  expect(editor(restored.element).textContent).toContain('New unsent draft remains')
  expect(f.respond).toHaveBeenCalledOnce()
  if (kind === 'permission') await completeNativeRequest(f.core)
  else await (f.core as unknown as { acceptHookEvent(envelope: unknown, signal: AbortSignal): Promise<void> }).acceptHookEvent({
    receiptId: 'controlled-sync-completion', agentSessionId: sid, providerId: 'claude', runId: RUN_ID,
    payload: { session_id: source.nativeSessionId, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_call_id: request.nativeToolCallId }
  }, new AbortController().signal)
  await vi.waitFor(() => expect(restored.element.querySelector('[data-request-id]')).toBeNull())
  expect(restored.element.querySelectorAll('[data-original-response]')).toHaveLength(1)
  await click(button(restored.element, '查询原答复回执'))
  await vi.waitFor(() => expect(saved().responses[0][1].phase).toBe('confirmed'))
  await vi.waitFor(() => expect(restored.element.textContent).toContain('原请求已确认完成'))
  expect(f.inspect).toHaveBeenCalledWith({ agentSessionId: sid, operationId: frozen.input.operationId })
  expect(f.writes).toHaveLength(1); expect(f.respond).toHaveBeenCalledOnce()
  expect(saved().responses[0][1].original).toEqual(frozen)
  await f.recordProof('original-sync-' + kind, { passed: true, requestId: request.id, operationId: frozen.input.operationId,
    retainedAfterCompletion: true, originalWrites: f.writes.length, readonlyInspect: true, draftRetained: true,
    faultInjection: 'Consumer callback loss after actual authenticated original Core acceptance',
    qualification: 'Controlled Provider target and Runtime leaves; not vendor Native acceptance' })
}, 15000)

it('keeps original older-window text and selection while another entry records an exact same-source answer; foreign answers cannot bind it', async () => {
  const f = await authenticatedFixture(), view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.textContent).toContain('Original asynchronous question'))
  await click(button(view.element, '更早消息'))
  await vi.waitFor(() => expect(button(view.element, '回到最新')).toBeDefined())
  const row = view.element.querySelector<HTMLElement>('[data-native-record-id="exact-async-record"]')!
  const originalText = row.querySelector('.conversation-message__body') ?? row.querySelector('p')!
  const selection = window.getSelection()!, range = document.createRange(); range.selectNodeContents(originalText); selection.removeAllRanges(); selection.addRange(range)
  const beforeSelection = selection.toString(), beforeNode = originalText
  const answer = { id: 'other-entry-answer', kind: 'user-message' as const, contentParts: [{ kind: 'text' as const, text: 'Original answer from another entry' }],
    questionAnswers: [{ questionId: 'exact-async-question', answer: 'Keep original' }] }
  f.setRecent({ ...page(), source: { ...source, nativeSessionId: 'foreign-native' }, items: [answer] })
  await act(async () => f.invalidate())
  await vi.waitFor(() => expect(view.element.textContent).toContain('Native history source'))
  expect(view.element.querySelector('[data-question-state="answered"]')).toBeNull()
  f.setRecent({ ...page(), items: [answer] })
  await act(async () => f.invalidate())
  await vi.waitFor(() => expect(view.element.querySelector('[data-question-state="answered"]')).not.toBeNull())
  expect(view.element.querySelector('[data-native-record-id="exact-async-record"]')).toBe(row)
  expect(row.contains(beforeNode)).toBe(true); expect(selection.toString()).toBe(beforeSelection)
  expect(f.reply).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
}, 15000)
