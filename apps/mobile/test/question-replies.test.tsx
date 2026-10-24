import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { projectConversationTimeline, type AgentConversationReadPage } from '@agentmux/core/conversation'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { MobileApp } from '../src/MobileApp'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { reconcileMobileQuestionReplies, submitMobileQuestionReply } from '../src/conversation/question-replies'
import { createBrowserPlatform } from '../src/platform/browser'
import { DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, history, mount, mounted } from './conversation-fixture'
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: Record<string, unknown>; unicode = { activeVersion: '6' }; textarea = document.createElement('textarea'); rows = 24
  buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } }; element: HTMLElement | undefined
  parser = { registerOscHandler: () => ({ dispose() {} }) }
  constructor(options: Record<string, unknown>) { this.options = options }
  loadAddon() {} open(node: HTMLElement) { this.element = node; node.append(this.textarea) } dispose() { this.textarea.remove() }
  user: (() => void) | undefined; data: ((value: string) => void) | undefined
  input(value: string, user: boolean) { if (user) this.user?.(); this.data?.(value) }
  getSelection() { return '' } scrollToLine() {} focus() {} onUserInput(listener: () => void) { this.user = listener; return { dispose() {} } } onData(listener: (value: string) => void) { this.data = listener; return { dispose() {} } } onBinary() { return { dispose() {} } }
} }))
vi.mock('../src/terminal/reader', () => ({ createMobileTerminalReader: () => ({ setVisible() {}, dispose: async () => {}, retry: async () => {} }) }))
const sid = 'session-original', target = { source: history().source, turnId: 'original-turn', recordId: 'original-question' }, key = questionReplyKey(sid, target)
const page: AgentSessionHistoryPage = { ...history(), nextCursor: null, items: [{ id: target.recordId, turnId: target.turnId, kind: 'assistant-message', contentParts: [{ kind: 'text', text: '原始问题正文' }], questionRequest: { delivery: 'async', questions: [
  { id: 'first', prompt: '如何处理原工作面？', options: [{ id: 'keep', label: 'Keep original' }], acceptsText: true },
  { id: 'second', prompt: '补充说明', options: [], acceptsText: true }
] } }] }
const held = { phase: 'unknown' as const, runtimeId: 'original-runtime', hostId: 'host-original', diagnostic: { code: 'ORIGINAL_UNKNOWN', message: '原答复回执仍未知' }, input: { ...target, operationId: 'original-operation', expectedRun: { runId: 'run-original' }, afterSubmissionId: 'original-predecessor', answers: [{ questionId: 'first', answer: 'Original frozen answer' }] } }
const record = () => JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation
const attempt = (replyKey = key) => record().questions?.find(([id]: [string]) => id === replyKey)?.[1]
function questionFixture(historyPage = page) {
  const f = fixture(); f.setPage(historyPage)
  const questionTarget = { ...target, source: historyPage.source }, replyKey = questionReplyKey(sid, questionTarget)
  f.sessions.set(sid, { ...f.sessions.get(sid)!, nativeHandle: { kind: 'provider', providerId: historyPage.source.providerId, sessionId: historyPage.source.nativeSessionId } })
  const rpc = vi.fn(async (method: string) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession(sid), displayName: { override: null, availability: 'observed' } }
    throw new Error('Unexpected automatic RPC: ' + method)
  })
  const write = vi.fn(async (input: any) => ({ runId: input.expectedRun.runId, appliedByteRange: { startByte: 0, endByte: new TextEncoder().encode(input.data).length }, acceptedThroughByte: new TextEncoder().encode(input.data).length }))
  const reply = vi.fn<AgentMuxHostedClient['replySessionQuestion']>().mockImplementation(async input => ({
    agentSessionId: input.agentSessionId, source: input.source, recordId: input.recordId, questionIds: input.answers.map(answer => answer.questionId),
    operationId: input.operationId, outcome: 'submitted'
  }))
  const read: AgentMuxHostedClient['readAgentConversation'] = async input => {
    const sourceHostId = f.sessions.get(input.agentSessionId)!.hostId
    const original = await f.readHistory(input.agentSessionId)
    const timeline = projectConversationTimeline({ agentSessionId: input.agentSessionId, executionHostId: sourceHostId,
      historyPage: { ...original, sourceHostId } })
    const reference = { hostId: input.hostId, agentSessionId: input.agentSessionId }
    const checkpoint = { ...reference, sourceHostId, frontier: { ...reference, scope: timeline.scope, cuts: [] } }
    return { ...reference, sourceHostId, scope: timeline.scope, coverage: timeline.coverage,
      order: { ...timeline.order, direction: 'newest-first' }, budgetBytes: 4096, nextCursor: null,
      items: [...timeline.events].reverse().map(event => ({ kind: 'item', item: { event,
        records: timeline.records.filter(record => event.recordIds.includes(record.id)) } })),
      window: { id: 'original-question-window', revision: 1, itemCount: timeline.events.length, complete: true,
        view: 'original-question-view', replay: 'original-question-replay', checkpoint,
        outside: { older: null, newer: null }, navigation: { older: null, newer: null } } } satisfies AgentConversationReadPage
  }
  Object.assign(f.client, { forwardRpc: rpc, writeAgent: write, replySessionQuestion: reply,
    readAgentConversation: read,
    readConversationChanges: async (input: Parameters<AgentMuxHostedClient['readConversationChanges']>[0]) => ({ ...await read(input), checkpoint: input.checkpoint, more: false }),
    observeConversation: async (input: Parameters<AgentMuxHostedClient['observeConversation']>[0]) => {
      const frame = await read(input)
      return { hostId: frame.hostId, sourceHostId: frame.sourceHostId, agentSessionId: frame.agentSessionId,
        scope: frame.scope, coverage: frame.coverage, closed: new AbortController().signal, dispose() {} }
    },
    releaseConversationView: async () => ({}),
    runtimeIdentity: () => ({ hostId: 'host-original', instanceId: 'original-runtime' }), runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }) })
  return { ...f, rpc, write, reply, questionTarget, replyKey }
}
async function type(element: HTMLElement, value: string) { const field = element.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: 补充说明"]')!; expect(field.disabled).toBe(false); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function refresh(element: HTMLElement) { if (!element.querySelector('[aria-label="刷新原对话"]')) await click(button(element, 'Show the message tool row')); await click(button(element, '刷新原对话')) }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } vi.restoreAllMocks() })
it('the mounted mobile card persists exact answers before sending them through the public reply API', async () => {
  const f = questionFixture()
  f.reply.mockImplementationOnce(async input => {
    expect(attempt()).toMatchObject({ phase: 'sending', hostId: 'host-original', runtimeId: 'original-runtime', input: {
      ...target, operationId: input.operationId, expectedRun: { runId: 'run-original' }, afterSubmissionId: null, answers: input.answers
    } })
    return { agentSessionId: input.agentSessionId, source: input.source, recordId: input.recordId,
      questionIds: input.answers.map(answer => answer.questionId), operationId: input.operationId, outcome: 'submitted' }
  })
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
  await click(button(view.element, 'Keep original')); await type(view.element, '  Exact second answer\nPreserve whitespace  ')
  await click(button(view.element, '发送答案'))
  expect(f.reply).toHaveBeenCalledExactlyOnceWith({ ...target, operationId: expect.any(String), expectedRun: { runId: 'run-original' },
    afterSubmissionId: null, answers: [{ questionId: 'first', answer: 'Keep original' }, { questionId: 'second', answer: '  Exact second answer\nPreserve whitespace  ' }],
    agentSessionId: sid, authorHuman: true, sourceChannel: 'question-reply' })
  expect(f.reply.mock.calls[0]![0]).not.toHaveProperty('expectedTurnId')
  expect(attempt().phase).toBe('submitted'); expect(view.element.textContent).toContain('Awaiting a recorded answer')
  expect(f.write).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
it('explicit unknown retries reuse the original reply identity and answers while keeping later edits separate', async () => {
  const f = questionFixture(), local = createLocalDrafts(); local.questions.set(key, structuredClone(held)); await local.save()
  f.reply.mockRejectedValueOnce(new Error('Original reply acknowledgement unavailable'))
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
  await click(button(view.element, 'Keep original')); await type(view.element, 'Later editable answer')
  await click(button(view.element, '继续原发送'))
  expect(attempt()).toMatchObject({ phase: 'unknown', input: held.input })
  await click(button(view.element, '继续原发送'))
  expect(f.reply).toHaveBeenCalledTimes(2)
  expect(f.reply.mock.calls[0]![0]).toEqual({ ...held.input, agentSessionId: sid, authorHuman: true, sourceChannel: 'question-reply' })
  expect(f.reply.mock.calls[1]![0]).toEqual(f.reply.mock.calls[0]![0])
  expect(record().questionDrafts[0][1]).toContainEqual({ questionId: 'second', answer: 'Later editable answer' })
  expect(attempt().phase).toBe('submitted')
})
it('a failed device write keeps the mounted answer editable and visible without dispatching it', async () => {
  const f = questionFixture(), view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
  expect(button(view.element, '发送答案').disabled).toBe(true)
  await click(button(view.element, 'Keep original')); await type(view.element, 'Answer retained before dispatch')
  expect(button(view.element, '发送答案').disabled).toBe(false)
  const set = localStorage.setItem.bind(localStorage)
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation((storageKey, value) => {
    if (storageKey === DEVICE_WORKFACE_KEY) throw new Error('Device save unavailable')
    return set(storageKey, value)
  })
  await click(button(view.element, '发送答案'))
  expect(f.reply).not.toHaveBeenCalled(); expect(view.element.textContent).toContain('尚未持久保存')
  expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: 补充说明"]')!.value).toBe('Answer retained before dispatch')
  expect(button(view.element, '发送答案').disabled).toBe(false)
  write.mockRestore(); await click(button(view.element, '发送答案'))
  expect(f.reply).toHaveBeenCalledExactlyOnceWith({ ...target, operationId: expect.any(String), expectedRun: { runId: 'run-original' },
    afterSubmissionId: null, answers: [{ questionId: 'first', answer: 'Keep original' }, { questionId: 'second', answer: 'Answer retained before dispatch' }],
    agentSessionId: sid, authorHuman: true, sourceChannel: 'question-reply' })
  expect(attempt().phase).toBe('submitted')
})
it('uses the original device owner persistence result even while another storage owner is healthy', async () => {
  const f = questionFixture(), raw = JSON.stringify(emptyDeviceWorkface())
  const storage = { getItem: () => raw, setItem: () => { throw new Error('Original device write unavailable') } }
  const local = createLocalDrafts(() => storage)
  expect(getDeviceWorkface().snapshot().issue).toBeNull()
  await expect(submitMobileQuestionReply(local, sid, f.client, { ...target, answers: held.input.answers }, () => {})).rejects.toThrow('尚未持久保存')
  expect(f.reply).not.toHaveBeenCalled(); expect(local.questions.get(key)).toMatchObject({ phase: 'rejected', input: { answers: held.input.answers } })
  expect(local.saveIssue).toContain('尚未持久保存'); expect(getDeviceWorkface().snapshot().issue).toBeNull()
})
it('actual MobileApp edits two answers, copies a plain answer, opens the same original terminal in watch mode and retains drafts/unknown on return', async () => {
  const f = questionFixture(), local = createLocalDrafts(); local.questions.set(key, structuredClone(held)); await local.save()
  await getDeviceWorkface().updateNavigation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' })
  const platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原连接' }} platform={platform}/>)
  await click(button(view.element, 'Keep original')); await type(view.element, '  第二题答案\n保留空白  ')
  await click(button(view.element, 'Copy answer: 补充说明')); expect(copy.mock.calls[0]![0]).toBe('  第二题答案\n保留空白  ')
  const draft = structuredClone(record().questionDrafts), frozen = structuredClone(attempt())
  await click(button(view.element, '打开原终端'))
  expect(view.element.querySelector('.mobile-terminal')?.getAttribute('data-control')).toBe('watch')
  expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).selectedSessionId).toBe(sid)
  expect(f.write).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.rpc.mock.calls.some(([method]) => method === 'agent.question.reply' || method.includes('goal.pause'))).toBe(false)
  await click(button(view.element, '控制终端')); await click(button(view.element, '终端 Esc'))
  await vi.waitFor(() => expect(f.write).toHaveBeenCalledExactlyOnceWith({ agentSessionId: sid, expectedRun: { runId: 'run-original' }, data: '\u001b', source: 'user' }))
  await click(button(view.element, '返回对话'))
  expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: 补充说明"]')!.value).toBe('  第二题答案\n保留空白  ')
  expect(record().questionDrafts).toEqual(draft); expect(attempt()).toEqual(frozen)
  expect(view.element.querySelector('.agent-question__original')?.textContent).toContain('original-runtime')
})
it('same-source native answers update the card while preserving complete unknown and diagnostic; a previously confirmed record is untouched', async () => {
  const f = questionFixture(), local = createLocalDrafts(); local.questions.set(key, structuredClone(held)); await local.save()
  const platform = createBrowserPlatform(), view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={platform} onShowTerminal={vi.fn()}/>)
  for (const answer of ['Original frozen answer', 'Different native answer']) {
    f.setPage({ ...page, items: [...page.items, { id: 'native-answer', kind: 'user-message', contentParts: [], questionAnswers: [{ questionId: 'first', answer }, { questionId: 'second', answer: 'Recorded second answer' }] }] })
    await refresh(view.element); expect(view.element.textContent).toContain('Answered'); expect(attempt()).toEqual(held)
    expect(view.element.textContent).toContain('original reply operation remains unconfirmed'); expect(view.element.textContent).toContain(held.diagnostic.message)
  }
  const confirmed = { ...held, phase: 'confirmed' as const }, owner = createLocalDrafts(); owner.questions.set(key, confirmed); await owner.save()
  expect(await reconcileMobileQuestionReplies(owner, sid)).toBe(false); expect(owner.questions.get(key)).toBe(confirmed)
})
it('only exact original whole-operation notApplied can release unknown; Host/Run/Runtime/operation and foreign SID never do', async () => {
  const f = questionFixture(), local = createLocalDrafts(); local.questions.set(key, structuredClone(held)); await local.save()
  const session = f.sessions.get(sid)!, negative = { ...session, promptCompletionAdmission: { operationId: 'original-phase', submissionId: held.input.operationId, startByte: 0, endByte: 10, notApplied: true, intent: { run: session.run, ownerInstanceId: 'owner', prompt: 'original', plan: { kind: 'single-phase' as const, data: 'original' } } } }
  for (const wrong of [{ ...negative, hostId: 'other-host' }, { ...negative, run: { runId: 'other-run' } }, { ...negative, agentSessionId: 'other' }, { ...negative, promptCompletionAdmission: { ...negative.promptCompletionAdmission, submissionId: 'other-operation' } }]) { expect(await reconcileMobileQuestionReplies(local, sid, wrong, held.runtimeId)).toBe(false); expect(local.questions.get(key)).toEqual(held) }
  expect(await reconcileMobileQuestionReplies(local, sid, negative, 'other-runtime')).toBe(false)
  expect(await reconcileMobileQuestionReplies(local, sid, negative, held.runtimeId)).toBe(true); expect(local.questions.get(key)?.phase).toBe('rejected')
  const unbound = { ...held, runtimeId: null }; local.questions.set(key, unbound); expect(await reconcileMobileQuestionReplies(local, sid, negative, held.runtimeId)).toBe(false); expect(local.questions.get(key)).toBe(unbound)
})
it('keeps editing/terminal/clipboard failure available after device save failure and ignores clipboard callbacks after another SID/Host/Run/source', async () => {
  const f = questionFixture(), platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(false), showTerminal = vi.fn()
  const surface = (id = sid) => <MobileConversationSurface client={f.client} agentSessionId={id} connection={{ state: 'connected' as const, message: 'connected' }} platform={platform} onShowTerminal={showTerminal}/>
  const view = await mount(surface()); await click(button(view.element, 'Keep original')); await type(view.element, 'Original answer'); await click(button(view.element, 'Copy answer: 补充说明')); expect(view.element.textContent).toContain('Retry copy')
  const set = localStorage.setItem.bind(localStorage); vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (key === DEVICE_WORKFACE_KEY) throw new Error('Device save unavailable'); return set(key, value) })
  await type(view.element, 'Unsaved answer retained'); await vi.waitFor(() => expect(view.element.textContent).toContain('尚未持久保存'))
  expect(button(view.element, '发送答案').disabled).toBe(false)
  await click(button(view.element, '发送答案')); expect(f.reply).not.toHaveBeenCalled()
  expect(view.element.querySelector('.agent-interaction--async')?.textContent).toContain('尚未持久保存')
  await click(button(view.element, '打开原终端')); expect(showTerminal).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled()
  const pending = deferred<boolean>(); copy.mockImplementationOnce(() => pending.promise); await click(button(view.element, 'Copy answer: 补充说明'))
  const other = f.sessions.get('other')!; f.sessions.set('other', { ...other, hostId: 'other-host', run: { runId: 'other-run' } }); f.setPage({ ...page, agentSessionId: 'other', source: { ...page.source, nativeSessionId: 'other-source' } })
  await view.render(surface('other')); await act(async () => pending.resolve(true))
  expect(view.element.querySelector('.agent-interaction--async')?.textContent).not.toContain('Copied'); expect(f.write).not.toHaveBeenCalled()
})

it('actual mobile surface treats changed or unknown current native source as retained viewing while keeping the original draft/copy/navigation', async () => {
  const f = questionFixture(), platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true), show = vi.fn()
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={platform} onShowTerminal={show}/>)
  await type(view.element, 'Kept draft across source changes'); expect(button(view.element, '发送答案')).toBeDefined()
  for (const nativeHandle of [{ kind: 'provider' as const, providerId: 'codex', sessionId: 'changed-native-source' }, undefined]) {
    const { nativeHandle: _previousHandle, ...retained } = f.sessions.get(sid)!
    const next = nativeHandle ? { ...retained, nativeHandle } : retained
    await act(async () => { f.sessions.set(sid, next); f.emit({ type: 'agent-session', session: next }) })
    expect(button(view.element, '打开原终端')).toBeDefined(); expect(view.element.textContent).toContain('准确回复通道暂不可用')
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: 补充说明"]')!.disabled).toBe(false)
    await click(button(view.element, 'Copy answer: 补充说明')); expect(copy.mock.lastCall?.[0]).toBe('Kept draft across source changes')
  }
  await click(button(view.element, '打开原终端')); expect(show).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it.each([target.source.nativeSessionId, 'selected-other-native'])('mounted mobile replies to selected Run member %s with the original operation and separate later drafts', async nativeSessionId => {
  const f = questionFixture({ ...page, source: { ...target.source, nativeSessionId } }), local = createLocalDrafts()
  const original = { ...held, input: { ...held.input, ...f.questionTarget } }
  local.questions.set(f.replyKey, structuredClone(original)); await local.save()
  const session = f.sessions.get(sid)!
  f.sessions.set(sid, { ...session, nativeBinding: { source: 'user-selected', run: session.run, observedAt: session.updatedAt },
    nativeSourceObservation: { state: 'ambiguous', run: session.run, observedAt: session.updatedAt, reason: 'frontend-selection-unconfirmed',
      candidates: [target.source.nativeSessionId, 'selected-other-native'].map(sessionId => ({ kind: 'provider', providerId: 'codex', sessionId })) } })
  f.reply.mockImplementation(async input => {
    expect(attempt(f.replyKey)).toMatchObject({ phase: 'sending', input: original.input })
    return { agentSessionId: input.agentSessionId, source: input.source, recordId: input.recordId,
      questionIds: input.answers.map(answer => answer.questionId), operationId: input.operationId, outcome: 'submitted' }
  }).mockRejectedValueOnce(new Error('Original reply acknowledgement unavailable'))
  const show = vi.fn(), view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} onShowTerminal={show}/>)
  await type(view.element, 'Later answer stays a separate draft')
  await click(button(view.element, '继续原发送'))
  expect(f.reply).toHaveBeenCalledExactlyOnceWith({ ...original.input, agentSessionId: sid, authorHuman: true, sourceChannel: 'question-reply' })
  expect(attempt(f.replyKey)).toMatchObject({ phase: 'unknown', input: original.input })
  await click(button(view.element, '继续原发送'))
  expect(f.reply).toHaveBeenCalledTimes(2)
  expect(f.reply.mock.calls[1]).toEqual(f.reply.mock.calls[0])
  expect(attempt(f.replyKey).phase).toBe('submitted')
  expect(record().questionDrafts.find(([id]: [string]) => id === f.replyKey)?.[1]).toEqual([...original.input.answers, { questionId: 'second', answer: 'Later answer stays a separate draft' }])
  for (const action of [f.write, f.submit, f.respond, show]) expect(action).not.toHaveBeenCalled()
})

it('mounted mobile retains selected-target drafts and original operations when current source facts cannot qualify their exact owner', async () => {
  const f = questionFixture(), local = createLocalDrafts(); local.questions.set(key, structuredClone(held)); await local.save()
  const session = f.sessions.get(sid)!, selected = { ...session,
    nativeBinding: { source: 'user-selected' as const, run: session.run, observedAt: session.updatedAt },
    nativeSourceObservation: { state: 'ambiguous' as const, run: session.run, observedAt: session.updatedAt, reason: 'frontend-selection-unconfirmed',
      candidates: [{ kind: 'provider' as const, providerId: 'codex', sessionId: target.source.nativeSessionId }] } }
  const show = vi.fn(), view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} onShowTerminal={show}/>)
  await type(view.element, 'Preserved across unavailable sources')
  const { candidates: _candidates, ...missingCandidates } = selected.nativeSourceObservation
  const states: AgentMuxAgentSession[] = [
    { ...selected, nativeSourceObservation: { ...selected.nativeSourceObservation, state: 'unknown' } },
    { ...selected, nativeSourceObservation: { ...selected.nativeSourceObservation, state: 'changed' } },
    { ...selected, nativeBinding: { ...selected.nativeBinding, run: { runId: 'old-run' } } },
    { ...selected, nativeSourceObservation: missingCandidates },
    { ...selected, nativeSourceObservation: { ...selected.nativeSourceObservation, candidates: [{ kind: 'provider', providerId: 'codex', sessionId: 'foreign-native' }] } },
    { ...selected, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'foreign-native' },
      nativeSourceObservation: { ...selected.nativeSourceObservation, candidates: [{ kind: 'provider', providerId: 'codex', sessionId: 'foreign-native' }] } }
  ]
  for (const next of states) {
    await act(async () => f.emit({ type: 'agent-session', session: next }))
    expect(view.element.querySelector('[data-question-action="send"]')).toBeNull()
    expect(button(view.element, '打开原终端')).toBeDefined()
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: 补充说明"]')!.value).toBe('Preserved across unavailable sources')
    expect(attempt()).toEqual(held)
    for (const action of [f.reply, f.write, f.submit, f.respond, show]) expect(action).not.toHaveBeenCalled()
  }
  await act(async () => f.emit({ type: 'agent-session', session: { ...selected, nativeSourceObservation: { ...selected.nativeSourceObservation, run: { runId: 'earlier-observation-run' } } } }))
  expect(button(view.element, '继续原发送')).toBeDefined()
  expect(f.reply).not.toHaveBeenCalled(); expect(attempt()).toEqual(held)
})
