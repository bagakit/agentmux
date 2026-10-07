// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryQuestionRequest } from '@agentmux/core'
import { questionReplyState, type QuestionReplyAttempt } from '../src/lib/conversation-question-reply.js'
import { AgentAsyncQuestionCard } from '../src/components/AgentAsyncQuestionCard.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
const request: AgentSessionHistoryQuestionRequest = { delivery: 'async', questions: [
  { id: 'opaque-free', prompt: 'What should remain available?', options: [], acceptsText: true },
  { id: 'opaque-choice', prompt: 'Choose a direction', options: [{ id: 'keep', label: 'Keep original' }], acceptsText: true }
] }
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
const copyText = vi.fn(async () => true), changed = vi.fn(), terminal = vi.fn()
const platform = { copyText, bindComposerFocus: () => () => {} } as unknown as ClientUiPlatform
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copyText.mockReset().mockResolvedValue(true); changed.mockReset(); terminal.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const field = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: What should remain available?"]')!
async function type(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), value); field().dispatchEvent(new Event('input', { bubbles: true })) }) }
async function render(extra: Partial<Parameters<typeof AgentAsyncQuestionCard>[0]> = {}, identity = 'original') {
  await act(async () => root.render(<ClientUiProvider platform={platform}><AgentAsyncQuestionCard key={identity} request={request} recordedAnswers={new Map()} replyRoute="terminal" terminalCurrent onDraftChange={changed} onOpenTerminal={terminal} {...extra}/></ClientUiProvider>))
}
it('edits multiple answers without a submit callback, copies only one plain answer and opens the original terminal without submitting', async () => {
  await render(); expect(field().disabled).toBe(false)
  await type('  保留原始草稿\n不猜确认  ')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-question-id="opaque-choice"] button')!.click())
  expect(changed.mock.lastCall?.[0]).toEqual([{ questionId: 'opaque-free', answer: '  保留原始草稿\n不猜确认  ' }, { questionId: 'opaque-choice', answer: 'Keep original' }])
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy answer: What should remain available?"]')!.click())
  expect(copyText.mock.calls[0]![0]).toBe('  保留原始草稿\n不猜确认  ')
  await act(async () => host.querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  expect(terminal).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('Submit reply')
})
it('preserves composition, independent draft and complete original unknown even when a native answer is recorded', async () => {
  const original: QuestionReplyAttempt & { hostId: string; runtimeId: string } = { phase: 'unknown', hostId: 'original-host', runtimeId: 'original-runtime', input: { source: { providerId: 'native', nativeSessionId: 'original-native' }, recordId: 'record', turnId: 'turn', operationId: 'original-operation', expectedRun: { runId: 'original-run' }, afterSubmissionId: 'original-predecessor', answers: [{ questionId: 'opaque-free', answer: 'Original frozen answer' }] }, diagnostic: { code: 'UNKNOWN', message: 'Original diagnostic remains' } }
  await render({ attempt: questionReplyState(original) })
  const node = field(); node.focus()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, '候选文本'); node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await render({ attempt: questionReplyState(original), recordedAnswers: new Map([['unrelated', 'Unrelated fact']]) })
  expect(field()).toBe(node); expect(node.value).toBe('候选文本')
  await act(async () => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await render({ attempt: questionReplyState(original), recordedAnswers: new Map([['opaque-free', 'Different native answer'], ['opaque-choice', 'Keep original']]) })
  expect(host.textContent).toContain('Answered'); expect(host.textContent).toContain('original reply operation remains unconfirmed')
  expect(JSON.parse(host.querySelector('.agent-question__original')!.textContent!)).toEqual(original)
  expect(original.phase).toBe('unknown'); expect(host.textContent).toContain('Original diagnostic remains')
})
it('reports clipboard false and ignores a late result after changing the original identity', async () => {
  copyText.mockResolvedValueOnce(false); await render(); await type('First plain answer')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy answer: What should remain available?"]')!.click())
  expect(host.textContent).toContain('Retry copy')
  let resolve!: (value: boolean) => void; copyText.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done }))
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy answer: What should remain available?"]')!.click())
  await render({ draftAnswers: [{ questionId: 'opaque-free', answer: 'New owner answer' }] }, 'new-host-run-source')
  await act(async () => resolve(true))
  expect(host.textContent).not.toContain('Copied'); expect(field().value).toBe('New owner answer')
})
it('keeps draft editing and terminal navigation available with an undeclared route and a save failure notice', async () => {
  await render({ replyRoute: undefined, draftNotice: 'Save unconfirmed; latest edits are kept in this running app.' })
  expect(field().disabled).toBe(false); await type('Still editable'); expect(host.textContent).toContain('Answer route undeclared')
  expect(host.textContent).toContain('Save unconfirmed'); await act(async () => host.querySelector<HTMLButtonElement>('.agent-question__footer button')!.click()); expect(terminal).toHaveBeenCalledOnce()
})

it('uses a neutral terminal viewing action when the original current source is unknown or changed, while preserving edit/copy/navigation', async () => {
  await render({ terminalCurrent: false }); await type('Kept independent draft')
  expect(host.querySelector('.agent-question__footer button')?.textContent).toContain('View original terminal')
  expect(host.textContent).toContain('retained question'); expect(field().disabled).toBe(false)
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy answer: What should remain available?"]')!.click())
  expect(copyText.mock.calls[0]![0]).toBe('Kept independent draft')
})
