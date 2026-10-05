// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryQuestionRequest } from '@agentmux/core'
import type { QuestionReplyState } from '../src/lib/conversation-question-reply.js'
import { AgentAsyncQuestionCard } from '../src/components/AgentAsyncQuestionCard.js'

const request: AgentSessionHistoryQuestionRequest = { delivery: 'async', questions: [
  { id: 'opaque-free', prompt: 'What should remain available?', options: [], acceptsText: true },
  { id: 'opaque-choice', prompt: 'Choose a direction', options: [{ id: 'keep', label: 'Keep original' }], acceptsText: true }
] }
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const field = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: What should remain available?"]')!
const submit = () => host.querySelector<HTMLButtonElement>('.agent-question__footer button')!
const setDom = (node: HTMLTextAreaElement, value: string) => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
async function type(value: string) { await act(async () => { setDom(field(), value); field().dispatchEvent(new Event('input', { bubbles: true })) }) }
async function render(answers: ReadonlyMap<string, string> = new Map(), onSubmit?: Parameters<typeof AgentAsyncQuestionCard>[0]['onSubmit'], attempt?: QuestionReplyState) {
  await act(async () => root.render(<AgentAsyncQuestionCard request={request} recordedAnswers={answers} onSubmit={onSubmit} attempt={attempt} />))
}

it('retains the real custom-answer composition preview through unrelated recorded-fact refreshes', async () => {
  const write = vi.fn<NonNullable<Parameters<typeof AgentAsyncQuestionCard>[0]['onSubmit']>>(async () => {})
  await render(new Map(), write)
  const node = field(); node.focus()
  await act(async () => { setDom(node, '候选文本'); node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await render(new Map([['unrelated-question', 'Other exact native fact']]), write)
  expect(field()).toBe(node)
  expect(document.activeElement).toBe(node)
  expect(node.value).toBe('候选文本')
  expect(submit().disabled).toBe(true)
  await act(async () => { setDom(node, '保留原始草稿\n不猜确认'); node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })) })
  expect(node.value).toBe('保留原始草稿\n不猜确认')
  expect(submit().disabled).toBe(false)
  expect(write).not.toHaveBeenCalled()
  await act(async () => submit().click())
  expect(write).toHaveBeenCalledExactlyOnceWith([{ questionId: 'opaque-free', answer: '保留原始草稿\n不猜确认' }])
})

it('keeps the host-held original answer separate from an editable draft and retries only that original answer', async () => {
  let reject!: (error: Error) => void
  const write = vi.fn<NonNullable<Parameters<typeof AgentAsyncQuestionCard>[0]['onSubmit']>>(() => new Promise<void>((_, fail) => { reject = fail }))
  await render(new Map(), write)
  await type('  Keep original work.\n保留空格  ')
  await act(async () => { submit().click(); submit().click() })
  expect(write).toHaveBeenCalledTimes(1)
  const first = write.mock.calls[0]!
  expect(field().disabled).toBe(true)
  await act(async () => reject(new Error('Receipt unknown; original Session remains available.')))
  expect(field().value).toBe('  Keep original work.\n保留空格  ')
  await render(new Map(), write, { phase: 'unknown', answers: first[0], diagnostic: { code: 'UNKNOWN', message: 'Receipt unknown' } })
  expect(field().disabled).toBe(false)
  expect(host.textContent).toContain('Receipt unknown')
  await act(async () => submit().click())
  expect(write.mock.calls[1]).toEqual(first)
  await act(async () => reject(new Error('Still unconfirmed')))
  await type('Corrected exact answer')
  await act(async () => submit().click())
  expect(field().value).toBe('Corrected exact answer')
  expect(host.textContent).toContain('  Keep original work.\n保留空格  ')
  expect(write.mock.calls[2]).toEqual(first)
})

it('waits for exact recorded answer facts before unlocking remaining questions', async () => {
  const write = vi.fn<NonNullable<Parameters<typeof AgentAsyncQuestionCard>[0]['onSubmit']>>(async () => {})
  await render(new Map(), write)
  await type('First answer')
  await act(async () => submit().click())
  const attempt: QuestionReplyState = { phase: 'submitted', answers: [{ questionId: 'opaque-free', answer: 'First answer' }] }
  await render(new Map(), write, attempt)
  expect(host.textContent).toContain('Submitted · Awaiting a recorded answer')
  expect(field().disabled).toBe(true)
  await render(new Map([['other-question', 'Does not confirm this reply']]), write, attempt)
  expect(field().disabled).toBe(true)
  await render(new Map([['opaque-free', 'First answer']]), write, { ...attempt, phase: 'confirmed' })
  expect(field()).toBeNull()
  expect(host.textContent).toContain('1 of 2 answers recorded · Others unconfirmed')
  const remaining = host.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: Choose a direction"]')!
  expect(remaining.disabled).toBe(false)
  expect(host.querySelector('.agent-question__answer')?.textContent).toContain('First answer')
  await render(new Map([['opaque-free', 'First answer'], ['opaque-choice', 'Keep original']]), write)
  expect(host.querySelectorAll('textarea')).toHaveLength(0)
  expect(host.textContent).toContain('Answered')
})

it('preserves the original read-only meaning and native label without creating a sending action', async () => {
  await render()
  expect(field().disabled).toBe(true)
  expect(field().getAttribute('rows')).toBe('2')
  expect(field().labels?.[0]?.textContent).toBe('Your answer')
  expect(host.textContent).toContain('Read-only · Answer in the original Session')
  expect(submit()).toBeNull()
})
