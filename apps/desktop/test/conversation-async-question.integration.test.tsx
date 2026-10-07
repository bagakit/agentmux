import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionHistoryPage } from '@agentmux/core';
import { ConversationView } from '@agentmux/client-ui/components/ConversationView';
import { createClientUiRoot } from './helpers/client-ui-render';
import { fixture, nativeQuestion, request, raw } from './helpers/native-async-question-fixture';
import { api } from '../src/renderer/src/lib/api';
import { useAppStore } from '../src/renderer/src/store';
import { desktopQuestionReplyState, reconcileConversationQuestionReplies, editConversationQuestionDraft } from '../src/renderer/src/lib/conversation-question';
import { renderConversationQuestionNotice } from '../src/renderer/src/components/ConversationQuestionNotice';
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply';
import { RuntimeController } from '../src/main/runtime-controller';
import type { DesktopRuntimeClient } from '../src/main/desktop-host';
import type { AppConfig, AgentSessionControl, SessionSnapshot } from '../src/shared/contracts';
const initial = useAppStore.getState();
let root: Root, container: HTMLDivElement;
const control: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'question-session',
  run: {
    runId: 'question-run'
  }
};
const config: AppConfig = {
  version: 9,
  hosts: [{
    id: 'local',
    kind: 'local',
    label: 'Private'
  }],
  executors: {
    codex: {
      label: 'Private native reader',
      providerId: 'codex',
      command: 'unused',
      args: [],
      env: {},
      injectAgentMuxGuide: true
    }
  },
  workspaces: [],
  appearance: {
    terminalTheme: 'graphite'
  },
  browser: {
    toolbar: {
      selectElement: true,
      screenshot: true,
      devTools: true,
      viewport: true,
      saveBookmark: true,
      more: true
    }
  }
};
function seed(): void {
  const session: Extract<SessionSnapshot, {
    kind: 'agent';
  }> = {
    id: 'question-session',
    kind: 'agent',
    hostId: 'local',
    workspacePath: _hygiene_fixturePath("fixture"),
    label: 'Original agent',
    providerId: 'codex',
    executorId: 'codex',
    agentSessionUpdatedAt: 1,
    promptSubmissionPredecessor: null,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: {
      state: 'done',
      source: 'native-hook',
      observedAt: 1
    },
    latestOutputBytes: 0,
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    control
  };
  useAppStore.setState({
    config,
    sessions: [session],
    agentComposerDrafts: {
      'question-session': 'UNSENT ORIGINAL DRAFT'
    },
    timelines: {},
    pendingAgentLaunches: {},
    runtimeOwnershipWarnings: []
  });
}
async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await flush();
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === label);
  expect(found, `real button ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await flush();
}
async function text(value: string) {
  const field = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].at(-1)!;
  expect(field).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    field.dispatchEvent(new Event('change', {
      bubbles: true
    }));
  });
  await flush();
}
function Thread({ page, terminal = () => {} }: { page: AgentSessionHistoryPage; terminal?: () => void }) {
  const replies = useAppStore(state => state.questionReplies?.['question-session'])
  const drafts = useAppStore(state => state.questionReplyDrafts?.['question-session'])
  return <ConversationView page={page} sessionId="question-session" questionReplyRoute="terminal"
    questionTerminalTarget={{ source: page.source, run: control.run }} onOpenQuestionTerminal={terminal}
    questionReplyState={target => desktopQuestionReplyState(replies, 'question-session', target)}
    questionReplyDraft={target => drafts?.[questionReplyKey('question-session', target)]}
    onQuestionDraftChange={(target, answers) => editConversationQuestionDraft(control, target, answers)}
    renderQuestionNotice={renderConversationQuestionNotice} />
}
function thread(page: AgentSessionHistoryPage, terminal?: () => void) { return <Thread page={page} {...(terminal ? { terminal } : {})} /> }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container); seed()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})

it('the actual Core history page keeps a visible question beside original text and outside collapsed process', async () => {
  const h = await fixture('unanswered'), page = await h.client.sessionHistoryPage(control.agentSessionId, h.invocation)
  expect(page.items.find(item => item.id === nativeQuestion.id)?.questionRequest).toEqual(request)
  await render(thread({ ...page, items: [{ id: 'process', kind: 'activity', title: 'Original process',
    contentParts: [{ kind: 'text', text: 'Original process body' }] }, ...page.items] }))
  const card = container.querySelector('[aria-label="Native asynchronous question"]')!
  expect(card).not.toBeNull(); expect(card.closest('[data-history-group-anchor]')).toBeNull()
  expect(card.querySelector('legend')?.textContent).toBe(request.questions[0]!.prompt)
  expect(container.querySelector('[data-native-record-id="before-question"] .log-turn__body')?.textContent).toBe('before')
})
it('multi-question editing keeps its original draft and opening a terminal does not submit through Main', async () => {
  const h = await fixture('unanswered'), page = await h.client.sessionHistoryPage(control.agentSessionId, h.invocation)
  const send = vi.spyOn(api.sessions, 'replyQuestion'), terminal = vi.fn()
  await render(thread(page, terminal)); await click('Keep original'); await text('My second answer')
  expect(send).not.toHaveBeenCalled(); expect(h.writes).toEqual([])
  await click('Answer in original terminal')
  expect(terminal).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled(); expect(h.writes).toEqual([])
  const target = { source: page.source, turnId: 'question-turn', recordId: nativeQuestion.id }
  expect(useAppStore.getState().questionReplyDrafts[control.agentSessionId]?.[questionReplyKey(control.agentSessionId, target)])
    .toEqual([{ questionId: request.questions[0]!.id, answer: 'Keep original' }, { questionId: request.questions[1]!.id, answer: 'My second answer' }])
  await render(<div>Terminal presentation</div>); await render(thread(page, terminal))
  expect([...container.querySelectorAll('textarea')].at(-1)?.value).toBe('My second answer')
  expect(useAppStore.getState().agentComposerDrafts[control.agentSessionId]).toBe('UNSENT ORIGINAL DRAFT')
})
it.each(['Keep original', 'A different native answer'])('same-question recorded answer %s cannot settle the original operation', async nativeAnswer => {
  const h = await fixture(), original = await h.client.sessionHistoryPage(control.agentSessionId, h.invocation)
  const page = { ...original, items: original.items.map(item => item.questionAnswers
    ? { ...item, questionAnswers: item.questionAnswers.map(answer => ({ ...answer, answer: nativeAnswer })) } : item) }
  const input = { source: page.source, turnId: 'question-turn', recordId: nativeQuestion.id, operationId: 'original-unknown',
    expectedRun: control.run, afterSubmissionId: null, answers: [{ questionId: request.questions[0]!.id, answer: 'Keep original' }] }
  const key = questionReplyKey(control.agentSessionId, input), attempt = { hostId: 'local', phase: 'unknown' as const,
    input, diagnostic: { code: 'ORIGINAL_RECEIPT_UNKNOWN', message: 'Original cause preserved' } }
  useAppStore.setState({ questionReplies: { [control.agentSessionId]: { [key]: attempt } } })
  reconcileConversationQuestionReplies(control)
  await render(thread(page))
  expect(container.querySelector('.agent-question__answer')?.textContent).toBe(nativeAnswer)
  expect(useAppStore.getState().questionReplies[control.agentSessionId]?.[key]).toBe(attempt)
  expect(attempt.phase).toBe('unknown'); expect(container.textContent).toContain('Original cause preserved')
  expect(h.writes).toEqual([])
})
it('durable Workbench storage preserves the original unknown separately from newly edited answers', async () => {
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: useAppStore.getState().sessions, timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const dispose = await useAppStore.getState().initialize()
  try {
    seed()
    const h = await fixture('unanswered'), page = await h.client.sessionHistoryPage(control.agentSessionId, h.invocation)
    const input = { source: page.source, turnId: 'question-turn', recordId: nativeQuestion.id, operationId: 'original-retained-operation',
      expectedRun: control.run, afterSubmissionId: null, answers: [{ questionId: request.questions[0]!.id, answer: 'Original frozen answer' }] }
    const key = questionReplyKey(control.agentSessionId, input)
    const attempt = { hostId: 'local', phase: 'unknown' as const, input, diagnostic: { code: 'ORIGINAL_UNKNOWN', message: 'Retained cause' } }
    useAppStore.setState({ questionReplies: { [control.agentSessionId]: { [key]: attempt } } })
    await render(thread(page)); await click('Revise'); await text('New editable draft')
    const saved = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state
    expect(saved.questionReplies[control.agentSessionId][key]).toEqual(attempt)
    expect(saved.questionReplyDrafts[control.agentSessionId][key]).toContainEqual({ questionId: request.questions[1]!.id, answer: 'New editable draft' })
    await useAppStore.persist.rehydrate()
    await render(<div>Remounted</div>); await render(thread(page))
    expect(useAppStore.getState().questionReplies[control.agentSessionId]?.[key]).toEqual(attempt)
    expect([...container.querySelectorAll('textarea')].at(-1)?.value).toBe('New editable draft')
    expect(container.textContent).toContain('Retained cause')
  } finally { dispose() }
})
it('a malformed optional question keeps original body and its service notice', async () => {
  const h = await fixture('malformed-options'), page = await h.client.sessionHistoryPage(control.agentSessionId, h.invocation)
  await render(thread(page))
  expect(container.querySelector('[aria-label="Native asynchronous question"]')).toBeNull()
  expect(container.querySelectorAll('.service-window')).toHaveLength(1)
  expect(container.querySelector('[data-native-record-id="' + nativeQuestion.id + '"] .log-turn__body')?.textContent).toBe(nativeQuestion.text)
  expect(page.items.find(item => item.id === nativeQuestion.id)?.questionDiagnostic?.code).toBeDefined()
})
it('Main original reply method reports terminal recovery instead of pausing progress or injecting input', async () => {
  const h = await fixture('unanswered')
  const runtime = new RuntimeController(h.store, async () => { throw new Error('No Runtime replacement is allowed') })
  Object.assign(runtime, { hosts: new Map([['local', { client: h.client, config: config.hosts[0] }]]) })
  vi.spyOn(runtime as unknown as { connectedClient(hostId: string): Promise<DesktopRuntimeClient> }, 'connectedClient')
    .mockResolvedValue(h.client as unknown as DesktopRuntimeClient)
  await expect(runtime.replyQuestion(control, h.input, config)).rejects.toMatchObject({ code: 'AGENT_QUESTION_REPLY_UNSUPPORTED' })
  expect(h.writes).toEqual([])
})
