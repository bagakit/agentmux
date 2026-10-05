import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import * as questionReplyOwner from '../src/conversation/question-replies'
import { observeMobileQuestionAnswers, replyMobileQuestion } from '../src/conversation/question-replies'
import { createBrowserPlatform } from '../src/platform/browser'
import { DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, evidence, fixture, history, mount, mounted, paste } from './conversation-fixture'

const sid = 'session-original', questionId = 'opaque-question'
const target = { source: history().source, turnId: 'original-turn', recordId: 'original-question' }
const key = questionReplyKey(sid, target)
const page: AgentSessionHistoryPage = { ...history(), nextCursor: null, items: [{ id: target.recordId, turnId: target.turnId,
  kind: 'assistant-message', contentParts: [{ kind: 'text', text: '原始问题正文' }], questionRequest: { delivery: 'async', questions: [{
    id: questionId, prompt: '如何处理原工作面？', options: [{ id: 'keep', label: 'Keep original' }, { id: 'revise', label: 'Revise' }], acceptsText: true
  }] } }] }
const record = () => JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation
const attempt = () => record().questions?.find(([id]: [string]) => id === key)?.[1]
function questionFixture() {
  const f = fixture(); f.setPage(page)
  const original = f.sessions.get(sid)!
  f.sessions.set(sid, { ...original, promptCompletionAdmission: { operationId: 'previous', submissionId: 'original-predecessor', startByte: 0, endByte: 1 } })
  const rpc = vi.fn(async (_method: string, input: any) => ({ agentSessionId: sid, source: input.source, recordId: input.recordId,
    questionIds: input.answers.map((answer: any) => answer.questionId), operationId: input.operationId, outcome: 'submitted' }))
  Object.assign(f.client, { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }) })
  return { ...f, rpc }
}
function surface(f: ReturnType<typeof questionFixture>) { return <MobileConversationSurface client={f.client} agentSessionId={sid}
  connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} /> }
async function unmount(element: HTMLElement) {
  const index = mounted.findIndex(view => view.element === element), view = mounted.splice(index, 1)[0]!
  await act(async () => view.root.unmount()); element.remove()
}
async function type(element: HTMLElement, value: string) {
  const field = element.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function refresh(element: HTMLElement) {
  if (!element.querySelector('[aria-label="刷新原对话"]')) await click(button(element, 'Show the message tool row'))
  await click(button(element, '刷新原对话'))
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } vi.restoreAllMocks() })

describe('actual mobile native question intent owner', () => {
  it('restores an interrupted in-flight reply as unknown without automatic input and preserves its complete intent for explicit retry', async () => {
    const f = questionFixture(), local = createLocalDrafts()
    const input = { ...target, operationId: 'interrupted-original-operation', expectedRun: { runId: 'run-original' }, afterSubmissionId: 'original-frozen-predecessor', answers: [{ questionId, answer: 'Keep original' }] }
    local.questions.set(key, { phase: 'sending', runtimeId: 'original-runtime', hostId: 'host-original', input }); await local.save()
    const view = await mount(surface(f))
    expect(view.element.textContent).toContain('Reply unconfirmed'); expect(f.rpc).not.toHaveBeenCalled()
    await click(button(view.element, 'Retry original reply')); await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce())
    expect(f.rpc.mock.calls[0]![1]).toEqual({ ...input, agentSessionId: sid, sourceChannel: 'api' })
  })
  it('keeps unknown original answers and edited drafts separately through remount; only explicit retry rejoins the original operation and condition', async () => {
    const f = questionFixture(); f.rpc.mockRejectedValueOnce(new Error('Original receipt lost'))
    const first = await mount(surface(f))
    await click(button(first.element, 'Keep original')); await click(button(first.element, 'Submit reply'))
    await vi.waitFor(() => expect(attempt()?.phase).toBe('unknown'))
    const input = f.rpc.mock.calls[0]![1]
    expect(input).toMatchObject({ ...target, expectedRun: { runId: 'run-original' }, afterSubmissionId: 'original-predecessor', sourceChannel: 'api' })
    await click(button(first.element, 'Revise')); await type(first.element, '另一份未发送草稿\n保留空白  ')
    await vi.waitFor(() => expect(record().questionDrafts?.[0]?.[1]).toEqual([{ questionId, answer: '另一份未发送草稿\n保留空白  ' }]))
    expect(attempt().input.answers).toEqual([{ questionId, answer: 'Keep original' }])
    expect(editor(first.element).getAttribute('contenteditable')).toBe('true')
    await unmount(first.element)
    const restored = await mount(surface(f))
    expect(restored.element.querySelector('textarea')?.value).toBe('另一份未发送草稿\n保留空白  ')
    expect(restored.element.textContent).toContain('Keep original')
    expect(f.rpc).toHaveBeenCalledOnce()
    await act(async () => { f.emit({ type: 'connection-state', state: 'restored', evidence }) })
    expect(f.rpc).toHaveBeenCalledOnce()
    f.sessions.set(sid, { ...f.sessions.get(sid)!, promptCompletionAdmission: { operationId: 'later-phase', submissionId: input.operationId, startByte: 0, endByte: 2 } })
    await click(button(restored.element, 'Retry original reply'))
    await vi.waitFor(() => expect(attempt()?.phase).toBe('submitted'))
    expect(f.rpc.mock.calls[1]![1]).toEqual(input)
    expect(record().questionDrafts?.[0]?.[1]).toEqual([{ questionId, answer: '另一份未发送草稿\n保留空白  ' }])
  })
  it('does not treat a later zero-input refusal as proof that the original unknown reply was not applied', async () => {
    const f = questionFixture()
    f.rpc.mockRejectedValueOnce(new Error('Original receipt unknown')).mockRejectedValueOnce(Object.assign(new Error('Later invocation refused'), { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }))
    const view = await mount(surface(f))
    await click(button(view.element, 'Keep original')); await click(button(view.element, 'Submit reply'))
    await vi.waitFor(() => expect(attempt()?.phase).toBe('unknown'))
    const original = attempt().input
    await click(button(view.element, 'Retry original reply')); await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(attempt()?.phase).toBe('unknown'))
    expect(attempt().input).toEqual(original); expect(button(view.element, 'Revise').disabled).toBe(false)
    await expect(replyMobileQuestion(f.client, sid, 'run-original', { ...target, answers: [{ questionId, answer: 'Revise' }] }, createLocalDrafts(), () => {})).rejects.toThrow('不能替换')
    expect(f.rpc).toHaveBeenCalledTimes(2)
  })
  it('settles unknown only from the same original whole-operation Core fact and keeps edited drafts through remount until explicit Send', async () => {
    const f = questionFixture(); f.rpc.mockRejectedValueOnce(new Error('Original receipt unknown'))
    const first = await mount(surface(f))
    await click(button(first.element, 'Keep original')); await click(button(first.element, 'Submit reply'))
    await vi.waitFor(() => expect(attempt()?.phase).toBe('unknown'))
    const original = attempt().input
    await click(button(first.element, 'Revise')); await type(first.element, 'New answer remains unsent')
    const frozen = f.sessions.get(sid)!, negative = { ...frozen, updatedAt: frozen.updatedAt + 1,
      promptCompletionAdmission: { operationId: 'original-native-phase', submissionId: original.operationId, startByte: 0, endByte: 20,
        notApplied: true, intent: { run: frozen.run, ownerInstanceId: 'original-native-owner', prompt: 'original', plan: { kind: 'single-phase' as const, data: 'original' } } } }
    // Different Run/operation/Host/Runtime and independent redraw cannot discharge the held original.
    for (const session of [{ ...negative, run: { runId: 'another-run' } }, { ...negative, hostId: 'another-host' },
      { ...negative, promptCompletionAdmission: { ...negative.promptCompletionAdmission, submissionId: 'another-operation' } },
      { ...negative, promptCompletionAdmission: { ...negative.promptCompletionAdmission, frameRefresh: { operationId: 'redraw', acknowledged: false, notApplied: true as const,
        inputByteRange: { startByte: 0, endByte: 1 }, outputCursorBytes: 0, resizeRevision: 0, nativeSourceId: 'native-original' } } }]) {
      expect(await observeMobileQuestionAnswers(createLocalDrafts(), sid, page, session, 'original-runtime')).toBe(false)
      expect(attempt()?.phase).toBe('unknown')
    }
    expect(await observeMobileQuestionAnswers(createLocalDrafts(), sid, page, negative, 'another-runtime')).toBe(false)
    const legacy = createLocalDrafts()
    legacy.questions.set(key, { ...legacy.questions.get(key)!, runtimeId: null })
    expect(await observeMobileQuestionAnswers(legacy, sid, page, negative, 'original-runtime')).toBe(false)
    expect(legacy.questions.get(key)?.phase).toBe('unknown')
    await act(async () => { f.sessions.set(sid, negative); f.emit({ type: 'agent-session', session: negative }) })
    await vi.waitFor(() => expect(attempt()?.phase).toBe('rejected'))
    expect(f.rpc).toHaveBeenCalledOnce(); expect(first.element.querySelector('textarea')?.value).toBe('New answer remains unsent')
    await unmount(first.element); const restored = await mount(surface(f))
    expect(restored.element.querySelector('textarea')?.value).toBe('New answer remains unsent'); expect(f.rpc).toHaveBeenCalledOnce()
    await click(button(restored.element, 'Submit reply')); await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2))
    expect(f.rpc.mock.calls[1]![1]).toMatchObject({ answers: [{ questionId, answer: 'New answer remains unsent' }], afterSubmissionId: original.operationId })
    expect(f.rpc.mock.calls[1]![1].operationId).not.toBe(original.operationId)
  })
  it('settles the exact original Core refusal already cached before the RPC callback is lost, without a read or replay', async () => {
    const f = questionFixture(), pending = deferred<any>(); f.rpc.mockImplementationOnce(() => pending.promise)
    const view = await mount(surface(f)); await click(button(view.element, 'Keep original')); await click(button(view.element, 'Submit reply'))
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce())
    const input = f.rpc.mock.calls[0]![1], frozen = f.sessions.get(sid)!, negative = { ...frozen, updatedAt: frozen.updatedAt + 1,
      promptCompletionAdmission: { operationId: 'original-phase', submissionId: input.operationId, startByte: 0, endByte: 20, notApplied: true,
        intent: { run: frozen.run, ownerInstanceId: 'original-owner', prompt: 'original', plan: { kind: 'single-phase' as const, data: 'original' } } } }
    await act(async () => { f.sessions.set(sid, negative); f.emit({ type: 'agent-session', session: negative }) })
    expect(attempt()?.phase).toBe('sending')
    const reads = f.readHistory.mock.calls.length
    await act(async () => pending.reject(new Error('Original RPC reply lost')))
    await vi.waitFor(() => expect(attempt()?.phase).toBe('rejected'))
    expect(f.readHistory.mock.calls.length).toBe(reads); expect(f.rpc).toHaveBeenCalledOnce()
    expect(attempt().input.operationId).toBe(input.operationId); expect(button(view.element, 'Submit reply').disabled).toBe(false)
  })
  it('does not scan device question intents for ordinary unsent composer edits', async () => {
    const f = questionFixture(), observe = vi.spyOn(questionReplyOwner, 'observeMobileQuestionAnswers')
    const view = await mount(surface(f)), observations = observe.mock.calls.length
    expect(observations).toBeGreaterThan(0)
    await paste(view.element, 'Ordinary unsent message keeps the question observer quiet')
    await vi.waitFor(() => expect(JSON.stringify(record())).toContain('Ordinary unsent message'))
    expect(observe.mock.calls.length).toBe(observations); expect(f.rpc).not.toHaveBeenCalled()
  })
  it('allows a fresh answer only after that original invocation was proven completely unapplied', async () => {
    const f = questionFixture()
    f.rpc.mockRejectedValueOnce(Object.assign(new Error('Original input was not applied'), { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }))
    const view = await mount(surface(f))
    await click(button(view.element, 'Keep original')); await click(button(view.element, 'Submit reply'))
    await vi.waitFor(() => expect(attempt()?.phase).toBe('rejected'))
    await click(button(view.element, 'Revise')); await click(button(view.element, 'Submit reply'))
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2))
    expect(f.rpc.mock.calls[1]![1].answers).toEqual([{ questionId, answer: 'Revise' }])
    expect(f.rpc.mock.calls[1]![1].operationId).not.toBe(f.rpc.mock.calls[0]![1].operationId)
  })
  it('keeps exact native confirmation when the original dispatched callback later fails, without matching literal answer text or foreign source', async () => {
    const f = questionFixture(), pending = deferred<any>(); f.rpc.mockImplementationOnce(() => pending.promise)
    const view = await mount(surface(f)); await click(button(view.element, 'Keep original')); await click(button(view.element, 'Submit reply'))
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce())
    const answer = { id: 'native-recorded-answer', kind: 'user-message' as const, contentParts: [{ kind: 'text' as const, text: 'Keep original' }], questionAnswers: [{ questionId, answer: 'Keep original' }] }
    f.setPage({ ...page, source: { ...page.source, nativeSessionId: 'foreign-native' }, items: [...page.items, answer] })
    await refresh(view.element); expect(attempt()?.phase).toBe('sending')
    f.setPage({ ...page, items: [...page.items, { ...answer, questionAnswers: [{ questionId: 'other-question', answer: 'Keep original' }] }] })
    await refresh(view.element); expect(attempt()?.phase).toBe('sending')
    f.setPage({ ...page, items: [...page.items, answer] }); await refresh(view.element)
    await vi.waitFor(() => expect(attempt()?.phase).toBe('confirmed'))
    await act(async () => pending.reject(new Error('Late callback failure')))
    expect(attempt()?.phase).toBe('confirmed'); expect(f.rpc).toHaveBeenCalledOnce()
    const frozen = f.sessions.get(sid)!, original = attempt().input
    const negative = { ...frozen, promptCompletionAdmission: { operationId: 'original-phase', submissionId: original.operationId, startByte: 0, endByte: 20,
      notApplied: true, intent: { run: frozen.run, ownerInstanceId: 'native-owner', prompt: 'original', plan: { kind: 'single-phase' as const, data: 'original' } } } }
    expect(await observeMobileQuestionAnswers(createLocalDrafts(), sid, page, negative, 'original-runtime')).toBe(false)
    expect(attempt()?.phase).toBe('confirmed')
  })
  it('does not dispatch a competing unknown operation from a stale mounted page; both original and edited answers remain recoverable', async () => {
    const f = questionFixture(), view = await mount(surface(f))
    await click(button(view.element, 'Revise'))
    const other = createLocalDrafts()
    other.questions.set(key, { phase: 'unknown', runtimeId: 'original-runtime', hostId: 'host-original', input: {
      ...target, operationId: 'other-original-operation', expectedRun: { runId: 'run-original' }, afterSubmissionId: null, answers: [{ questionId, answer: 'Keep original' }]
    } }); await other.save()
    await click(button(view.element, 'Submit reply'))
    expect(f.rpc).not.toHaveBeenCalled()
    expect(attempt().input.operationId).toBe('other-original-operation')
    expect(record().conflicts).toContainEqual(expect.objectContaining({ bucket: 'questions', key, value: expect.objectContaining({ input: expect.objectContaining({ answers: [{ questionId, answer: 'Revise' }] }) }) }))
  })
  it('cannot confirm another managed Session intent that shares the same native source and question', async () => {
    const f = questionFixture(), local = createLocalDrafts(), foreignKey = questionReplyKey('another-managed-session', target)
    const input = { ...target, operationId: 'same-original-operation', expectedRun: { runId: 'run-original' }, afterSubmissionId: null, answers: [{ questionId, answer: 'Keep original' }] }
    local.questions.set(foreignKey, { phase: 'unknown', runtimeId: 'original-runtime', hostId: 'host-original', input }); await local.save()
    f.setPage({ ...page, items: [...page.items, { id: 'native-answer', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Keep original' }], questionAnswers: input.answers }] })
    const frozen = f.sessions.get(sid)!
    f.sessions.set(sid, { ...frozen, promptCompletionAdmission: { operationId: 'native-phase', submissionId: input.operationId, startByte: 0, endByte: 20, notApplied: true,
      intent: { run: frozen.run, ownerInstanceId: 'original-owner', prompt: 'original', plan: { kind: 'single-phase', data: 'original' } } } })
    const view = await mount(surface(f))
    expect(view.element.textContent).toContain('Keep original')
    expect(record().questions.find(([id]: [string]) => id === foreignKey)[1].phase).toBe('unknown'); expect(f.rpc).not.toHaveBeenCalled()
    // A negative Core fact is scoped to the same bucket even without a native answer.
    expect(await observeMobileQuestionAnswers(createLocalDrafts(), sid, page, f.sessions.get(sid), 'original-runtime')).toBe(false)
    expect(record().questions.find(([id]: [string]) => id === foreignKey)[1].phase).toBe('unknown')
  })
  it('retains the old answer for export when a pending callback returns after device-record replacement, without writing into the imported record', async () => {
    const f = questionFixture(), pending = deferred<any>(); f.rpc.mockImplementationOnce(() => pending.promise)
    const view = await mount(surface(f)); await click(button(view.element, 'Keep original')); await click(button(view.element, 'Submit reply'))
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce())
    const input = f.rpc.mock.calls[0]![1]
    await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); const imported = localStorage.getItem(DEVICE_WORKFACE_KEY)
    await act(async () => pending.resolve({ agentSessionId: sid, source: input.source, recordId: input.recordId, questionIds: [questionId], operationId: input.operationId, outcome: 'submitted' }))
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(imported)
    expect(view.element.textContent).toContain('工作面已被替换')
    const platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
    await view.render(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={platform} />)
    await click(button(view.element, '复制本页保全备份'))
    expect(JSON.parse(copy.mock.calls[0]![0]).workface.conversation.questions[0][1].input).toEqual(expect.objectContaining({ operationId: input.operationId, answers: input.answers }))
  })
})

it('holds a legacy unknown Runtime despite an exact current refusal and only retries its original frozen reply on explicit action', async () => {
  const f = questionFixture(), local = createLocalDrafts()
  const input = { ...target, operationId: 'legacy-original-operation', expectedRun: { runId: 'run-original' }, afterSubmissionId: 'legacy-original-predecessor', answers: [{ questionId, answer: 'Keep original' }] }
  local.questions.set(key, { input, phase: 'unknown', hostId: 'host-original', runtimeId: null }); await local.save()
  const frozen = f.sessions.get(sid)!
  f.sessions.set(sid, { ...frozen, promptCompletionAdmission: { submissionId: input.operationId, operationId: 'original-native-phase', startByte: 0, endByte: 20, notApplied: true,
    intent: { run: frozen.run, ownerInstanceId: 'current-native-owner', prompt: 'original', plan: { kind: 'single-phase', data: 'original' } } } })
  const view = await mount(surface(f))
  expect(attempt()?.phase).toBe('unknown'); expect(f.rpc).not.toHaveBeenCalled()
  await click(button(view.element, 'Revise')); await type(view.element, 'A new draft cannot release the unknown Runtime')
  expect(attempt()?.phase).toBe('unknown')
  await click(button(view.element, 'Retry original reply')); await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce())
  expect(f.rpc.mock.calls[0]![1]).toEqual({ ...input, agentSessionId: sid, sourceChannel: 'api' })
})
