// @vitest-environment node
import './device-locks'
import { act } from 'react'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { AgentMuxInteractionRequest, AgentMuxInteractionResponse, AgentProviderSessionHistoryObservation, AgentSessionHistoryPage } from '@agentmux/core'
import { loadAgentSessions } from '../../../packages/core/src/agent-session-store'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { AgentTerminalScreen } from '../../../packages/core/src/agent-terminal-screen'
import { connectedClient, permission, completeNativeRequest, AGENT_SESSION_ID as sid, RUN_ID } from '../../../packages/core/test/fixtures/interaction-client'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
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
async function authenticatedFixture(request?: AgentMuxInteractionRequest, retainedResponse?: AgentMuxInteractionResponse) {
  const root = await mkdtemp(join(tmpdir(), 'mobile-conversation-protocol-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const providerId = request ? 'claude' : 'codex', fixtureSource = { ...source, providerId }
  const h = await connectedClient(request, providerId, source.nativeSessionId)
  closes.push(() => h.client.dispose())
  const stored = (await loadAgentSessions(h.store))[0]!
  const retainedInput = request && retainedResponse ? { agentSessionId: sid, expectedRun: { runId: RUN_ID },
    operationId: 'retained-original-' + request.id, expectedRequest: stored.pendingInteraction!.request, response: retainedResponse } : undefined
  if (retainedInput) {
    // A historical Core response receipt is a controlled stored fact, not a new
    // native-hook reply channel or proof of vendor adoption. Current replies remain manual.
    const current = stored
    await h.store.compareAndSwapMetadata(current, { ...current, pendingInteraction: { ...current.pendingInteraction!,
      response: { value: retainedInput.response, responseDigest: createHash('sha256').update(JSON.stringify(retainedInput.response)).digest('base64url'),
        operationId: retainedInput.operationId, inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: true } },
      interactionOperations: { [retainedInput.operationId]: { operationId: retainedInput.operationId, agentSessionId: sid,
        run: retainedInput.expectedRun, expectedRequest: retainedInput.expectedRequest, response: retainedInput.response,
        delivery: 'bytes-accepted', nativeAdoption: 'unknown', inputByteRange: { startByte: 0, endByte: 1 } } } })
    await h.state.registry.load('local')
  }
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
  // The original Provider catalog owns async reply routing. A history record
  // does not supply a live editor target or an automatic input capability.
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
  const openTerminal = vi.fn()
  const surface = () => <MobileConversationSurface client={client} agentSessionId={sid} connection={{ state: 'connected', message: 'Authenticated original Host' }} platform={createBrowserPlatform()} onShowTerminal={openTerminal} />
  const recordProof = async (name: string, evidence: unknown) => {
    if (!process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE) return
    const target = join(process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE, name + '.json')
    await mkdir(process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE, { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n')
  }
  return { ...h, core: h.client, client, rpc, url, authenticated, device, submit, reply, respond, inspect, openTerminal, surface, recordProof, retainedInput,
    setRecent(value: AgentSessionHistoryPage) { recent = value }, setOlder(value: AgentSessionHistoryPage) { older = value },
    invalidate() { observe?.({ kind: 'invalidated', source }) } }
}

it('authenticated Hosted preserves ordinary input and the original terminal route without granting an automatic async reply', async () => {
  const f = await authenticatedFixture(), view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.textContent).toContain('Original asynchronous question'))
  expect(f.client.forwardRpc).toBeUndefined()
  await click(button(view.element, 'Keep original'))
  expect([...view.element.querySelectorAll('button')].some(item => item.textContent === 'Submit reply')).toBe(false)
  await click(button(view.element, 'Answer in original terminal'))
  expect(f.openTerminal).toHaveBeenCalledOnce(); expect(f.reply).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  const originalReply = { agentSessionId: sid, source, recordId: question.id, turnId: question.turnId,
    expectedRun: { runId: RUN_ID }, afterSubmissionId: null, operationId: 'unsupported-original-question',
    authorHuman: true as const, answers: [{ questionId: 'exact-async-question', answer: 'Keep original' }] }
  await expect(f.client.replySessionQuestion(originalReply)).rejects.toMatchObject({ code: 'AGENT_QUESTION_REPLY_UNSUPPORTED' })
  expect(f.reply).toHaveBeenCalledOnce(); expect(f.writes).toEqual([])
  expect((await f.core.sessionTimeline(sid)).items.some(item => item.kind === 'user_message')).toBe(false)
  await paste(view.element, 'Ordinary original mobile message')
  await act(async () => { editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true, keyCode: 229 })) })
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.writes.join(''), view.element.textContent!).toContain('Ordinary original mobile message'))
  await vi.waitFor(() => expect(saved().attempts[0][1].phase).toBe('confirmed'))
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ authorHuman: true, sourceDevice: f.device })
  const before = f.writes.length
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
    ordinaryOperation: f.submit.mock.calls[0]![0].operationId, refusedQuestionOperation: originalReply.operationId,
    exactNativeSource: source, authenticatedDevice: f.device, inputWrites: f.writes.length,
    controlledLeaves: ['Provider history, observation and original ordinary-input plan', 'screen read', 'ctxmux process transport'], claims: ['no physical-device or vendor Native qualification', 'async reply is unsupported; terminal navigation dispatches no input'] })
}, 15000)

it('an unaddressable synchronous question opens its original terminal without answering or saving an operation', async () => {
  const request: AgentMuxInteractionRequest = { kind: 'question', id: 'manual-original-request', agentSessionId: sid,
    nativeToolCallId: 'manual-native-question', evidence: { source: 'native-hook', observedAt: _historyTailFixtureEpoch(0, 0, 1), hookReceiptId: 'manual-original-hook', run: { runId: RUN_ID } },
    questions: [{ id: 'manual-question', prompt: 'Answer in the original Session', options: [{ id: 'keep', label: 'Keep original work' }] }] }
  const f = await authenticatedFixture(request), view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.querySelector('[data-request-id="manual-original-request"]')).not.toBeNull())
  await click(button(view.element, 'Open terminal'))
  expect(f.openTerminal).toHaveBeenCalledOnce()
  expect(f.respond).not.toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  expect(saved().responses).toEqual([])
}, 15000)

it.each(['question', 'permission'] as const)('retains a historical synchronous %s operation through remount and queries its Core receipt after native completion without input', async kind => {
  const request: AgentMuxInteractionRequest = kind === 'permission' ? permission('exact-sync-permission') : {
    kind: 'question', id: 'exact-sync-question', agentSessionId: sid, nativeToolCallId: 'sync-native-call',
    evidence: { source: 'native-hook', observedAt: _historyTailFixtureEpoch(0, 0, 1), hookReceiptId: 'sync-hook', run: { runId: RUN_ID } },
    questions: [{ id: 'sync-question', prompt: 'Choose this original request', options: [{ id: 'keep', label: 'Keep sync original' }] }] }
  const response: AgentMuxInteractionResponse = kind === 'permission'
    ? { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: 'reject-once' } }
    : { kind: 'question', requestId: request.id, outcome: 'answered', answers: [{ questionId: 'sync-question', optionId: 'keep' }] }
  const f = await authenticatedFixture(request, response), local = createLocalDrafts()
  local.responses.set(JSON.stringify([sid, RUN_ID, request.id]), { phase: 'unknown', message: 'The original receipt is unconfirmed on this device.',
    original: { input: f.retainedInput!, hostId: f.client.agentSession(sid).hostId, runtimeId: f.client.runtimeOwnerIdentity()!.runtimeId } })
  await local.save()
  const view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.querySelector('[data-request-id]')).not.toBeNull())
  await vi.waitFor(() => {
    expect(saved().responses).toHaveLength(1)
    expect(saved().responses[0][1].phase).toBe('unknown')
  })
  expect(f.respond).not.toHaveBeenCalled(); const frozen = saved().responses[0][1].original
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
  expect(f.respond).not.toHaveBeenCalled()
  if (kind === 'permission') await completeNativeRequest(f.core)
  else await (f.core as unknown as { acceptHookEvent(envelope: unknown, signal: AbortSignal): Promise<void> }).acceptHookEvent({
    receiptId: 'controlled-sync-completion', agentSessionId: sid, providerId: 'claude', runId: RUN_ID,
    payload: { session_id: source.nativeSessionId, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_call_id: request.nativeToolCallId }
  }, new AbortController().signal)
  await vi.waitFor(() => expect(restored.element.querySelector('[data-request-id]')).toBeNull())
  expect(restored.element.querySelectorAll('[data-original-response]')).toHaveLength(1)
  await click(button(restored.element, '查询原答复回执'))
  await vi.waitFor(() => expect(saved().responses[0][1].phase, restored.element.textContent!).toBe('confirmed'))
  await vi.waitFor(() => expect(restored.element.textContent).toContain('原请求已确认完成'))
  expect(f.inspect).toHaveBeenCalledWith({ agentSessionId: sid, operationId: frozen.input.operationId })
  expect(f.writes).toHaveLength(0); expect(f.respond).not.toHaveBeenCalled()
  expect(saved().responses[0][1].original).toEqual(frozen)
  await f.recordProof('original-sync-' + kind, { passed: true, requestId: request.id, operationId: frozen.input.operationId,
    retainedAfterCompletion: true, originalWrites: f.writes.length, readonlyInspect: true, draftRetained: true,
    faultInjection: 'Historical original Core receipt and unknown device observation seeded before the actual Hosted read',
    qualification: 'No fresh response dispatch or vendor Native acceptance; current native-hook questions remain manual' })
}, 15000)

it('keeps original older-window text and selection while another entry records an exact same-source answer; foreign answers cannot bind it', async () => {
  const f = await authenticatedFixture(), local = createLocalDrafts()
  const legacy = { phase: 'unknown' as const, hostId: f.client.agentSession(sid).hostId, runtimeId: f.client.runtimeOwnerIdentity()!.runtimeId,
    diagnostic: { code: 'ORIGINAL_UNKNOWN', message: 'The original answer operation is still unconfirmed.' },
    input: { source, recordId: question.id, turnId: question.turnId, expectedRun: { runId: RUN_ID }, afterSubmissionId: null,
      operationId: 'retained-original-answer', answers: [{ questionId: 'exact-async-question', answer: 'Keep original' }] } }
  local.questions.set(questionReplyKey(sid, legacy.input), legacy); await local.save()
  const view = await mount(f.surface())
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
  expect(saved().questions[0][1]).toEqual(legacy)
  expect(view.element.textContent).toContain(legacy.diagnostic.message)
  expect(f.reply).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
}, 15000)
