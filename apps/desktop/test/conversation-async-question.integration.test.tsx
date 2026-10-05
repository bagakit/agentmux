import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages';
import { describeConversationInputSource } from '@agentmux/client-ui/conversation-input-source';
import type { AgentSessionHistoryPage, AgentSessionQuestionReplyReceipt } from '@agentmux/core';
import { ConversationView } from '@agentmux/client-ui/components/ConversationView';
import { AgentAsyncQuestionCard } from '@agentmux/client-ui/components/AgentAsyncQuestionCard';
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard';
import { createClientUiRoot } from './helpers/client-ui-render';
import { fixture, nativeQuestion, request, raw } from './helpers/native-async-question-fixture';
import { api } from '../src/renderer/src/lib/api';
import { useAppStore } from '../src/renderer/src/store';
import { replyConversationQuestion, desktopQuestionReplyState, observeConversationQuestionAnswers, editConversationQuestionDraft } from '../src/renderer/src/lib/conversation-question';
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
function Thread({ page, onReply = replyConversationQuestion.bind(null, control) }: { page: AgentSessionHistoryPage; onReply?: typeof replyConversationQuestion extends (control: any, input: infer I) => infer R ? (input: I) => R : never }) {
  const replies = useAppStore(state => state.questionReplies?.['question-session'])
  const drafts = useAppStore(state => state.questionReplyDrafts?.['question-session'])
  useEffect(() => observeConversationQuestionAnswers(control, page), [page])
  return <ConversationView page={page} sessionId="question-session" onReplyQuestion={onReply}
    questionReplyState={target => desktopQuestionReplyState(replies, 'question-session', target)}
    questionReplyDraft={target => drafts?.[questionReplyKey('question-session', target)]}
    onQuestionDraftChange={(target, answers) => editConversationQuestionDraft(control, target, answers)} renderQuestionNotice={renderConversationQuestionNotice} />
}
function thread(page: AgentSessionHistoryPage, onReply = replyConversationQuestion.bind(null, control)) { return <Thread page={page} onReply={onReply} /> }
async function bridge(h: Awaited<ReturnType<typeof fixture>>) {
  const runtime = new RuntimeController(h.store, async () => {
    throw new Error('No Runtime connection action is permitted in this test');
  });
  Object.assign(runtime, { hosts: new Map([['local', { client: h.client, config: { id: 'local', kind: 'local', label: 'Private host' } }]]) });
  vi.spyOn(runtime as unknown as {
    connectedClient(hostId: string): Promise<DesktopRuntimeClient>;
  }, 'connectedClient').mockResolvedValue(h.client as unknown as DesktopRuntimeClient);
  const invocationConfig = {
    ...config,
    executors: {
      codex: {
        ...config.executors.codex!,
        command: h.invocation.commandOverride,
        args: h.invocation.args
      }
    }
  };
  return vi.spyOn(api.sessions, 'replyQuestion').mockImplementation((target, input) => runtime.replyQuestion(target, input, invocationConfig));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createClientUiRoot(container);
  seed();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(initial, true);
  vi.restoreAllMocks();
});
it('actual public Provider page produces a visible async card outside a collapsed process sequence', async () => {
  const h = await fixture('unanswered');
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
  expect(page.items.find(item => item.id === nativeQuestion.id)?.questionRequest).toEqual(request);
  await render(thread({
    ...page,
    items: [{
      id: 'actual-reasoning',
      kind: 'activity',
      title: 'Private observed process',
      contentParts: [{
        kind: 'text',
        text: 'Original process'
      }]
    }, ...page.items]
  }));
  const card = container.querySelector<HTMLElement>('[aria-label="Native asynchronous question"]')!;
  expect(card).not.toBeNull();
  expect(card.closest('[data-history-group-anchor]')).toBeNull();
  expect(card.querySelector('legend')?.textContent).toBe(request.questions[0]!.prompt);
  expect(container.querySelector('[data-native-record-id="before-question"] .log-turn__body')?.textContent).toBe('before');
});
it('choices only draft; explicit submit crosses actual Renderer→Main→Core and preserves exact native answer wire', async () => {
  const h = await fixture('unanswered');
  const condition = await h.beginWorking();
  const original = useAppStore.getState().sessions[0]!;
  if (original.kind !== 'agent') throw new Error('The exact question fixture must be an Agent Session');
  useAppStore.setState({ sessions: [{ ...original, promptSubmissionPredecessor: condition.afterSubmissionId, status: { state: 'working', source: 'native-hook', observedAt: 2 } }] });
  const send = await bridge(h);
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
  await render(thread(page));
  await click('Keep original');
  expect(send).not.toHaveBeenCalled();
  expect(h.writes).toHaveLength(2);
  expect(button('Submit reply').disabled).toBe(false);
  await text('Typed precise answer\n保留空白');
  await click('Submit reply');
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(container.textContent).toContain('Submitted · Awaiting a recorded answer'));
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('submitted');
  expect(h.writes.map(write => String(write.data)).join('')).toContain('Typed precise answer\\n保留空白');
  expect(send.mock.calls[0]![1].answers).toEqual([{
    questionId: request.questions[0]!.id,
    answer: 'Keep original'
  }, {
    questionId: request.questions[1]!.id,
    answer: 'Typed precise answer\n保留空白'
  }]);
  expect(send.mock.calls[0]![1]).toMatchObject({
    recordId: nativeQuestion.id,
    source: page.source,
    turnId: 'question-turn',
    afterSubmissionId: 'original-active-turn',
    expectedRun: control.run
  });
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('UNSENT ORIGINAL DRAFT');
  expect(useAppStore.getState().sessions[0]?.control).toEqual(control);
  const timeline = await h.store.loadTimeline('question-session');
  expect(timeline.items.at(-1)?.sourceChannel).toBe('question-reply');
  const accepted = projectSessionUserMessages({
    agentSessionId: 'question-session',
    timeline
  }).find(message => message.source.kind === 'captured' && message.source.channel === 'question-reply');
  expect(accepted).toBeDefined();
  expect(describeConversationInputSource(accepted!.source).caption).toContain('Question reply');
  expect(describeConversationInputSource(accepted!.source).caption).not.toContain('Message Tool');
});
it('exact loaded native answers remain readable; an unanswered sibling never becomes answered from one ACK', async () => {
  const h = await fixture();
  const send = await bridge(h);
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
  await render(thread(page));
  expect(container.querySelector('.agent-question__answer')?.textContent).toBe('Keep original');
  expect(page.items.flatMap(item => item.questionAnswers ?? [])).toContainEqual(expect.objectContaining({ questionId: request.questions[0]!.id, answer: 'Keep original' }));
  expect(container.querySelectorAll('.agent-question__field')[0]?.querySelector('button')).toBeNull();
  await text('Actual second reply');
  await click('Submit reply');
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]![1].answers).toEqual([{
    questionId: request.questions[1]!.id,
    answer: 'Actual second reply'
  }]);
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).not.toBe('answered');
});
it('unknown answers are not human guesses or pending; unrelated opaque IDs cannot mark this question answered', async () => {
  await render(<AgentAsyncQuestionCard
    request={request}
    recordedAnswers={new Map([['other-exact-question', 'Keep original']])}
  />);
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  expect(container.textContent).toContain('Answer not recorded in this window');
  expect(container.querySelectorAll('.agent-question__answer')).toHaveLength(0);
  expect(container.textContent).toContain('Read-only');
  expect(container.textContent).not.toContain('Needs your answer');
});
it('fully recorded answers show their exact content and no reply action', async () => {
  await render(<AgentAsyncQuestionCard
    request={request}
    recordedAnswers={new Map(request.questions.map(question => [question.id, 'Recorded answer ' + question.prompt]))}
    onSubmit={vi.fn()}
  />);
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('answered');
  expect(container.querySelectorAll('.agent-question__answer')).toHaveLength(2);
  expect(container.querySelectorAll('button,textarea')).toHaveLength(0);
});
it('a lost reply receipt survives card remount and retries the original Core operation and predecessor; changed answers cannot replace it', async () => {
  const h = await fixture('unanswered'), condition = await h.beginWorking()
  const session = useAppStore.getState().sessions[0]!
  if (session.kind !== 'agent') throw Error('Exact Agent fixture required')
  useAppStore.setState({ sessions: [{ ...session, promptSubmissionPredecessor: condition.afterSubmissionId }] })
  const send = await bridge(h), originalSend = send.getMockImplementation()!
  send.mockImplementationOnce(async (...args) => { await originalSend(...args); throw new Error('Receipt lost after original Core input') })
  const page = await h.client.sessionHistoryPage('question-session', h.invocation)
  await render(thread(page)); await click('Keep original'); await click('Submit reply')
  await vi.waitFor(() => expect(container.textContent).toContain('Reply unconfirmed'))
  const first = send.mock.calls[0]![1], bytes = h.writes.length
  await render(<div>Temporarily another surface</div>); await render(thread(page))
  expect(button('Revise').disabled).toBe(false)
  await click('Revise'); await text('另一份尚未发送的新草稿')
  await render(<div>Another remount</div>); await render(thread(page))
  expect(button('Revise').getAttribute('aria-pressed')).toBe('true')
  expect([...container.querySelectorAll('textarea')].at(-1)?.value).toBe('另一份尚未发送的新草稿')
  expect(Object.values(useAppStore.getState().questionReplies['question-session']!)[0]?.input).toEqual(first)
  expect(button('Retry original reply').disabled).toBe(false)
  useAppStore.setState({ sessions: [{ ...session, promptSubmissionPredecessor: first.operationId }] })
  await expect(replyConversationQuestion(control, { source: page.source, turnId: 'question-turn', recordId: nativeQuestion.id,
    answers: [{ questionId: request.questions[0]!.id, answer: 'Revise' }] })).rejects.toThrow('changed answer cannot replace')
  expect(send).toHaveBeenCalledTimes(1)
  await click('Retry original reply')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(container.textContent).toContain('Submitted · Awaiting'))
  expect(send.mock.calls[1]![1]).toEqual(first)
  expect(first.afterSubmissionId).toBe(condition.afterSubmissionId); expect(h.writes).toHaveLength(bytes)
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('UNSENT ORIGINAL DRAFT')
})
it('a later not-applied retry cannot clear the original unknown reply or grant a new answer', async () => {
  const h = await fixture('unanswered'), send = await bridge(h), page = await h.client.sessionHistoryPage('question-session', h.invocation)
  send.mockRejectedValueOnce(new Error('Original receipt unknown')).mockRejectedValueOnce(Object.assign(new Error('This later call was refused'), { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }))
  await render(thread(page)); await click('Keep original'); await click('Submit reply')
  await vi.waitFor(() => expect(container.textContent).toContain('Reply unconfirmed'))
  await click('Retry original reply')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect(button('Revise').disabled).toBe(false); expect(container.textContent).toContain('Reply unconfirmed')
  expect(Object.values(useAppStore.getState().questionReplies['question-session']!)[0]?.phase).toBe('unknown')
})
it('the existing durable Workbench writer restores the complete original reply independently of the edited answer draft', async () => {
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  const sessions = useAppStore.getState().sessions
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions, timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const dispose = await useAppStore.getState().initialize()
  try {
    seed()
    const h = await fixture('unanswered'), send = await bridge(h), page = await h.client.sessionHistoryPage('question-session', h.invocation)
    send.mockRejectedValueOnce(new Error('Original receipt unknown'))
    await render(thread(page)); await click('Keep original'); await click('Submit reply')
    await vi.waitFor(() => expect(container.textContent).toContain('Reply unconfirmed'))
    const input = send.mock.calls[0]![1]
    await click('Revise'); await text('另一份保存的新草稿')
    const saved = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state
    expect(saved.questionReplies).toBeDefined()
    const savedAttempt = Object.values(saved.questionReplies['question-session'])[0] as any
    expect(savedAttempt).toMatchObject({ phase: 'unknown', hostId: 'local', input })
    expect(Object.values(saved.questionReplyDrafts['question-session'])[0]).toContainEqual({ questionId: request.questions[1]!.id, answer: '另一份保存的新草稿' })
    await useAppStore.persist.rehydrate()
    expect(Object.values(useAppStore.getState().questionReplies['question-session']!)[0]?.input).toEqual(input)
    await render(<div>Remounted after durable hydration</div>); await render(thread(page))
    expect([...container.querySelectorAll('textarea')].at(-1)?.value).toBe('另一份保存的新草稿')
    expect(button('Retry original reply').disabled).toBe(false); expect(send).toHaveBeenCalledOnce()
  } finally { dispose() }
})
it('the rendered Run remains the target; a changed Session refuses only this reply without losing its question or draft', async () => {
  const h = await fixture();
  const send = await bridge(h);
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
  await render(thread(page));
  await text('Keep original draft');
  const previous = useAppStore.getState().sessions[0]!;
  if (previous.kind !== 'agent') throw Error('Fixture requires an actual Agent');
  useAppStore.setState({
    sessions: [{
      ...previous,
      control: {
        ...control,
        run: {
          runId: 'new-run'
        }
      }
    }]
  });
  await click('Submit reply');
  expect(send).not.toHaveBeenCalled();
  expect(container.textContent).toContain('original Session or Run changed');
  expect(container.querySelector('textarea')?.value).toBe('Keep original draft');
  expect(container.textContent).toContain(nativeQuestion.text);
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('UNSENT ORIGINAL DRAFT');
});
it('source replacement resets local submission state and refuses stale loaded answers', async () => {
  const h = await fixture();
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
  const submit = vi.fn().mockResolvedValue({
    outcome: 'submitted'
  });
  await render(thread(page, submit));
  await text('Local old source');
  await click('Submit reply');
  expect(submit).toHaveBeenCalledTimes(1);
  await render(thread({
    ...page,
    source: {
      ...page.source,
      nativeSessionId: 'replacement-native'
    },
    items: page.items.filter(item => item.kind !== 'user-message')
  }, submit));
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(container.querySelectorAll('.agent-question__answer')).toHaveLength(0);
});
it('a malformed optional question stays an honest service notice beside original body and raw Copy', async () => {
  const h = await fixture('malformed-options');
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
  await render(thread(page));
  expect(container.textContent).toContain(nativeQuestion.text);
  expect(container.querySelectorAll('[aria-label="Native asynchronous question"]')).toHaveLength(0);
  expect(container.textContent).toContain('Question');
  expect(container.querySelectorAll('.service-window')).toHaveLength(1);
  expect(page.items.find(item => item.id === nativeQuestion.id)?.questionDiagnostic?.code).toBeDefined();
  expect(container.querySelector(`[data-native-record-id="${nativeQuestion.id}"]`)?.querySelector('.log-turn__body')?.textContent).toBe(nativeQuestion.text);
});
it('one delayed explicit submission cannot be duplicated by rapid activation and leaves the original selected body connected', async () => {
  let release!: (receipt: AgentSessionQuestionReplyReceipt) => void;
  const submit = vi.fn(() => new Promise<AgentSessionQuestionReplyReceipt>(resolve => {
    release = resolve;
  }));
  const h = await fixture();
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
  await render(thread(page, submit));
  const original = container.querySelector(`[data-native-record-id="${nativeQuestion.id}"] .log-turn__body`)!;
  const textNode = original.querySelector('p')!.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 5);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await text('Delayed answer');
  await act(async () => {
    button('Submit reply').click();
    button('Submit reply').click();
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(original.isConnected).toBe(true);
  expect(range.startContainer).toBe(textNode);
  await act(async () => release({
    agentSessionId: 'question-session',
    source: page.source,
    recordId: nativeQuestion.id,
    questionIds: [request.questions[1]!.id],
    operationId: 'actual-local-operation',
    outcome: 'submitted'
  }));
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  expect(original.isConnected).toBe(true);
});
it('submits a nonempty exact subset and later unlocks other questions only after exact recorded facts arrive', async () => {
  const submit = vi.fn().mockResolvedValue({
    outcome: 'submitted'
  });
  const renderCard = (recordedAnswers: ReadonlyMap<string, string>) => <AgentAsyncQuestionCard
    request={request}
    recordedAnswers={recordedAnswers}
    onSubmit={submit}
  />;
  await render(renderCard(new Map()));
  await click('Revise');
  expect(button('Submit reply').disabled).toBe(false);
  await click('Submit reply');
  expect(submit.mock.calls[0]![0]).toEqual([{
    questionId: request.questions[0]!.id,
    answer: 'Revise'
  }]);
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  await render(renderCard(new Map([[request.questions[0]!.id, 'Revise']])));
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  expect(container.textContent).toContain('1 of 2 answers recorded · Others unconfirmed');
  await text('Remaining exact answer');
  await click('Submit reply');
  expect(submit.mock.calls[1]![0]).toEqual([{
    questionId: request.questions[1]!.id,
    answer: 'Remaining exact answer'
  }]);
  expect(submit.mock.calls[1]).toHaveLength(1);
});
it('local reply draft and ACK cannot cross Managed Session identities even when native source and record IDs are the same', async () => {
  const h = await fixture();
  const first = await h.client.sessionHistoryPage('question-session', h.invocation);
  const second = await h.alias('second-managed-session');
  expect(second.source).toEqual(first.source);
  expect(second.items.map(item => item.id)).toEqual(first.items.map(item => item.id));
  const submit = vi.fn().mockResolvedValue({
    outcome: 'submitted'
  });
  await render(thread(first, submit));
  await text('Only Session A draft');
  await render(<ConversationView
    page={second}
    sessionId="second-managed-session"
    onReplyQuestion={submit}
  />);
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  await render(thread(first, submit));
  await text('Session A submitted answer');
  await click('Submit reply');
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  await render(<ConversationView
    page={second}
    sessionId="second-managed-session"
    onReplyQuestion={submit}
  />);
  expect(container.querySelector('[data-question-state]')?.getAttribute('data-question-state')).toBe('unknown');
  expect(container.querySelector('textarea')?.value).toBe('');
});
it('shared choices preserve the original synchronous question response without an async Submit gate', async () => {
  const respond = vi.fn().mockResolvedValue(undefined);
  await render(<AgentInteractionCard
    request={{
    kind: 'question',
    id: 'sync-question',
    agentSessionId: 'question-session',
    questions: [{
      id: 'original-sync-id',
      prompt: 'Original synchronous choice',
      options: [{
        id: 'sync-choice',
        label: 'Synchronous reply',
        description: 'Original option description'
      }]
    }],
    evidence: {
      source: 'native-hook',
      observedAt: 1,
      run: control.run,
      hookReceiptId: 'original-sync-receipt'
    }
  }}
    onRespond={respond}
  />);
  expect(container.textContent).toContain('Original option description');
  await act(async () => button('Synchronous replyOriginal option description').click());
  expect(respond).toHaveBeenCalledExactlyOnceWith({
    kind: 'question',
    requestId: 'sync-question',
    outcome: 'answered',
    answers: [{
      questionId: 'original-sync-id',
      optionId: 'sync-choice'
    }]
  });
  expect(container.querySelector('[aria-label="Native asynchronous question"]')).toBeNull();
});

it('does not settle a retained intent whose native source matches but its exact managed-Session key differs', async () => {
  const h = await fixture(), page = await h.client.sessionHistoryPage('question-session', h.invocation)
  const input = { source: page.source, turnId: 'question-turn', recordId: 'native-async-call', operationId: 'foreign-original',
    expectedRun: control.run, afterSubmissionId: null, answers: [{ questionId: request.questions[0]!.id, answer: 'Keep original' }] }
  const foreignKey = questionReplyKey('another-managed-session', input), attempt = { hostId: 'local', phase: 'unknown' as const, input }
  useAppStore.setState({ questionReplies: { 'question-session': { [foreignKey]: attempt } } })
  observeConversationQuestionAnswers(control, page, null, { submissionId: input.operationId, run: control.run })
  await flush()
  expect(useAppStore.getState().questionReplies['question-session']![foreignKey]).toBe(attempt)
  expect(attempt.phase).toBe('unknown')
})

it.each([1, 100])('builds one answer index for %i related original intents in one real Desktop observation', async count => {
  seed()
  const source = { providerId: 'codex', nativeSessionId: 'native-question-session' }
  const replies = Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const input = { source, turnId: 'original-turn', recordId: 'question-' + index, operationId: 'operation-' + index,
      expectedRun: control.run, afterSubmissionId: null, answers: [{ questionId: 'unrecorded-' + index, answer: 'Exact answer' }] }
    return [questionReplyKey(control.agentSessionId, input), { hostId: control.hostId, input, phase: 'unknown' as const }]
  }))
  useAppStore.setState({ questionReplies: { [control.agentSessionId]: replies } })
  let pageVisits = 0, contextVisits = 0
  const items = [{ id: 'native-user-answer', kind: 'user-message' as const, contentParts: [], questionAnswers: [{ questionId: 'unrelated-answer', answer: 'Native' }] }]
  const page: AgentSessionHistoryPage = { agentSessionId: control.agentSessionId, source, nextCursor: null, get items() { pageVisits++; return items } }
  const context: AgentSessionHistoryPage = { ...page, get items() { contextVisits++; return items } }
  pageVisits = 0
  observeConversationQuestionAnswers(control, page, context)
  expect({ pageVisits, contextVisits }).toEqual({ pageVisits: 1, contextVisits: 1 })
  console.info('QUESTION_COST_DESKTOP ' + JSON.stringify({ relatedCount: count, pageVisits, contextVisits }))
  expect(Object.values(useAppStore.getState().questionReplies[control.agentSessionId]!)).toHaveLength(count)
  expect(Object.values(useAppStore.getState().questionReplies[control.agentSessionId]!).every(attempt => attempt.phase === 'unknown')).toBe(true)
})
