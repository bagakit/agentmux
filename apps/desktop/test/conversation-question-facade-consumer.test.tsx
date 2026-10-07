// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture, nativeQuestion, request } from './helpers/native-async-question-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { ConversationQuestionInput } from '@agentmux/core/conversation'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
async function mounted() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
  const initial = useAppStore.getState()
  useAppStore.setState({ sessions: [], timelines: {}, agentNames: {}, agentComposerDrafts: { 'question-session': 'Original unsent draft' } })
  cleanups.push(async () => { useAppStore.setState(initial, true) })
  return { container, root }
}

it('the original Desktop Activity card consumes same-source Core question facts beyond its preserved window', async () => {
  const f = await fixture(), full = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const page = { ...full, items: full.items.filter(item => item.id !== 'exact-answer-record') }
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
  const { container, root } = await mounted()
  const render = (context = page.items) => <ActivityView sessionId={f.input.agentSessionId} executionHostId="local" items={[]}
    capability="complete-events" nativeHistoryPage={page} nativeContextItems={context}
    conversationReading={{ reference: { hostId: 'local', agentSessionId: f.input.agentSessionId }, identity: f.input.expectedRun.runId, enabled: true }} />
  await act(async () => root.render(render()))
  const card = container.querySelector('[aria-label="Native asynchronous question"]')!
  expect(card).not.toBeNull()
  expect(card.querySelector('.agent-question__answer')).toBeNull()
  const body = container.querySelector('[data-native-record-id="before-question"] .log-turn__body')!
  const text = body.querySelector('.md-paragraph')?.firstChild ?? body.querySelector('.log-turn__text')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const reads = (await f.calls()).length
  await act(async () => root.render(render(full.items)))
  expect(container.querySelector('[aria-label="Native asynchronous question"]')).toBe(card)
  expect(card.querySelector(`[data-question-id='${request.questions[0]!.id}'] .agent-question__answer`)?.textContent).toBe('Keep original')
  expect(card.textContent).toContain('1 of 2 answers recorded')
  expect(container.querySelector('[data-native-record-id="exact-answer-record"]')).toBeNull()
  expect(window.getSelection()!.toString()).toBe('before')
  expect((await f.calls()).length).toBe(reads)
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('Original unsent draft')
})

it('the original Desktop Activity card edits without sending and opens the original terminal explicitly', async () => {
  const f = await fixture('unanswered'), page = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const { container, root } = await mounted(), terminal = vi.fn(), edit = vi.fn()
  await act(async () => root.render(<ActivityView sessionId={f.input.agentSessionId} executionHostId="local" items={[]}
    capability="complete-events" nativeHistoryPage={page} questionReplyRoute="terminal"
    onOpenQuestionTerminal={terminal} onQuestionDraftChange={edit} />))
  const card = container.querySelector('[aria-label="Native asynchronous question"]')!
  await act(async () => { [...card.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Keep original')!.click() })
  expect(edit).toHaveBeenCalledExactlyOnceWith({ source: f.input.source, turnId: f.input.turnId, recordId: f.input.recordId },
    [{ questionId: request.questions[0]!.id, answer: 'Keep original' }])
  expect(terminal).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  await act(async () => card.querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  expect(terminal).toHaveBeenCalledOnce(); expect(f.writes).toEqual([])
})

it('the original card preserves a typed activity question at the pure presentation boundary', async () => {
  const f = await fixture('unanswered'), original = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  // A typed DTO fixture does not assert acceptance by the native normalizer or reply owner.
  const item = { ...original.items.find(item => item.questionRequest)!, kind: 'activity' as const, title: 'Recorded activity' }
  const page = { ...original, items: [item] }, describeSpeaker = vi.fn()
  const { container, root } = await mounted()
  await act(async () => root.render(<ConversationView page={page} sessionId={f.input.agentSessionId} describeSpeaker={describeSpeaker} />))
  const card = container.querySelector('[aria-label="Native asynchronous question"]')!
  expect(card).not.toBeNull()
  expect(card.textContent).toContain(request.questions[0]!.prompt)
  expect(container.querySelector('[data-native-record-id] .log-turn__body')?.textContent).toContain(nativeQuestion.text)
  expect(describeSpeaker).not.toHaveBeenCalled()
})
