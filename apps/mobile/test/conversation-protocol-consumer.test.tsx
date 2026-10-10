// @vitest-environment node
import './device-locks'
import { act } from 'react'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { AgentMuxInteractionRequest, AgentMuxInteractionResponse, AgentMuxInteractionOperationReceipt, AgentProviderSessionHistoryObservation, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { loadAgentSessions } from '../../../packages/core/src/agent-session-store'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { AgentTerminalScreen } from '../../../packages/core/src/agent-terminal-screen'
import { interactionOperationHook, OPERATION_SESSION_ID, OPERATION_RUN_ID } from '../../../packages/core/test/fixtures/interaction-operation-hook'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import type { AgentMuxClient } from '../../../packages/core/src/client'
import type { AgentMuxAcpBinding } from '../../../packages/core/src/acp-adapter'
import { connectedClient, permission, completeNativeRequest, AGENT_SESSION_ID as sid, RUN_ID } from '../../../packages/core/test/fixtures/interaction-client'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { createBrowserPlatform } from '../src/platform/browser'
import { getDeviceWorkface, emptyDeviceWorkface, DEVICE_WORKFACE_KEY } from '../src/recovery/device-workface'
import { button, click, deferred, editor, mount, mounted, paste } from './conversation-fixture'
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

async function authenticatedConsumer(core: AgentMuxClient, root: string, agentSessionId: string, runtimeId = 'original-runtime') {
  const hosted = new AgentMuxHostedRuntimeService(core, null, () => ({ ...hostedTestOwner(core), runtimeId, ownerInstanceId: runtimeId + '-owner' }))
  closes.push(() => hosted.dispose())
  const authenticated: string[] = [], device = { hostId: 'local', deviceId: 'approved-mobile-device', name: 'Controlled Mobile' }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'),
    coreClients: () => [{ hostId: 'local', client: core }], hostedRuntime: () => hosted,
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
  const surface = () => <MobileConversationSurface client={client} agentSessionId={agentSessionId} connection={{ state: 'connected', message: 'Authenticated original Host' }} platform={createBrowserPlatform()} onShowTerminal={openTerminal} />
  return { client, rpc, url, authenticated, device, openTerminal, surface }
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
  const transport = await authenticatedConsumer(h.client, root, sid)
  const recordProof = async (name: string, evidence: unknown) => {
    if (!process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE) return
    const target = join(process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE, name + '.json')
    await mkdir(process.env.AGENTMUX_MOBILE_PROTOCOL_EVIDENCE, { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n')
  }
  return { ...h, ...transport, core: h.client, submit, reply, respond, inspect, recordProof, retainedInput,
    setRecent(value: AgentSessionHistoryPage) { recent = value }, setOlder(value: AgentSessionHistoryPage) { older = value },
    invalidate() { observe?.({ kind: 'invalidated', source }) } }
}

it('authenticated Mobile keeps captured speech visible beside distinct native records, preserving authors, failures, selection and original reads', async () => {
  const f = await authenticatedFixture(), sharedBody = 'Repeated original input'
  const nativePage: AgentSessionHistoryPage = { agentSessionId: sid, source, nextCursor: 'original-unread-page', items: [
    { id: 'input-duplicated', kind: 'user-message', contentParts: [{ kind: 'text', text: sharedBody }] },
    { id: 'native-answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Native original answer' }] }
  ] }
  f.setRecent(nativePage)
  const items: AgentTimelineItem[] = [
    { id: 'input-duplicated', agentSessionId: sid, kind: 'user_message', source: 'user', status: 'complete', createdAt: _historyTailFixtureEpoch(0, 0, 1), updatedAt: _historyTailFixtureEpoch(0, 0, 1),
      title: 'Submitted input', content: sharedBody, authorHuman: true, sourceChannel: 'message-tool', sourceDevice: f.device, publicContent: 'confirmed' },
    { id: 'input-failed', agentSessionId: sid, kind: 'user_message', source: 'user', status: 'failed', createdAt: _historyTailFixtureEpoch(0, 0, 2), updatedAt: _historyTailFixtureEpoch(0, 0, 2),
      title: 'Failed input', content: 'Original failed input', authorHuman: true },
    { id: 'input-unconfirmed', agentSessionId: sid, kind: 'user_message', source: 'user', status: 'streaming', createdAt: _historyTailFixtureEpoch(0, 0, 3), updatedAt: _historyTailFixtureEpoch(0, 0, 3),
      title: 'Unconfirmed input', content: 'Original unconfirmed input' },
    { id: 'reply-captured', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: _historyTailFixtureEpoch(0, 0, 4), updatedAt: _historyTailFixtureEpoch(0, 0, 4),
      title: 'Observed reply', content: 'Captured original reply', authorAgentSessionId: 'exact-peer-author' }
  ]
  for (const item of items) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item })
  const reads = vi.spyOn(f.core, 'sessionHistoryPage'), view = await mount(f.surface())
  const readOptions = () => reads.mock.calls.map(([, options]) => ({ limit: options?.limit, cursor: options?.cursor }))
  await vi.waitFor(() => expect(view.element.textContent).toContain('Captured original reply'))
  const record = (id: string) => view.element.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
  for (const id of ['captured:input-duplicated', 'captured:input-failed', 'captured:input-unconfirmed', 'reply-captured']) {
    expect(record(id), id).not.toBeNull()
    expect(record(id).closest('details:not([open]), [hidden], [inert]'), `${id} is readable without opening another conversation`).toBeNull()
  }
  expect(view.element.querySelector('.mobile-conversation__captured')?.tagName).toBe('SECTION')
  expect(view.element.querySelectorAll('[data-native-record-id="input-duplicated"]')).toHaveLength(1)
  expect(record('captured:input-duplicated').querySelector('.log-turn__body')!.textContent).toBe(sharedBody)
  expect(record('captured:input-duplicated').dataset.speakerRole).toBe('human')
  expect(record('captured:input-duplicated').textContent).toContain('Message Tool')
  expect(record('captured:input-duplicated').textContent).toContain(f.device.name)
  expect(record('captured:input-failed').dataset.status).toBe('failed')
  expect(record('captured:input-failed').textContent).toContain('Failed')
  expect(record('captured:input-unconfirmed').dataset.status).toBe('unverified')
  expect(record('captured:input-unconfirmed').textContent).toContain('Unverified')
  expect(record('reply-captured').dataset.speakerRole).toBe('agent')
  expect(record('reply-captured').querySelector('.log-turn__sender-id')!.textContent).toContain('exact-peer-author')
  expect(record('reply-captured').dataset.messageSourceKey).toBe(JSON.stringify([sid, 'captured', 'reply-captured']))
  expect(readOptions()).toEqual([{ limit: 30, cursor: undefined }])
  const native = view.element.querySelector('[data-native-record-id="native-answer"] .log-turn__body')!, text = native.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6); window.getSelection()!.addRange(range)
  const reply = record('reply-captured'), body = reply.querySelector('.log-turn__body')!
  await vi.waitFor(() => expect(f.core.providers.get('codex').observeSessionHistory).toHaveBeenCalledTimes(1))
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: 'reply-captured', updatedAt: _historyTailFixtureEpoch(0, 0, 5), content: 'Captured reply grows in place' })
  await act(async () => f.invalidate())
  await vi.waitFor(() => expect(body.textContent).toBe('Captured reply grows in place'))
  expect(record('reply-captured')).toBe(reply); expect(reply.querySelector('.log-turn__body')).toBe(body)
  expect(view.element.querySelector('[data-native-record-id="native-answer"] .log-turn__body')).toBe(native)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('Native')
  expect(readOptions()).toEqual([{ limit: 30, cursor: undefined }, { limit: 30, cursor: undefined }])
  expect(button(view.element, '更早消息')).toBeDefined()
  expect(f.writes).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled()
  await f.recordProof('visible-captured-reading', { passed: true, boundary: 'Authenticated HTTP/Hosted/Core/FileStore → actual MobileConversationSurface; controlled Provider history',
    page: nativePage, timeline: await f.core.sessionTimeline(sid), session: f.client.agentSession(sid), reads: reads.mock.calls.map(call => call[1]),
    sameBodyNativeAndCapturedRetained: true, originalRange: range.toString(), runtimeWrites: f.writes.length })
}, 15000)

it('authenticated Mobile keeps captured original speech readable when the native reader is unavailable, without a false empty conversation or input', async () => {
  const f = await authenticatedFixture()
  const item: AgentTimelineItem = { id: 'retained-hook-reply', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook',
    status: 'complete', createdAt: _historyTailFixtureEpoch(0, 0, 1), updatedAt: _historyTailFixtureEpoch(0, 0, 1), title: 'Observed original reply', content: 'Original captured reply remains readable' }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item })
  vi.mocked(f.core.providers.get('codex').readSessionHistoryPage!).mockRejectedValue(Object.assign(new Error('Original native reader unavailable'), { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' }))
  const view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.textContent).toContain(item.content))
  const reply = view.element.querySelector<HTMLElement>('[data-message-id="retained-hook-reply"]')!
  expect(reply.closest('details:not([open]), [hidden], [inert]')).toBeNull()
  expect(view.element.querySelector('[data-native-record-id]')).toBeNull()
  await vi.waitFor(() => expect(view.element.textContent).toContain('Original native reader unavailable'))
  expect(view.element.textContent).not.toContain('暂无已确认的对话内容')
  expect(reply.dataset.status).toBe('complete')
  expect(f.writes).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled()
}, 15000)

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


async function mobileHook(requestId: string) {
  const h = await interactionOperationHook(requestId)
  const provider = h.client.providers.get('codex'), source = { providerId: 'codex', nativeSessionId: 'original-native' }
  vi.spyOn(provider, 'readSessionHistoryPage').mockResolvedValue({ source, items: [], nextCursor: null })
  vi.spyOn(provider, 'observeSessionHistory').mockImplementation(async context => ({ source: context.source, dispose() {} }))
  return h
}

it('the authenticated Mobile card reaches an open original Hook and adopts its exact receipt independent of JSON property order', async () => {
  const h = await mobileHook('mobile-open-hook'); closes.push(h.close)
  vi.spyOn(h.client, 'connect').mockResolvedValue()
  const respond = vi.spyOn(h.client, 'respondAgentInteraction'), inspect = vi.spyOn(h.client, 'inspectAgentInteractionOperation')
  const transport = await authenticatedConsumer(h.client, h.root, OPERATION_SESSION_ID)
  // Reorder the actual decoded Host result at the consumer leaf; no receipt is fabricated.
  const originalRespond = transport.client.respondAgentInteraction.bind(transport.client)
  vi.spyOn(transport.client, 'respondAgentInteraction').mockImplementation(async input => {
    const receipt = await originalRespond(input)
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value
    return reverse(receipt) as typeof receipt
  })
  const view = await mount(transport.surface())
  await vi.waitFor(() => expect(view.element.querySelector('[data-request-id="mobile-open-hook"]')).not.toBeNull())
  await paste(view.element, 'Original newer draft remains editable')
  await click(button(view.element, h.request.options.find(option => option.id === 'reject-once')!.label))
  await vi.waitFor(() => expect(saved().responses[0]?.[1].phase, view.element.textContent!).toBe('confirmed'))
  expect(respond).toHaveBeenCalledOnce()
  const input = respond.mock.calls[0]![0]
  expect(input).toMatchObject({ agentSessionId: OPERATION_SESSION_ID, expectedRun: { runId: OPERATION_RUN_ID },
    operationId: expect.any(String), expectedRequest: h.request, response: h.input.response })
  expect(await h.callback).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } })
  expect(await h.client.inspectAgentInteractionOperation(input)).toMatchObject({ operationId: input.operationId, delivery: 'hook-written', nativeAdoption: 'unknown' })
  await click(button(view.element, '查询原答复回执'))
  expect(inspect.mock.calls.some(([value]) => value.operationId === input.operationId)).toBe(true)
  expect(saved().responses[0][1].original.input).toEqual(input)
  expect(editor(view.element).textContent).toContain('Original newer draft remains editable')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(transport.authenticated.length).toBeGreaterThan(0)
}, 15000)

it('an authenticated Mobile response lost after the real Hook write survives remount and only inspects its original operation', async () => {
  const h = await mobileHook('mobile-lost-hook'); closes.push(h.close)
  vi.spyOn(h.client, 'connect').mockResolvedValue()
  const respond = vi.spyOn(h.client, 'respondAgentInteraction'), inspect = vi.spyOn(h.client, 'inspectAgentInteractionOperation')
  const transport = await authenticatedConsumer(h.client, h.root, OPERATION_SESSION_ID)
  const original = transport.client.respondAgentInteraction.bind(transport.client)
  vi.spyOn(transport.client, 'respondAgentInteraction').mockImplementation(async input => { await original(input); throw new Error('Original HTTP response lost') })
  const view = await mount(transport.surface())
  await vi.waitFor(() => expect(view.element.querySelector('[data-request-id="mobile-lost-hook"]')).not.toBeNull())
  await click(button(view.element, h.request.options.find(option => option.id === 'reject-once')!.label))
  await vi.waitFor(() => expect(saved().responses[0]?.[1].phase).toBe('unknown'))
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  const frozen = structuredClone(saved().responses[0][1].original)
  await paste(view.element, 'Draft edited after the unknown response')
  await unmount(view.element)
  const restored = await mount(transport.surface())
  await vi.waitFor(() => expect(restored.element.querySelector('[data-original-response]')).not.toBeNull())
  expect(saved().responses[0][1].phase).toBe('unknown')
  expect(respond).toHaveBeenCalledOnce()
  const originalInspect = transport.client.inspectAgentInteractionOperation.bind(transport.client)
  const query = vi.spyOn(transport.client, 'inspectAgentInteractionOperation')
  const foreignReceipts: Array<(receipt: AgentMuxInteractionOperationReceipt) => AgentMuxInteractionOperationReceipt> = [
    receipt => ({ ...receipt, agentSessionId: 'another-session' }),
    receipt => ({ ...receipt, operationId: 'another-operation' }),
    receipt => ({ ...receipt, run: { runId: 'another-run' } }),
    receipt => ({ ...receipt, expectedRequest: { ...receipt.expectedRequest, title: 'Another request content' } as typeof receipt.expectedRequest }),
    receipt => ({ ...receipt, response: { kind: 'permission', requestId: 'mobile-lost-hook', decision: { outcome: 'selected', optionId: 'allow-once' } } })
  ]
  for (const alter of foreignReceipts) {
    query.mockImplementationOnce(async input => { const receipt = await originalInspect(input); expect(receipt).not.toBeNull(); return alter(receipt!) })
    const queriesBefore = query.mock.calls.length
    await click(button(restored.element, '查询原答复回执'))
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(queriesBefore + 1))
    await act(async () => { await query.mock.results.at(-1)!.value })
    await vi.waitFor(() => expect(restored.element.textContent).toContain('原答复查询未确认'))
    expect(saved().responses[0][1].phase).toBe('unknown')
    expect(saved().responses[0][1].original).toEqual(frozen)
  }
  await click(button(restored.element, '查询原答复回执'))
  await vi.waitFor(() => expect(saved().responses[0][1].phase).toBe('confirmed'))
  expect(inspect.mock.calls.some(([value]) => value.agentSessionId === OPERATION_SESSION_ID && value.operationId === frozen.input.operationId)).toBe(true)
  expect(saved().responses[0][1].original).toEqual(frozen)
  expect(editor(restored.element).textContent).toContain('Draft edited after the unknown response')
  expect(respond).toHaveBeenCalledOnce(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
}, 15000)

async function acpConsumerFixture() {
  const h = await rpcOwnerFixture([OPERATION_SESSION_ID]); closes.push(h.close)
  vi.spyOn(h.client, 'connect').mockResolvedValue()
  // Unrelated activity probes cannot consume the deliberate dispatch-await race.
  vi.spyOn(h.client, 'statusAgent').mockRejectedValue(new Error('Controlled ACP activity observation unavailable'))
  // No built-in Provider advertises ACP. This controlled Provider declaration and
  // last adapter callback exercise the real Core bridge, not a vendor capability.
  const provider = h.client.providers.get('codex')
  h.client.providers.replace({ ...provider, catalog: { ...provider.catalog, acpStrategy: { kind: 'adapter' } } })
  let receive: Parameters<AgentMuxAcpBinding['onEvent']>[0] | undefined
  const decisions: Array<{ requestId: string; decision: unknown }> = []
  const binding: AgentMuxAcpBinding = { adapterId: 'mobile-controlled-adapter', sessionId: 'mobile-original-acp',
    onEvent(listener) { receive = listener; return () => { receive = undefined } },
    async respondPermission(requestId, decision, signal) { signal.throwIfAborted(); decisions.push({ requestId, decision }) }, async close() {} }
  await h.client.bindAcp(OPERATION_SESSION_ID, binding)
  receive!({ type: 'permission', requestId: 'mobile-acp-request', title: 'Original ACP permission',
    options: [{ id: 'allow', label: 'Allow original ACP', kind: 'allow-once' }, { id: 'deny', label: 'Deny original ACP', kind: 'reject-once' }] })
  await vi.waitFor(() => expect(h.client.agentSession(OPERATION_SESSION_ID).pendingInteraction?.request.id).toBe('mobile-acp-request'))
  return { ...h, binding, decisions }
}

it('the authenticated Mobile card consumes the original Core ACP responder without PTY input or invented native adoption', async () => {
  const h = await acpConsumerFixture(), { binding, decisions } = h
  const respond = vi.spyOn(h.client, 'respondAgentInteraction')
  const transport = await authenticatedConsumer(h.client, h.root, OPERATION_SESSION_ID), view = await mount(transport.surface())
  await vi.waitFor(() => expect(view.element.querySelector('[data-request-id="mobile-acp-request"]')).not.toBeNull())
  const displayed = structuredClone((await h.store.readMetadata(OPERATION_SESSION_ID))!.pendingInteraction!.request)
  await click(button(view.element, 'Deny original ACP'))
  await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce())
  expect(respond.mock.calls[0]![0].expectedRequest).toEqual(displayed)
  await vi.waitFor(() => expect(saved().responses[0]?.[1].phase, view.element.textContent!).toBe('confirmed'))
  expect(decisions).toEqual([{ requestId: 'mobile-acp-request', decision: { outcome: 'selected', optionId: 'deny' } }])
  expect(respond).toHaveBeenCalledOnce()
  const input = respond.mock.calls[0]![0]
  expect(input.expectedRequest.evidence).toMatchObject({ source: 'acp', acpAdapterId: binding.adapterId, acpSessionId: binding.sessionId })
  expect(await h.client.inspectAgentInteractionOperation(input)).toMatchObject({ operationId: input.operationId, delivery: 'acp-acknowledged', nativeAdoption: 'unknown' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
}, 15000)

it('the main Mobile conversation reads an exact native image through the authenticated Hosted resource owner', async () => {
  const f = await authenticatedFixture()
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
  const record = { id: 'main-native-image', turnId: 'main-image-turn', kind: 'assistant-message' as const,
    contentParts: [{ kind: 'resource' as const, resourceType: 'image' as const, reference: image, label: 'Original native image' }] }
  f.setRecent({ ...page(), items: [record] })
  const lookup = vi.spyOn(f.core.providers.get('codex'), 'readSessionHistoryRecord').mockResolvedValue(record)
  const read = vi.spyOn(f.core, 'sessionHistoryResource'), view = await mount(f.surface())
  await vi.waitFor(() => expect(view.element.querySelector<HTMLImageElement>('.conversation-native-thread img')?.src).toBe(image))
  expect(read).toHaveBeenCalledWith(sid, expect.objectContaining({ source, recordId: record.id, turnId: record.turnId, partIndex: 0, expectedReference: image }))
  expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ source, recordId: record.id, turnId: record.turnId }))
  await paste(view.element, 'Resource reads do not replace the draft')
  expect(editor(view.element).textContent).toContain('Resource reads do not replace the draft')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
}, 15000)


it.each(['adapter', 'native-session', 'run', 'request'] as const)('the authenticated Mobile ACP response rejects a replaced original %s across the Core await', async changed => {
  const h = await acpConsumerFixture()
  const transport = await authenticatedConsumer(h.client, h.root, OPERATION_SESSION_ID), view = await mount(transport.surface())
  await vi.waitFor(() => expect(view.element.querySelector('[data-request-id="mobile-acp-request"]')).not.toBeNull())
  await paste(view.element, 'New draft after the original request')
  vi.mocked(h.client.connect).mockImplementationOnce(async () => {
    const before = (await h.store.readMetadata(OPERATION_SESSION_ID))!
    await h.store.compareAndSwapMetadata(before, { ...before,
      ...(changed === 'adapter' || changed === 'native-session' ? { nativeHandle: { kind: 'acp',
        adapterId: changed === 'adapter' ? 'replacement-adapter' : h.binding.adapterId,
        sessionId: changed === 'native-session' ? 'replacement-session' : h.binding.sessionId } } : {}),
      ...(changed === 'run' ? { run: { runId: 'replacement-run' }, pendingInteraction: { request: { ...before.pendingInteraction!.request,
        evidence: { ...before.pendingInteraction!.request.evidence, run: { runId: 'replacement-run' } } } } } : {}),
      ...(changed === 'request' ? { pendingInteraction: { request: { ...before.pendingInteraction!.request, title: 'Replacement request content' } as typeof before.pendingInteraction.request } } : {}) })
    await h.inner.registry.load('local')
  })
  await click(button(view.element, 'Deny original ACP'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('The original interaction target changed before dispatch'))
  expect(saved().responses[0]?.[1].phase).toBe('unknown')
  expect(h.decisions).toEqual([])
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(saved().responses[0][1].original.input.expectedRequest.id).toBe('mobile-acp-request')
  expect(editor(view.element).textContent).toContain('New draft after the original request')
}, 15000)


it('keeps two authenticated Host owners with the same Session Run and request IDs independent across a delayed original receipt', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(_historyTailFixtureEpoch(0, 0, 1))
  const first = await mobileHook('mobile-shared-request'); closes.push(first.close)
  const second = await mobileHook('mobile-shared-request'); closes.push(second.close)
  clock.mockRestore()
  expect(first.request).toEqual(second.request)
  vi.spyOn(first.client, 'connect').mockResolvedValue(); vi.spyOn(second.client, 'connect').mockResolvedValue()
  const a = await authenticatedConsumer(first.client, first.root, OPERATION_SESSION_ID)
  const b = await authenticatedConsumer(second.client, second.root, OPERATION_SESSION_ID, 'other-runtime')
  const original = a.client.respondAgentInteraction.bind(a.client), release = deferred<void>()
  const respondA = vi.spyOn(a.client, 'respondAgentInteraction').mockImplementation(async input => { const receipt = await original(input); await release.promise; return receipt })
  const respondB = vi.spyOn(second.client, 'respondAgentInteraction')
  const surface = (client: typeof a.client) => <MobileConversationSurface client={client} agentSessionId={OPERATION_SESSION_ID}
    connection={{ state: 'connected', message: 'Authenticated selected owner' }} platform={createBrowserPlatform()} />
  const view = await mount(surface(a.client)), label = first.request.options.find(option => option.id === 'reject-once')!.label
  try {
    await vi.waitFor(() => expect(view.element.querySelector('[data-request-id="mobile-shared-request"]')).not.toBeNull())
    await click(button(view.element, label))
    expect(await first.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
    const frozen = structuredClone(saved().responses[0][1].original)
    await view.render(surface(b.client))
    await vi.waitFor(() => expect(button(view.element, label).disabled).toBe(false))
    await paste(view.element, 'New draft on the selected owner')
    await act(async () => release.resolve())
    await act(async () => { await respondA.mock.results[0]!.value })
    expect(view.element.querySelector('[data-request-id] [data-original-response]')).toBeNull()
    expect(button(view.element, label).disabled).toBe(false)
    await click(button(view.element, label))
    await vi.waitFor(() => expect(respondB).toHaveBeenCalledOnce())
    expect(await second.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
    await vi.waitFor(() => expect(saved().responses).toHaveLength(2))
    expect(saved().responses.find(([, attempt]: [string, { original: typeof frozen }]) => attempt.original.runtimeId === frozen.runtimeId)[1].original).toEqual(frozen)
    const other = respondB.mock.calls[0]![0]
    expect(other.operationId).not.toBe(frozen.input.operationId)
    expect(editor(view.element).textContent).toContain('New draft on the selected owner')
    await view.render(surface(a.client))
    await vi.waitFor(() => expect(view.element.querySelector('[data-original-response]')?.getAttribute('data-original-response')).toBe(frozen.input.operationId))
    await click(button(view.element, '查询原答复回执'))
    expect(await first.client.inspectAgentInteractionOperation(frozen.input)).toMatchObject({ operationId: frozen.input.operationId, delivery: 'hook-written' })
    expect(first.inner.kernel.input).not.toHaveBeenCalled(); expect(second.inner.kernel.input).not.toHaveBeenCalled()
  } finally { release.resolve() }
}, 15000)
