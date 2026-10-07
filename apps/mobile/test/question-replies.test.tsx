import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { MobileApp } from '../src/MobileApp'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { reconcileMobileQuestionReplies } from '../src/conversation/question-replies'
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
const attempt = () => record().questions?.find(([id]: [string]) => id === key)?.[1]
function questionFixture() {
  const f = fixture(); f.setPage(page)
  f.sessions.set(sid, { ...f.sessions.get(sid)!, nativeHandle: { kind: 'provider', providerId: page.source.providerId, sessionId: page.source.nativeSessionId } })
  const rpc = vi.fn(async (method: string) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession(sid), displayName: { override: null, availability: 'observed' } }
    throw new Error('Unexpected automatic RPC: ' + method)
  })
  const write = vi.fn(async (input: any) => ({ runId: input.expectedRun.runId, appliedByteRange: { startByte: 0, endByte: new TextEncoder().encode(input.data).length }, acceptedThroughByte: new TextEncoder().encode(input.data).length }))
  Object.assign(f.client, { forwardRpc: rpc, writeAgent: write, runtimeIdentity: () => ({ hostId: 'host-original', instanceId: 'original-runtime' }), runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }) })
  return { ...f, rpc, write }
}
async function type(element: HTMLElement, value: string) { const field = element.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: 补充说明"]')!; expect(field.disabled).toBe(false); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function refresh(element: HTMLElement) { if (!element.querySelector('[aria-label="刷新原对话"]')) await click(button(element, 'Show the message tool row')); await click(button(element, '刷新原对话')) }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } vi.restoreAllMocks() })
it('actual MobileApp edits two answers, copies a plain answer, opens the same original terminal in watch mode and retains drafts/unknown on return', async () => {
  const f = questionFixture(), local = createLocalDrafts(); local.questions.set(key, structuredClone(held)); await local.save()
  await getDeviceWorkface().updateNavigation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' })
  const platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原连接' }} platform={platform}/>)
  await click(button(view.element, 'Keep original')); await type(view.element, '  第二题答案\n保留空白  ')
  await click(button(view.element, 'Copy answer: 补充说明')); expect(copy.mock.calls[0]![0]).toBe('  第二题答案\n保留空白  ')
  const draft = structuredClone(record().questionDrafts), frozen = structuredClone(attempt())
  await click(button(view.element, 'View original terminal'))
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
it('same-source native answers update the card while preserving complete unknown and diagnostic; legacy confirmed is untouched', async () => {
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
  const legacy = { ...held, runtimeId: null }; local.questions.set(key, legacy); expect(await reconcileMobileQuestionReplies(local, sid, negative, held.runtimeId)).toBe(false); expect(local.questions.get(key)).toBe(legacy)
})
it('keeps editing/terminal/clipboard failure available after device save failure and ignores clipboard callbacks after another SID/Host/Run/source', async () => {
  const f = questionFixture(), platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(false), showTerminal = vi.fn()
  const surface = (id = sid) => <MobileConversationSurface client={f.client} agentSessionId={id} connection={{ state: 'connected' as const, message: 'connected' }} platform={platform} onShowTerminal={showTerminal}/>
  const view = await mount(surface()); await type(view.element, 'Original answer'); await click(button(view.element, 'Copy answer: 补充说明')); expect(view.element.textContent).toContain('Retry copy')
  const set = localStorage.setItem.bind(localStorage); vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (key === DEVICE_WORKFACE_KEY) throw new Error('Device save unavailable'); return set(key, value) })
  await type(view.element, 'Unsaved answer retained'); await vi.waitFor(() => expect(view.element.textContent).toContain('尚未持久保存'))
  await click(button(view.element, 'Answer in original terminal')); expect(showTerminal).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled()
  const pending = deferred<boolean>(); copy.mockImplementationOnce(() => pending.promise); await click(button(view.element, 'Copy answer: 补充说明'))
  const other = f.sessions.get('other')!; f.sessions.set('other', { ...other, hostId: 'other-host', run: { runId: 'other-run' } }); f.setPage({ ...page, agentSessionId: 'other', source: { ...page.source, nativeSessionId: 'other-source' } })
  await view.render(surface('other')); await act(async () => pending.resolve(true))
  expect(view.element.querySelector('.agent-interaction--async')?.textContent).not.toContain('Copied'); expect(f.write).not.toHaveBeenCalled()
})

it('actual mobile surface treats changed or unknown current native source as retained viewing while keeping the original draft/copy/navigation', async () => {
  const f = questionFixture(), platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true), show = vi.fn()
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={platform} onShowTerminal={show}/>)
  await type(view.element, 'Kept draft across source changes'); expect(button(view.element, 'Answer in original terminal')).toBeDefined()
  for (const nativeHandle of [{ kind: 'provider' as const, providerId: 'codex', sessionId: 'changed-native-source' }, undefined]) {
    const next = { ...f.sessions.get(sid)!, nativeHandle }; await act(async () => { f.sessions.set(sid, next); f.emit({ type: 'agent-session', session: next }) })
    expect(button(view.element, 'View original terminal')).toBeDefined(); expect(view.element.textContent).toContain('retained question')
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: 补充说明"]')!.disabled).toBe(false)
    await click(button(view.element, 'Copy answer: 补充说明')); expect(copy.mock.lastCall?.[0]).toBe('Kept draft across source changes')
  }
  await click(button(view.element, 'View original terminal')); expect(show).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
