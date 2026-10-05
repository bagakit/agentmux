import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { expandSemanticReferences } from '@agentmux/client-ui'
import { MobileConversationSurface, type MobileConversationSurfaceProps } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, evidence, fixture, mount, mounted, paste, session } from './conversation-fixture'

const key = JSON.stringify(['draft', 'session-original']), op = 'original-mobile-operation'
const body = '[工具](agentmux-skill:%2Fworkspace%2Fskill.md) 原输入', expanded = expandSemanticReferences(body)
const connected = { state: 'connected' as const, message: '已连接原 Host' }
function props(f: ReturnType<typeof fixture>): MobileConversationSurfaceProps {
  return { client: f.client, agentSessionId: 'session-original', connection: connected,
    platform: createBrowserPlatform({ clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }) }
}
function admitted(execution: 'default' | 'immediate' = 'immediate'): AgentMuxAgentSession {
  const value = session()
  value.promptCompletionAdmission = { submissionId: op, operationId: 'original-runtime-input', startByte: 5, endByte: 20,
    intent: { run: value.run, ownerInstanceId: 'original-core', prompt: expanded, execution,
      plan: { kind: 'render-then-submit', payload: expanded, renderedText: expanded, submit: '\r' },
      message: { userContent: expanded, authorHuman: true, sourceDevice: { hostId: 'host-original', deviceId: 'original-phone', name: 'Phone' } } } }
  return value
}
function retainOriginal(draft = body, phase: 'unknown' | 'sending' = 'unknown') {
  getDeviceWorkface().updateConversation({ version: 1, drafts: [[key, draft]], responses: [],
    attempts: [[key, { operationId: op, runId: 'run-original', draft: body, phase }]] })
}
function retry(element: HTMLElement) {
  return [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === '重试原请求')
}
function stored() { return JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!).conversation }
beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.unstubAllGlobals()
})
describe('explicit continuation of the retained original mobile request', () => {
  it.each(['default', 'immediate'] as const)('rejoins restored unknown %s with the original identity/body/mode and keeps the edited draft', async execution => {
    retainOriginal('新的编辑草稿', 'sending')
    const f = fixture(); f.sessions.set('session-original', admitted(execution))
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    expect(f.submit).not.toHaveBeenCalled()
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(retry(view.element)).toBeDefined()
    await click(retry(view.element)!)
    expect(f.submit).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'session-original', operationId: op,
      expectedRun: { runId: 'run-original' }, afterSubmissionId: op, prompt: expanded, authorHuman: true, execution,
      ...(execution === 'immediate' ? { allowUncertainTurn: true } : {}) })
    expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('sourceDevice')
    expect(editor(view.element).textContent).toBe('新的编辑草稿')
    expect(stored().attempts[0][1]).toMatchObject({ operationId: op, runId: 'run-original', draft: '', phase: 'confirmed', inputRequested: true })
    expect(stored().drafts).toEqual([[key, '新的编辑草稿']])
  })

  it('clears only the unchanged original draft using the existing exact receipt owner', async () => {
    retainOriginal(); const f = fixture(); f.sessions.set('session-original', admitted())
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await click(retry(view.element)!)
    expect(editor(view.element).textContent).toBe('')
    expect(stored().drafts).toEqual([[key, '']])
  })

  it('does not dispatch while restoring, refreshing or reconnecting a positive original request', async () => {
    retainOriginal(); const f = fixture(); f.sessions.set('session-original', admitted())
    const view = await mount(<MobileConversationSurface {...props(f)} />)
    await click(button(view.element, '刷新'))
    await act(async () => { f.emit({ type: 'connection-state', state: 'lost', evidence }); f.emit({ type: 'connection-state', state: 'restored', evidence }) })
    await view.render(<MobileConversationSurface {...props(f)} />)
    expect(retry(view.element)).toBeDefined(); expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['absent-admission', 'other-session', 'other-current-run', 'other-original-run', 'other-operation', 'other-prompt',
    'other-message', 'no-human', 'agent-author', 'system-context', 'missing-execution'] as const)(
    'keeps an explicit retry reachable but refuses unverifiable legacy %s input without replacing the original', async reason => {
      retainOriginal(); const f = fixture(), value = admitted(), intent = value.promptCompletionAdmission!.intent!
      if (reason === 'absent-admission') delete value.promptCompletionAdmission
      if (reason === 'other-session') value.agentSessionId = 'other'
      if (reason === 'other-current-run') value.run = { runId: 'new-run' }
      if (reason === 'other-original-run') intent.run = { runId: 'other-run' }
      if (reason === 'other-operation') value.promptCompletionAdmission!.submissionId = 'new-operation'
      if (reason === 'other-prompt') intent.prompt = 'different'
      if (reason === 'other-message') intent.message!.userContent = 'different'
      if (reason === 'no-human') delete intent.message!.authorHuman
      if (reason === 'agent-author') intent.message!.authorAgentSessionId = 'peer'
      if (reason === 'system-context') intent.message!.systemContext = 'system input'
      if (reason === 'missing-execution') delete intent.execution
      f.sessions.set('session-original', value)
      const view = await mount(<MobileConversationSurface {...props(f)} />)
      expect(retry(view.element)).toBeDefined(); expect(f.submit).not.toHaveBeenCalled()
      await click(retry(view.element)!)
      expect(f.submit).not.toHaveBeenCalled()
      expect(stored().attempts[0][1]).toMatchObject({ operationId: op, runId: 'run-original', draft: body, phase: 'unknown' })
      expect(view.element.textContent).toContain(reason === 'other-session' ? '当前不能投递' : '投递条件无法完整核实')
      expect(stored().attempts[0][1].phase).toBe('unknown')
      expect(editor(view.element).textContent).toContain('原输入')
    })

  it('re-reads canonical admission at click and refuses a stale UI projection before dispatch', async () => {
    retainOriginal('当前草稿'); const f = fixture(); f.sessions.set('session-original', admitted())
    const view = await mount(<MobileConversationSurface {...props(f)} />), action = retry(view.element)!
    const later = admitted(); later.promptCompletionAdmission!.submissionId = 'later-operation'
    // No event: the displayed old projection is deliberately stale, while SDK authority changed.
    f.sessions.set('session-original', later)
    await click(action)
    expect(f.submit).not.toHaveBeenCalled(); expect(stored().attempts[0][1].phase).toBe('unknown')
    expect(view.element.textContent).toContain('投递条件无法完整核实')
    expect(editor(view.element).textContent).toBe('当前草稿')
  })

  it.each(['AGENT_PROMPT_PREPARATION_FAILED', 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED', 'AGENT_PROMPT_OPERATION_CONFLICT', 'transport lost'])(
    'keeps the earlier unknown after retry failure %s, including this-call not_applied/CF0', async code => {
      retainOriginal('新草稿不能替换原输入'); const f = fixture(); f.sessions.set('session-original', admitted())
      f.submit.mockRejectedValueOnce(Object.assign(new Error('original source/race must be checked by Core'), {
        code, controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }))
      const view = await mount(<MobileConversationSurface {...props(f)} />)
      await click(retry(view.element)!)
      expect(f.submit).toHaveBeenCalledOnce(); expect(stored().attempts[0][1].phase).toBe('unknown')
      expect(stored().attempts[0][1].draft).toBe(body); expect(button(view.element, 'Send').disabled).toBe(false)
      expect(view.element.textContent).toContain('original source/race must be checked by Core')
      expect(editor(view.element).textContent).toBe('新草稿不能替换原输入')
      await click(button(view.element, '刷新')); expect(f.submit).toHaveBeenCalledOnce()
    })

  it('uses the existing request owner to reject double click and preserve a late result after navigation', async () => {
    retainOriginal('新草稿'); const f = fixture(), ack = deferred<void>(); f.sessions.set('session-original', admitted())
    f.submit.mockImplementationOnce(() => ack.promise)
    const options = props(f), view = await mount(<MobileConversationSurface {...options} />), action = retry(view.element)!
    await act(async () => { action.dispatchEvent(new MouseEvent('click', { bubbles: true })); action.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(f.submit).toHaveBeenCalledOnce(); expect(stored().attempts[0][1].phase).toBe('sending')
    await view.render(<MobileConversationSurface {...options} agentSessionId="other" />)
    await paste(view.element, '另一个会话草稿')
    await act(async () => ack.resolve())
    expect(editor(view.element).textContent).toBe('另一个会话草稿')
    await view.render(<MobileConversationSurface {...options} />)
    expect(editor(view.element).textContent).toBe('新草稿'); expect(f.submit).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'] as const)('keeps a restored in-flight retry unknown; an old unmounted %s callback cannot settle or erase it', async outcome => {
    retainOriginal('新草稿'); const f = fixture(), ack = deferred<void>(); f.sessions.set('session-original', admitted())
    f.submit.mockImplementationOnce(() => ack.promise)
    const options = props(f), view = await mount(<MobileConversationSurface {...options} />)
    await click(retry(view.element)!)
    const first = mounted.pop()!; await act(async () => first.root.unmount()); first.element.remove()
    const restored = await mount(<MobileConversationSurface {...options} />)
    const before = localStorage.getItem('agentmux-mobile-workface-v1')
    expect(retry(restored.element)).toBeDefined(); expect(f.submit).toHaveBeenCalledOnce()
    await act(async () => outcome === 'success' ? ack.resolve() : ack.reject(new Error('original late failure')))
    expect(localStorage.getItem('agentmux-mobile-workface-v1')).toBe(before)
    expect(editor(restored.element).textContent).toBe('新草稿')
    expect(button(restored.element, 'Send').disabled).toBe(false)
  })
})
