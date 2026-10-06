import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileConversationSurface, type MobileConversationSurfaceProps } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { acceptedPrompt, button, click, deferred, editor, evidence, fixture, history, mount, mounted, paste, plainEnter, session } from './conversation-fixture'

const connected = { state: 'connected' as const, message: '已连接原 Host' }
async function refreshOriginal(element: HTMLElement) {
  const action = [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.getAttribute('aria-label') === '刷新原对话')
  if (!action) await click(button(element, 'Show the message tool row'))
  await click(button(element, '刷新原对话'))
}
const STORAGE = 'agentmux-mobile-workface-v1'
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
function props(f: ReturnType<typeof fixture>): MobileConversationSurfaceProps {
  return { client: f.client, agentSessionId: 'session-original', connection: connected,
    platform: createBrowserPlatform({ clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }) }
}
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.unstubAllGlobals()
})
describe('mounted mobile consumer of the original hosted Session and shared UI', () => {
  it('preserves an editable draft and references without an authorized client', async () => {
    const f = fixture(), attach = vi.fn(), options = props(f)
    const view = await mount(<MobileConversationSurface {...options} onAttach={attach} />)
    await paste(view.element, '待完成的草稿\n原生输入')
    expect(editor(view.element).textContent).toContain('待完成的草稿')
    expect(editor(view.element).textContent).toContain('原生输入')
    await view.render(<MobileConversationSurface {...options} client={null}
      connection={{ state: 'unavailable', message: '尚未授权' }} onAttach={attach} />)
    expect(view.element.textContent).toContain('当前发送暂不可用')
    expect(editor(view.element).textContent).toContain('待完成的草稿')
    expect(editor(view.element).textContent).toContain('原生输入')
    expect(button(view.element, 'Send').disabled).toBe(false)
    await paste(view.element, '离线补充')
    expect(editor(view.element).textContent).toContain('离线补充')
    expect(f.submit).not.toHaveBeenCalled()
    // The optional attachment port remains a local chooser operation owned by the shell.
    await click(button(view.element, 'Reference files for the Agent to read'))
    expect(attach).toHaveBeenCalledOnce()
    // Reading and live input receipt observation each release their own subscription.
    expect(f.unsubscribe).toHaveBeenCalledTimes(2)
    expect(f.disposeHistory).toHaveBeenCalledOnce()
  })

  it('retains native source order and recorded human/peer/unknown authorship; delegates copy and web links', async () => {
    const f = fixture(), copy = vi.fn().mockResolvedValue(undefined), open = vi.fn()
    f.setTimeline({ agentSessionId: 'session-original', revision: 1, items: [
      { id: 'captured-peer', agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), title: 'Input', content: '来自同事', authorAgentSessionId: 'peer' },
      { id: 'captured-human', agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _reshape_fixtureEpoch(0, 0, 2), updatedAt: _reshape_fixtureEpoch(0, 0, 2), title: 'Input', content: '来自本人', authorHuman: true },
      { id: 'captured-unknown', agentSessionId: 'session-original', kind: 'user_message', status: 'failed', source: 'native-hook', createdAt: _reshape_fixtureEpoch(0, 0, 3), updatedAt: _reshape_fixtureEpoch(0, 0, 3), title: 'Input', content: '未记录作者' }
    ] })
    const view = await mount(<MobileConversationSurface {...props(f)} openHttpLink={open}
      platform={createBrowserPlatform({ clipboard: { writeText: copy } })} />)
    expect([...view.element.querySelectorAll('[data-native-record-id]')].map(value => value.getAttribute('data-native-record-id')))
      .toEqual(['native-input', 'native-answer'])
    expect(view.element.textContent).toContain('来自同事')
    expect(view.element.textContent).toContain('来自本人')
    expect(view.element.textContent).toContain('未记录作者')
    await click(button(view.element, '文档'))
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/docs', expect.objectContaining({ ctrlKey: false }))
    await click(button(view.element, 'Copy message'))
    expect(copy).toHaveBeenCalledExactlyOnceWith('原生输入 [文档](https://example.test/docs)')
    await click(button(view.element, 'Message details'))
    expect(document.body.textContent).toContain('Not recorded · shown as You')
    expect(document.body.textContent).toContain('native-session-original')
    expect(document.body.textContent).toContain('native-input')
    const human = view.element.querySelector<HTMLElement>('[data-message-id="captured:captured-human"]')
    const unknown = view.element.querySelector<HTMLElement>('[data-message-id="captured:captured-unknown"]')
    expect(human).not.toBeNull(); expect(unknown).not.toBeNull()
    await click(button(human!, 'Message details'))
    expect(human!.querySelector('.conversation-input-details__facts')?.textContent).toContain('Recorded authorhuman')
    await click(button(unknown!, 'Message details'))
    expect(unknown!.textContent).toContain('Not recorded · shown as You')
  })

  it('sends one captured condition and preserves unknown delivery without retry on reconnect; settles only its exact receipt', async () => {
    const f = fixture(), original = session()
    original.promptCompletionAdmission = { operationId: 'prior-op', submissionId: 'prior-submission', startByte: 1, endByte: 2 }
    f.sessions.set(original.agentSessionId, original)
    f.submit.mockRejectedValueOnce(Object.assign(new Error('lost after dispatch'), { code: 'STALE_AGENT_SESSION' }))
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    const skillPath = fixturePath('workspace/skill.md')
    await paste(view.element, `[工具](agentmux-skill:${encodeURIComponent(skillPath)}) 保留引用`)
    await act(async () => { editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true, keyCode: 229 })) })
    expect(f.submit).not.toHaveBeenCalled()
    await plainEnter(view.element)
    expect(f.submit).toHaveBeenCalledOnce()
    const input = f.submit.mock.calls[0]![0]
    expect(input).toEqual({ agentSessionId: 'session-original', operationId: expect.any(String), prompt: expect.any(String),
      authorHuman: true, expectedRun: { runId: 'run-original' }, afterSubmissionId: 'prior-submission', execution: 'default' })
    expect(input.prompt.trim()).toBe(`${skillPath} 保留引用`)
    expect(input.operationId).not.toBe('')
    expect(editor(view.element).textContent).toContain('保留引用')
    expect(view.element.textContent).toContain('发送结果未确认')
    expect(button(view.element, 'Send').disabled).toBe(false)
    await act(async () => { f.emit({ type: 'connection-state', state: 'lost', evidence }); f.emit({ type: 'connection-state', state: 'restored', evidence }) })
    expect(f.submit).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts[0][1].phase).toBe('unknown')
    f.setTimeline({ agentSessionId: 'session-original', revision: 2, items: [
      { id: 'prompt:other-operation', agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _reshape_fixtureEpoch(0, 0, 2), updatedAt: _reshape_fixtureEpoch(0, 0, 2), title: 'Input', content: input.prompt, authorHuman: true }
    ] })
    await refreshOriginal(view.element)
    expect(editor(view.element).textContent).toContain('保留引用')
    expect(button(view.element, 'Send').disabled).toBe(false)
    f.setTimeline({ agentSessionId: 'session-original', revision: 3, items: [
      { id: `prompt:${input.operationId}`, agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _reshape_fixtureEpoch(0, 0, 3), updatedAt: _reshape_fixtureEpoch(0, 0, 3), title: 'Input', content: input.prompt, authorHuman: true }
    ] })
    await refreshOriginal(view.element)
    expect(editor(view.element).textContent).toBe('')
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts[0][1].draft).toBe('')
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts[0][1].phase).toBe('confirmed')
    expect(f.submit).toHaveBeenCalledOnce()
  })

  it.each(['done', 'working'] as const)('explicitly sends two messages against the original %s Run without waiting for a completion probe', async state => {
    const f = fixture(), original = session()
    original.semanticStatus = { state, source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1) }
    f.sessions.set(original.agentSessionId, original)
    f.submit.mockImplementationOnce(async input => {
      const admitted = { ...original, promptCompletionAdmission: { submissionId: input.operationId, operationId: 'native-phase', startByte: 0, endByte: 8, acknowledged: true } }
      f.sessions.set(original.agentSessionId, admitted)
      f.emit({ type: 'agent-session', session: admitted })
      return acceptedPrompt(input)
    })
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '第一条消息')
    await click(button(view.element, 'Send'))
    expect(editor(view.element).textContent).toBe('')
    await paste(view.element, '第二条消息')
    await click(button(view.element, 'Send'))
    expect(f.submit).toHaveBeenCalledTimes(2)
    const [first, second] = f.submit.mock.calls.map(call => call[0])
    expect(first).toMatchObject({ expectedRun: original.run, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    expect(second).toMatchObject({ expectedRun: original.run, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    expect(second).not.toHaveProperty('afterSubmissionId')
    expect(second!.operationId).not.toBe(first!.operationId)
    expect(editor(view.element).textContent).toBe('')
  })

  it('keeps plain Enter separate from explicit Send and Cmd+Enter', async () => {
    const f = fixture(), view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '普通输入')
    await act(async () => editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
    expect(f.submit).toHaveBeenCalledOnce()
    expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('allowUncertainTurn')
    expect(f.submit.mock.calls[0]![0].execution).toBe('default')
    await paste(view.element, '明确steer')
    await act(async () => editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', metaKey: true })))
    expect(f.submit).toHaveBeenCalledTimes(2)
    expect(f.submit.mock.calls[1]![0]).toMatchObject({ admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
  })

  it('keeps a pre-input turn-boundary refusal editable with full-width recovery, without treating it as unknown delivery', async () => {
    const f = fixture(), terminal = vi.fn()
    f.submit.mockRejectedValueOnce(Object.assign(new Error('The previous turn has not been confirmed complete.'), { code: 'AGENT_TURN_END_UNCONFIRMED' }))
    const view = await mount(<MobileConversationSurface {...props(f)} onShowTerminal={terminal} />)
    await paste(view.element, '第二条保留')
    await click(button(view.element, 'Send'))
    expect(editor(view.element).textContent).toBe('第二条保留')
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(view.element.querySelector('.composer .mobile-send-status')).toBeNull()
    expect(view.element.querySelector('.mobile-send-status')?.getAttribute('data-phase')).toBe('rejected')
    await click(button(view.element, '终端'))
    expect(terminal).toHaveBeenCalledOnce()
    await click(button(view.element, 'Send'))
    expect(f.submit).toHaveBeenCalledTimes(2)
    expect(editor(view.element).textContent).toBe('')
  })

  it('keeps authoritative rejection editable and retries only by an explicit new action', async () => {
    const f = fixture()
    f.submit.mockRejectedValueOnce(Object.assign(new Error('Agent prompt exceeds its maximum byte length.'), { code: 'INVALID_AGENT_PROMPT' }))
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '明确拒绝后保留')
    await click(button(view.element, 'Send'))
    expect(editor(view.element).textContent).toBe('明确拒绝后保留')
    expect(view.element.querySelector('.mobile-send-status')?.getAttribute('data-phase')).toBe('rejected')
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(f.submit).toHaveBeenCalledOnce()
    await click(button(view.element, 'Send'))
    expect(f.submit).toHaveBeenCalledTimes(2)
    expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0])
    expect(editor(view.element).textContent).toBe('')
  })

  it('keeps a fresh read-only preparation refusal editable without unlocking a previously unknown operation', async () => {
    const f = fixture()
    f.submit.mockRejectedValueOnce(Object.assign(new Error('This call ended during read-only preparation before attempting input.'), {
      code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
    }))
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '准备失败但原Agent健康')
    await click(button(view.element, 'Send'))
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(editor(view.element).textContent).toBe('准备失败但原Agent健康')
    f.submit.mockRejectedValueOnce(Object.assign(new Error('submit phase not applied after payload'), {
      code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
    }))
    await click(button(view.element, 'Send'))
    expect(button(view.element, 'Send').disabled).toBe(false)
    await refreshOriginal(view.element)
    expect(f.submit).toHaveBeenCalledTimes(2)
    expect(button(view.element, 'Send').disabled).toBe(false)
  })

  it.each(['success', 'failure'] as const)('binds a late %s receipt to its original operation and preserves edits in both mounted Sessions', async outcome => {
    const f = fixture(), ack = deferred<Awaited<ReturnType<typeof acceptedPrompt>>>()
    f.submit.mockImplementationOnce(() => ack.promise)
    const options = props(f), view = await mount(<MobileConversationSurface {...options} />)
    await paste(view.element, '原会话提交')
    await click(button(view.element, 'Send'))
    await paste(view.element, '提交后的原会话补充')
    await view.render(<MobileConversationSurface {...options} agentSessionId="other" />)
    await paste(view.element, '另一个会话新草稿')
    await act(async () => outcome === 'success' ? ack.resolve(await acceptedPrompt(f.submit.mock.calls[0]![0])) : ack.reject(new Error('original mounted late failure')))
    expect(editor(view.element).textContent).toBe('另一个会话新草稿')
    await view.render(<MobileConversationSurface {...options} />)
    expect(editor(view.element).textContent).toContain('原会话提交')
    expect(editor(view.element).textContent).toContain('提交后的原会话补充')
    expect(f.submit).toHaveBeenCalledOnce()
    expect(f.submit.mock.calls[0]![0].agentSessionId).toBe('session-original')
    const stored = JSON.parse(localStorage.getItem(STORAGE)!).conversation
    expect(stored.attempts.find(([key]: [string]) => key === JSON.stringify(['draft', 'session-original']))[1]).toMatchObject({
      operationId: f.submit.mock.calls[0]![0].operationId, runId: 'run-original', phase: outcome === 'success' ? 'confirmed' : 'unknown'
    })
    expect(stored.drafts.find(([key]: [string]) => key === JSON.stringify(['draft', 'other']))[1]).toBe('另一个会话新草稿')
  })

  it('does not resend an accepted payload when only its submit phase was rejected', async () => {
    const f = fixture()
    f.submit.mockRejectedValueOnce(Object.assign(new Error('The original prompt phase was not applied. Its accepted payload is kept; this input range cannot be reused.'),
      { code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', detail: 'not_applied' }))
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '已接受的 payload 不能重投')
    await plainEnter(view.element)
    const input = f.submit.mock.calls[0]![0], value = session()
    value.terminalPromptSubmission = { run: value.run, submissionId: input.operationId, promptDigest: 'actual-core-digest', outputCursorBytes: 0,
      payload: { operationId: 'payload-original', inputByteRange: { startByte: 0, endByte: 20 }, acknowledged: true },
      submit: { operationId: 'submit-original', inputByteRange: { startByte: 20, endByte: 21 }, acknowledged: false, notApplied: true } }
    await act(async () => f.emit({ type: 'agent-session', session: value }))
    expect(view.element.textContent).toContain('发送结果未确认')
    expect(editor(view.element).textContent).toBe('已接受的 payload 不能重投')
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(f.submit).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts[0][1].phase).toBe('unknown')
  })

  it('does not resend an accepted payload when a pending interaction interrupts submit', async () => {
    const f = fixture(), ack = deferred<void>()
    f.submit.mockImplementationOnce(() => ack.promise)
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '交互之前已接受的 payload')
    await plainEnter(view.element)
    const input = f.submit.mock.calls[0]![0], value = session()
    value.terminalPromptSubmission = { run: value.run, submissionId: input.operationId, promptDigest: 'actual-core-digest', outputCursorBytes: 0,
      payload: { operationId: 'payload-original', inputByteRange: { startByte: 0, endByte: 20 }, acknowledged: true },
      submit: { operationId: 'submit-original', inputByteRange: { startByte: 20, endByte: 21 }, acknowledged: false } }
    value.pendingInteraction = { request: { kind: 'permission', agentSessionId: value.agentSessionId, id: 'request-after-payload', title: 'Payload 后出现的请求', evidence,
      options: [{ id: 'original-allow', label: '允许原请求', kind: 'allow-once' }] } }
    f.sessions.set(value.agentSessionId, value)
    await act(async () => { f.emit({ type: 'agent-session', session: value }); ack.reject(Object.assign(
      new Error('Answer the pending Agent interaction before submitting another prompt.'), { code: 'AGENT_INTERACTION_PENDING' })) })
    expect(view.element.textContent).toContain('Payload 后出现的请求')
    expect(view.element.textContent).toContain('发送结果未确认')
    expect(editor(view.element).textContent).toBe('交互之前已接受的 payload')
    expect(button(view.element, 'Send').disabled).toBe(false)
    // Even disappearance of the interaction cannot turn a phase error into whole-intent nonapplication.
    const settled = { ...value }
    delete settled.pendingInteraction
    f.sessions.set(value.agentSessionId, settled)
    await act(async () => f.emit({ type: 'agent-session', session: settled }))
    await refreshOriginal(view.element)
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(f.submit).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts[0][1].phase).toBe('unknown')
  })

  it('unlocks an unknown input only when Core proves this original intent was entirely unapplied', async () => {
    const f = fixture()
    f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'runtime-original', ownerInstanceId: 'original-core-instance', availability: 'connected' })
    f.submit.mockRejectedValueOnce(Object.assign(new Error('The original prompt phase was not applied.'),
      { code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', detail: 'not_applied' }))
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '原意图的未应用事实')
    await plainEnter(view.element)
    const input = f.submit.mock.calls[0]![0], value = session()
    const payloadEnd = new TextEncoder().encode(input.prompt).byteLength, submitEnd = payloadEnd + new TextEncoder().encode('\r').byteLength
    value.promptCompletionAdmission = { submissionId: input.operationId, operationId: 'native-phase-original', startByte: 0, endByte: submitEnd,
      notApplied: true, intent: { run: value.run, ownerInstanceId: 'original-core-instance', prompt: input.prompt,
        plan: { kind: 'render-then-submit', payload: input.prompt, renderedText: input.prompt, submit: '\r' } } }
    value.terminalPromptSubmission = { run: value.run, submissionId: input.operationId, promptDigest: 'controlled-original-digest', outputCursorBytes: 0,
      payload: { operationId: 'native-phase-original', inputByteRange: { startByte: 0, endByte: payloadEnd }, acknowledged: false },
      submit: { operationId: 'submit-original', inputByteRange: { startByte: payloadEnd, endByte: submitEnd }, acknowledged: false } }
    const draftKey = JSON.stringify(['draft', value.agentSessionId])
    const attempts = () => new Map(new DeviceWorkfaceStore(() => localStorage).snapshot().record.conversation.attempts)
    await vi.waitFor(() => expect(attempts().get(draftKey)?.phase).toBe('unknown'))
    const originalRequest = structuredClone(attempts().get(draftKey)!.request)
    expect(originalRequest).toMatchObject({ runtimeId: 'runtime-original', condition: { expectedRun: value.run, afterSubmissionId: null } })
    const unknown = async (candidate: ReturnType<typeof session>) => {
      f.sessions.set(candidate.agentSessionId, candidate)
      await act(async () => f.emit({ type: 'agent-session', session: candidate }))
      expect(view.element.textContent).not.toContain('Core 已确认原输入未应用')
      expect(attempts().get(draftKey)).toMatchObject({ operationId: input.operationId, phase: 'unknown', request: originalRequest })
      expect(editor(view.element).textContent).toBe('原意图的未应用事实')
      expect(button(view.element, 'Send').disabled).toBe(false)
      expect(f.submit).toHaveBeenCalledOnce()
    }
    const missingSubmission = { ...value }; delete missingSubmission.terminalPromptSubmission
    await unknown(missingSubmission)
    await unknown({ ...value, promptCompletionAdmission: { ...value.promptCompletionAdmission, submissionId: 'another-operation' },
      terminalPromptSubmission: { ...value.terminalPromptSubmission, submissionId: 'another-operation' } })
    const wrongRun = { ...value, promptCompletionAdmission: { ...value.promptCompletionAdmission,
      submissionId: input.operationId, intent: { ...value.promptCompletionAdmission.intent!, run: { runId: 'another-run' } } } }
    await unknown(wrongRun)
    await unknown({ ...value, terminalPromptSubmission: { ...value.terminalPromptSubmission,
      payload: { ...value.terminalPromptSubmission.payload, acknowledged: true },
      submit: { ...value.terminalPromptSubmission.submit, notApplied: true } } })
    f.sessions.set(value.agentSessionId, value)
    await act(async () => f.emit({ type: 'agent-session', session: value }))
    expect(view.element.textContent).toContain('Core 已确认原输入未应用')
    await vi.waitFor(() => expect(attempts().get(draftKey)).toMatchObject({ phase: 'rejected', request: originalRequest }))
    expect(editor(view.element).textContent).toBe('原意图的未应用事实')
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(f.submit).toHaveBeenCalledOnce()
    await plainEnter(view.element)
    expect(f.submit).toHaveBeenCalledTimes(2)
    const next = f.submit.mock.calls[1]![0]
    expect(next).toEqual({ ...input, operationId: expect.any(String), afterSubmissionId: input.operationId })
    expect(next.operationId).not.toBe(input.operationId)
    await vi.waitFor(() => expect(attempts().get(JSON.stringify(['refused-prompt', value.agentSessionId, input.operationId])))
      .toMatchObject({ operationId: input.operationId, phase: 'rejected', draft: '原意图的未应用事实', request: originalRequest }))
  })

  it('answers the original permission option once and keeps an unknown request unavailable when another request replaces it', async () => {
    const f = fixture(), value = session(), answer = deferred<void>()
    value.pendingInteraction = { request: { kind: 'permission', agentSessionId: value.agentSessionId, id: 'request-original', title: '原请求', evidence,
      options: [{ id: 'exact-allow', label: '原选项', kind: 'allow-once' }, { id: 'exact-deny', label: '拒绝原请求', kind: 'reject-once' }] } }
    f.sessions.set(value.agentSessionId, value); f.respond.mockImplementationOnce(() => answer.promise)
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await click(button(view.element, '原选项'))
    expect(f.respond).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' },
      response: { kind: 'permission', requestId: 'request-original', decision: { outcome: 'selected', optionId: 'exact-allow' } } })
    const newer = { ...value, pendingInteraction: { request: { ...value.pendingInteraction.request, id: 'request-new', title: '新请求' } } }
    f.sessions.set(value.agentSessionId, newer)
    await act(async () => f.emit({ type: 'agent-session', session: newer }))
    await act(async () => answer.reject(new Error('transport lost')))
    expect(view.element.textContent).toContain('新请求')
    expect(button(view.element, '原选项').disabled).toBe(false)
    // Returning to the still-current original tuple cannot accidentally reopen its unknown answer.
    await act(async () => f.emit({ type: 'agent-session', session: value }))
    expect(view.element.textContent).toContain('答复回执未知')
    expect(view.element.querySelector('[data-request-id="request-original"]')).not.toBeNull()
    expect([...view.element.querySelectorAll<HTMLButtonElement>('[data-request-id="request-original"] button')].map(item => item.disabled)).toEqual([])
    expect(f.respond).toHaveBeenCalledOnce()
  })

  it('retains reading when a history probe fails and accepts healthy Session input without gating on that probe', async () => {
    const f = fixture(), view = await mount(<MobileConversationSurface {...props(f)} />)
    f.readHistory.mockRejectedValueOnce(new Error('native transcript temporarily unavailable'))
    await refreshOriginal(view.element)
    expect([...view.element.querySelectorAll('[data-native-record-id]')].map(value => value.getAttribute('data-native-record-id')))
      .toEqual(['native-input', 'native-answer'])
    expect(view.element.textContent).toContain('native transcript temporarily unavailable')
    await paste(view.element, '健康会话继续工作')
    await click(button(view.element, 'Send'))
    expect(f.submit).toHaveBeenCalledOnce()
    f.readHistory.mockResolvedValueOnce({ ...history(), agentSessionId: 'unexpected', items: [{ id: 'wrong', kind: 'assistant-message', contentParts: [{ kind: 'text', text: '错误会话历史' }] }] })
    await refreshOriginal(view.element)
    expect(view.element.textContent).not.toContain('错误会话历史')
    expect([...view.element.querySelectorAll('[data-native-record-id]')].map(value => value.getAttribute('data-native-record-id')))
      .toEqual(['native-input', 'native-answer'])
  })

  it('restores the durable draft, references and original unknown input after a cold remount without reinvoking it', async () => {
    const f = fixture(), receipt = deferred<void>(), options = props(f)
    f.submit.mockImplementationOnce(() => receipt.promise)
    const original = await mount(<MobileConversationSurface {...options} />)
    await paste(original.element, '冷启草稿 [工具](agentmux-skill:%2Foriginal%2Ftool.md)')
    await plainEnter(original.element)
    const input = f.submit.mock.calls[0]![0]
    const saved = JSON.parse(localStorage.getItem(STORAGE)!).conversation
    expect(saved.attempts[0][0]).toBe(JSON.stringify(['draft', 'session-original']))
    expect(saved.attempts[0][1]).toMatchObject({
      operationId: input.operationId, runId: 'run-original', draft: '冷启草稿 [工具](agentmux-skill:%2Foriginal%2Ftool.md)', phase: 'sending',
      inputRequested: true, explicit: false, request: { condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: null }, execution: 'default' }
    })
    const previous = mounted.pop()!
    await act(async () => previous.root.unmount()); previous.element.remove()
    const restored = await mount(<MobileConversationSurface {...options} client={null}
      connection={{ state: 'unavailable', message: '重启后尚未授权' }} />)
    expect(editor(restored.element).textContent).toContain('冷启草稿')
    expect(editor(restored.element).textContent).toContain('工具')
    expect(restored.element.textContent).toContain('重启后的原输入回执未知')
    expect(f.submit).toHaveBeenCalledOnce()
    await restored.render(<MobileConversationSurface {...options} />)
    expect(button(restored.element, 'Send').disabled).toBe(false)
    await paste(restored.element, '冷启后的补充')
    const beforeLate = localStorage.getItem(STORAGE)
    await act(async () => receipt.resolve())
    expect(editor(restored.element).textContent).toContain('冷启后的补充')
    expect(localStorage.getItem(STORAGE)).toBe(beforeLate)
    expect(f.submit).toHaveBeenCalledOnce()
    f.setTimeline({ agentSessionId: 'session-original', revision: 2, items: [
      { id: `prompt:${input.operationId}`, agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'user', createdAt: _reshape_fixtureEpoch(0, 0, 2), updatedAt: _reshape_fixtureEpoch(0, 0, 2), title: 'Prompt', content: input.prompt, authorHuman: true }
    ] })
    await refreshOriginal(restored.element)
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts[0][1].phase).toBe('confirmed')
    expect(editor(restored.element).textContent).toContain('冷启后的补充')
    expect(button(restored.element, 'Send').disabled).toBe(false)
    expect(f.submit).toHaveBeenCalledOnce()
  })

  it('restores an unconfirmed original permission answer as unavailable and never automatically answers on startup', async () => {
    const f = fixture(), value = session(), receipt = deferred<void>()
    value.pendingInteraction = { request: { kind: 'permission', id: 'request-original', agentSessionId: value.agentSessionId, title: '冷启原请求', evidence,
      options: [{ id: 'allow-original', label: '原答复', kind: 'allow-once' }] } }
    f.sessions.set(value.agentSessionId, value); f.respond.mockImplementationOnce(() => receipt.promise)
    const options = props(f), view = await mount(<MobileConversationSurface {...options} />)
    await click(button(view.element, '原答复'))
    const saved = JSON.parse(localStorage.getItem(STORAGE)!).conversation
    expect(saved.responses).toEqual([[JSON.stringify(['session-original', 'run-original', 'request-original']), { phase: 'sending' }]])
    const previous = mounted.pop()!
    await act(async () => previous.root.unmount()); previous.element.remove()
    const restored = await mount(<MobileConversationSurface {...options} />)
    expect(restored.element.querySelector('[data-request-id="request-original"]')).not.toBeNull()
    expect(restored.element.textContent).toContain('重启后的原请求答复回执未知')
    expect(restored.element.querySelector('[data-request-id="request-original"] button')).toBeNull()
    expect(f.respond).toHaveBeenCalledOnce()
    await refreshOriginal(restored.element)
    expect(f.respond).toHaveBeenCalledOnce()
    await act(async () => receipt.resolve())
    expect(restored.element.textContent).toContain('重启后的原请求答复回执未知')
  })

  it('keeps unreadable original draft bytes intact while healthy SDK input and copying remain available', async () => {
    localStorage.setItem(STORAGE, '{unreadable-original-drafts')
    const f = fixture(), copy = vi.fn().mockResolvedValue(undefined)
    const view = await mount(<MobileConversationSurface {...props(f)} platform={createBrowserPlatform({ clipboard: { writeText: copy } })} />)
    expect(view.element.textContent).toContain('原记录尚未覆盖')
    await paste(view.element, '存储坏了仍可编辑')
    expect(localStorage.getItem(STORAGE)).toBe('{unreadable-original-drafts')
    await click(button(view.element, '复制当前草稿'))
    expect(copy).toHaveBeenCalledExactlyOnceWith('存储坏了仍可编辑')
    expect(view.element.textContent).toContain('原记录尚未覆盖')
    await click(button(view.element, 'Send'))
    expect(f.submit).toHaveBeenCalledOnce()
    expect(localStorage.getItem(STORAGE)).toBe('{unreadable-original-drafts')
    expect(view.element.textContent).toContain('原记录尚未覆盖')
  })

  it('preserves previously durable bytes on a failed write, reports the gap, and retries only saving', async () => {
    const f = fixture(), view = await mount(<MobileConversationSurface {...props(f)} />)
    await paste(view.element, '先前保存的草稿')
    const original = localStorage.getItem(STORAGE)
    const originalStorage = localStorage, write = vi.fn(() => { throw new Error('quota exhausted') })
    vi.stubGlobal('localStorage', { getItem: originalStorage.getItem.bind(originalStorage), setItem: write })
    await paste(view.element, '本次未保存的补充')
    expect(editor(view.element).textContent).toContain('本次未保存的补充')
    expect(view.element.textContent).toContain('先前记录仍保留')
    expect(localStorage.getItem(STORAGE)).toBe(original)
    expect(write).toHaveBeenCalled()
    await click(button(view.element, 'Send'))
    expect(f.submit).toHaveBeenCalledOnce()
    expect(localStorage.getItem(STORAGE)).toBe(original)
    expect(view.element.textContent).toContain('先前记录仍保留')
    vi.stubGlobal('localStorage', originalStorage)
    await click(button(view.element, '重试保存'))
    expect(view.element.textContent).not.toContain('本机草稿暂时无法保存')
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.drafts).toEqual([[JSON.stringify(['draft', 'session-original']), '']])
    expect(f.submit).toHaveBeenCalledOnce()
  })
})
