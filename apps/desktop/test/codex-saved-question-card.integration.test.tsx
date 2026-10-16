// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { StaticConversationView as ConversationView } from './helpers/conversation-static-fixture'
import { projectConversationQuestions } from '@agentmux/core/conversation'
import { StaticActivityView as ActivityView } from './helpers/conversation-static-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { savedQuestionFixture as fixture, savedQuestionEvent as event, savedQuestionTool as tool, savedQuestionResult as result,
  savedQuestionReply as reply, savedQuestionSource as source, savedQuestionId as questionId,
  savedQuestionPrompt as prompt, savedQuestionAnswer as answer } from '../../../packages/core/test/helpers/codex-saved-question.js'
const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([['answered options', true], ['unanswered free text', false]] as const)('actual Provider page reaches the shared Activity %s card with no native input operation', async (_name, answered) => {
  const f = await fixture([tool(), event(answered ? undefined : null), result(), ...(answered ? [reply()] : [])]); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  close.push(async () => { await act(async () => root.unmount()); container.remove() })
  const openTerminal = vi.fn(), changeDraft = vi.fn()
  await act(async () => root.render(<ActivityView sessionId={page.agentSessionId} executionHostId="local" capability="complete-events"
    items={[]} nativeHistoryPage={page} questionReplyTarget={{ source, run: f.session.run }}
    onOpenQuestionTerminal={openTerminal} onQuestionDraftChange={changeDraft} />))
  const card = container.querySelector<HTMLElement>('[aria-label="Native asynchronous question"]')!
  expect(card).not.toBeNull(); expect(card.querySelector('legend')?.textContent).toBe(prompt)
  expect(card.querySelector('fieldset')?.dataset.questionId).toBe(questionId)
  expect(card.dataset.questionState).toBe(answered ? 'answered' : 'unknown')
  expect(openTerminal).not.toHaveBeenCalled(); expect(changeDraft).not.toHaveBeenCalled()
  if (answered) expect(card.querySelector('.agent-question__answer')?.textContent).toContain(answer)
  else {
    expect(card.querySelector(`[aria-label="Your answer: ${prompt}"]`)).not.toBeNull()
    expect(card.textContent).toContain('打开原终端')
    await act(async () => [...card.querySelectorAll('button')].find(button => button.textContent?.includes('打开原终端'))!.click())
    expect(openTerminal).toHaveBeenCalledOnce()
  }
  await act(async () => {
    for (const toggle of container.querySelectorAll<HTMLButtonElement>('.conversation-record-process .wf-head[aria-expanded="false"]')) toggle.click()
  })
  expect(container.querySelectorAll('[data-native-step-id="original-tool-record"]')).toHaveLength(1)
  expect(container.querySelectorAll('[data-native-step-id="original-tool-result"]')).toHaveLength(1)
  await f.unchanged()
})

it('retains same-source recorded answers without treating a foreign source or missing records as pending authority', async () => {
  const f = await fixture([event(), reply()]); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId), questionPage = { ...page, items: page.items.slice(0, 1) }
  const same = projectConversationQuestions({ agentSessionId: page.agentSessionId, historyPage: questionPage, answerContext: page })[0]!
  expect(same.recordedAnswers.get(questionId)).toBe(answer)
  const foreign = projectConversationQuestions({ agentSessionId: page.agentSessionId, historyPage: questionPage,
    answerContext: { ...page, source: { ...source, nativeSessionId: 'foreign-native' } } })[0]!
  expect(foreign.recordedAnswers.size).toBe(0)
  expect(foreign).not.toHaveProperty('pending')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  close.push(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(<ConversationView page={questionPage} questionAnswerContext={page} sessionId={page.agentSessionId} />))
  expect(container.querySelector('[data-question-state="answered"]')).not.toBeNull()
  expect(container.querySelector('.agent-question__answer')?.textContent).toContain(answer)
})
