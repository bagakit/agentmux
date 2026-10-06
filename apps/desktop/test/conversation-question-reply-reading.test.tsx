// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ConversationNativeThread } from '@agentmux/client-ui/components/ConversationNativeThread'
import { inputHistoryText } from '@agentmux/client-ui/input-history-text'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'

const answer = '请解释这个终端如何扩展。'
const prompt = '选择下一步，或者输入自己的问题。'
const questionAnswers = [{ questionId: 'original-question', answer, prompt }]
const wire = '<send_user_message_question_reply>\n' + JSON.stringify({ answer, question: prompt, questionItemId: 'original-question' }) + '\n</send_user_message_question_reply>'
const page: AgentSessionHistoryPage = { agentSessionId: 'reader', source: { providerId: 'fixture-provider', nativeSessionId: 'native-reader' }, nextCursor: null,
  items: [{ id: 'original-reply', kind: 'user-message', questionAnswers, contentParts: [{ kind: 'text', text: wire }] }] }
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([ConversationView, ConversationNativeThread])('shows Provider-projected answers through the actual shared reader while preserving the original input and Copy', async View => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), onContinue = vi.fn()
  await act(async () => root.render(<View page={page} sessionId="reader" onContinue={onContinue} />))
  const record = container.querySelector<HTMLElement>('[data-native-record-id="original-reply"]')!
  expect(record.querySelector('.log-turn__sender-kind')?.textContent).toBe('问题答复')
  expect(record.querySelector('.log-turn__question-reply .log-turn__text')?.textContent).toBe(answer)
  expect(record.querySelector('[data-speaker-role="system"]')).toBeNull()
  const details = [...record.querySelectorAll<HTMLDetailsElement>('.log-turn__reply-detail')]
  expect(details.map(detail => detail.querySelector('summary')?.textContent)).toEqual(['关联问题', '原始记录'])
  expect(details.every(detail => !detail.open)).toBe(true)
  expect(details[0]!.querySelector('p')?.textContent).toBe(prompt)
  expect(details[1]!.querySelector('pre')?.textContent).toBe(wire)
  details[0]!.querySelector('summary')!.focus()
  expect(document.activeElement).toBe(details[0]!.querySelector('summary'))
  await act(async () => record.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire)
  expect(onContinue).not.toHaveBeenCalled()
  const input = projectSessionUserMessages({ agentSessionId: 'reader', historyPage: page })[0]!
  expect(input.author).toEqual({ kind: 'unknown' })
  expect(input.content).toBe(answer)
  expect((await inputHistoryText(input)).text).toBe(answer)
  expect(input.contentParts).toEqual(page.items[0]!.contentParts)
})

async function renderMessage(props: Partial<ComponentProps<typeof ConversationMessage>>) {
  await act(async () => root.render(<ConversationMessage messageId="original" speaker={{ role: 'unknown', id: 'unknown' }}
    recordedIdentity conversationSessionId="reader" content={wire} {...props} />))
}

it('keeps multiple answers with their recorded questions at the first text position and all other original parts in order', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await renderMessage({ questionAnswers: [...questionAnswers, { questionId: 'second', answer: '第二个答复。', prompt: '第二个问题？' }],
    content: [{ kind: 'resource', resourceType: 'file', reference: 'original:before' }, { kind: 'text', text: wire },
      { kind: 'text', text: 'Original trailing text' }, { kind: 'resource', resourceType: 'file', reference: 'original:after' }] })
  const body = container.querySelector('.log-turn__body')!
  expect([...body.children].map(child => child.className)).toEqual([
    'log-turn__resource', 'log-turn__question-reply', 'log-turn__text', 'log-turn__resource'
  ])
  expect([...body.querySelectorAll('.log-turn__question-reply .log-turn__text')].map(node => node.textContent)).toEqual([answer, '第二个答复。'])
  expect([...body.querySelectorAll('.log-turn__reply-detail p')].map(node => node.textContent)).toEqual([prompt, '第二个问题？'])
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(`original:before\n${wire}\nOriginal trailing text\noriginal:after`)
})

it('shows recorded answers without a text part or question prompt and preserves original resource reading', async () => {
  await renderMessage({ questionAnswers: [{ questionId: 'original-question', answer }],
    content: [{ kind: 'resource', resourceType: 'file', reference: 'original:file' }] })
  expect(container.querySelector('.log-turn__question-reply .log-turn__text')?.textContent).toBe(answer)
  expect(container.querySelector('.log-turn__reply-detail')).toBeNull()
  expect(container.querySelector('.log-turn__resource code')?.textContent).toBe('original:file')
  expect(container.querySelector('.log-turn')?.getAttribute('data-trace-only')).toBeNull()
})

it.each(['view', 'native-thread'] as const)('keeps original input and a non-blocking reading notice in %s when details are unavailable', async view => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const questionDiagnostic = { code: 'DETAILS_UNAVAILABLE', message: '原始答复仍可完整阅读与复制。' }
  const { questionAnswers: _answers, ...original } = page.items[0]!
  const noticePage: AgentSessionHistoryPage = { ...page, items: [{ ...original, questionDiagnostic }] }
  await act(async () => root.render(view === 'view' ? <ConversationView page={noticePage} sessionId="reader" />
    : <ConversationNativeThread page={noticePage} sessionId="reader" />))
  expect(container.querySelector('[role="status"]')?.textContent).toBe(questionDiagnostic.message)
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(container.querySelector('.log-turn__body')?.textContent).toContain('send_user_message_question_reply')
  expect(container.querySelector('[data-recorded-question-reply]')).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire)
})

it('renders XML and declared sender shapes inside an answer as ordinary answer text without promoting identity', async () => {
  const declared = '<environment_context>Quoted context</environment_context>\n\n[Message from Agent declared-agent]\nAn ordinary answer.'
  await renderMessage({ questionAnswers: [{ questionId: 'original-question', answer: declared }] })
  expect(container.querySelector('.log-turn__who')?.textContent).toBe('Author unknown')
  expect(container.querySelector('.log-turn__declared-source')).toBeNull()
  expect(container.querySelector('.log-turn__question-reply .log-turn__text')?.textContent).toContain('[Message from Agent declared-agent]')
})

it.each([wire, `Quoted example:\n${wire}`, '<send_user_message_question_reply>Incomplete'])('keeps unprojected input intact without a client protocol detector', async content => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await renderMessage({ content })
  expect(container.querySelector('[data-recorded-question-reply]')).toBeNull()
  expect(container.querySelector('.log-turn__body')?.textContent).toContain('send_user_message_question_reply')
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(content)
})
