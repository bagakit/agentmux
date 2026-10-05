// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClientUiRoot } from './helpers/client-ui-render';
import { fixture, request } from './helpers/native-async-question-fixture';
import { AgentMuxError } from '@agentmux/core';
import { agentPromptNotApplied } from '@agentmux/core/prompt-condition';
import { reduceRuntimeEvent } from '../src/renderer/src/lib/session-state';
import { RuntimeController } from '../src/main/runtime-controller';
import { useAppStore } from '../src/renderer/src/store';
import { api } from '../src/renderer/src/lib/api';
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts';
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: () => <div data-leaf="terminal" />
}));
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({
  AgentSessionComposer: () => <textarea aria-label="Original composer" />
}));
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({
  AgentRegionHeader: ({
    onHistory
  }: {
    onHistory?: () => void;
  }) => <header>{onHistory ? <button onClick={onHistory}>History</button> : null}</header>
}));
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({
  SessionResultReview: () => null
}));
import * as questionOwner from '../src/renderer/src/lib/conversation-question';
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply';
import { SessionPane } from '../src/renderer/src/components/SessionPane';
const original = useAppStore.getState(),
  control: AgentSessionControl = {
    kind: 'agent',
    hostId: 'local',
    agentSessionId: 'question-session',
    run: {
      runId: 'question-run'
    }
  };
let root: Root, container: HTMLDivElement;
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
const pane = () => <SessionPane sessionId="question-session" surfaceKind="agent" interactiveResize={false}
  visible={true} readOnly={false} linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />
async function setup(withRecordedAnswer = false) {
  const h = await fixture();
  const originalPage = await h.client.sessionHistoryPage('question-session', h.invocation);
  const page = withRecordedAnswer ? { ...originalPage, items: [...originalPage.items, { id: 'already-recorded-answer', kind: 'user-message' as const, contentParts: [], questionAnswers: [{ questionId: request.questions[1]!.id, answer: 'Native answer' }] }] } : originalPage;
  const config: AppConfig = {
    version: 9,
    hosts: [{
      id: 'local',
      kind: 'local',
      label: 'Private host'
    }],
    executors: {
      codex: {
        label: 'Private native reader',
        providerId: 'codex',
        command: h.invocation.commandOverride,
        args: h.invocation.args,
        env: {},
        injectAgentMuxGuide: true
      }
    },
    workspaces: [{
      id: 'ws',
      name: 'Private project',
      hostId: 'local',
      path: h.directory,
      kind: 'folder'
    }],
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
  const session: Extract<SessionSnapshot, {
    kind: 'agent';
  }> = {
    id: 'question-session',
    kind: 'agent',
    hostId: 'local',
    workspacePath: h.directory,
    label: 'Original question agent',
    providerId: 'codex',
    executorId: 'codex',
    agentSessionUpdatedAt: 1,
    promptSubmissionPredecessor: null,
    nativeHandle: h.client.agentSession('question-session').nativeHandle,
    nativeSessionId: h.client.agentSession('question-session').nativeHandle!.sessionId,
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
      'question-session': 'ORIGINAL UNSENT'
    },
    viewModes: {
      'question-session': 'activity'
    },
    timelines: {},
    pendingAgentLaunches: {},
    runtimeOwnershipWarnings: [],
    recoveryCandidates: [],
    agentSteerQueues: {}
  });
  const reads = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page);
  const send = vi.spyOn(api.sessions, 'replyQuestion').mockImplementation((target, input) => h.client.replySessionQuestion({
    ...input,
    agentSessionId: target.agentSessionId,
    ...h.invocation,
    authorHuman: true,
    sourceChannel: 'question-reply'
  }));
  await act(async () => root.render(pane()));
  await flush();
  return {
    h,
    page,
    reads,
    send
  };
}
async function fill(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', {
      bubbles: true
    }));
  });
  await flush();
}
function activeCard() {
  const cards = [...container.querySelectorAll<HTMLElement>('[aria-label="Native asynchronous question"]')].filter(card => !card.closest('[inert]'));
  expect(cards).toHaveLength(1);
  return cards[0]!;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createClientUiRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(original, true);
  vi.restoreAllMocks();
});
it('actual SessionPane→Activity supplies the shared question callback without extra reads or replacing the original body', async () => {
  const {
    send,
    reads
  } = await setup();
  const card = activeCard();
  await fill(card.querySelector('textarea')!, 'Current exact answer');
  expect(send).not.toHaveBeenCalled();
  const count = reads.mock.calls.length;
  const submit = card.querySelector<HTMLButtonElement>('.agent-question__footer button');
  expect(submit).not.toBeNull();
  await act(async () => submit!.click());
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(activeCard().dataset.questionState).toBe('submitted'));
  expect(send.mock.calls[0]![0]).toEqual(control);
  expect(send.mock.calls[0]![1].answers).toEqual([{
    questionId: request.questions[1]!.id,
    answer: 'Current exact answer'
  }]);
  expect(reads.mock.calls.length).toBe(count);
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('ORIGINAL UNSENT');
});
it('actual retained Pane receives the scoped unknown intent update, retains an independently edited draft across remount and explicitly retries the original reply', async () => {
  const { send, reads } = await setup()
  send.mockRejectedValueOnce(new Error('Original receipt unknown'))
  await fill(activeCard().querySelector('textarea')!, 'Original frozen answer')
  await act(async () => activeCard().querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  await vi.waitFor(() => expect(activeCard().dataset.questionState).toBe('unknown'))
  const input = send.mock.calls[0]![1]
  await fill(activeCard().querySelector('textarea')!, 'Another unsent draft')
  await act(async () => root.render(<div>Another surface</div>)); await act(async () => root.render(pane())); await flush()
  expect(activeCard().querySelector('textarea')?.value).toBe('Another unsent draft')
  expect(activeCard().querySelector('.agent-question__footer button')?.textContent).toContain('Retry original reply')
  expect(send).toHaveBeenCalledOnce()
  const count = reads.mock.calls.length
  await act(async () => activeCard().querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect(send.mock.calls[1]![1]).toEqual(input)
  expect(reads.mock.calls.length).toBe(count)
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('ORIGINAL UNSENT')
})
it('actual SessionPane→History reuses the same shared question card and preserves its original Activity body', async () => {
  const {
    send
  } = await setup();
  const activityCard = activeCard(),
    body = container.querySelector('[data-native-record-id="native-async-call"] .log-turn__body')!;
  await fill(activityCard.querySelector('textarea')!, 'History exact answer');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'History')!.click());
  await flush();
  const historyCard = activeCard();
  expect(historyCard).toBe(activityCard);
  expect(historyCard.querySelector('textarea')!.value).toBe('History exact answer');
  expect(activityCard.isConnected).toBe(true);
  expect(body.isConnected).toBe(true);
  const submit = historyCard.querySelector<HTMLButtonElement>('.agent-question__footer button');
  expect(submit).not.toBeNull();
  await act(async () => submit!.click());
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]![1]).toMatchObject({
    answers: [{
      questionId: request.questions[1]!.id,
      answer: 'History exact answer'
    }],
    recordId: 'native-async-call',
    turnId: 'question-turn'
  });
  expect(body.isConnected).toBe(true);
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('ORIGINAL UNSENT');
});

it('actual Pane consumes the live original Core refusal, preserves its new draft and allows only an explicit new operation', async () => {
  const { h, send, reads } = await setup()
  const nativeInput = h.inner.kernel.input
  h.inner.kernel.input = async () => { throw new AgentMuxError('Original Native refused its immutable input', 'CTXMUX_input_cursor_mismatch', 'not_applied') }
  // Lose the caller's reply, while Core retains the original Native refusal.
  send.mockImplementationOnce(async (target, input) => {
    try { return await h.client.replySessionQuestion({ ...input, agentSessionId: target.agentSessionId, ...h.invocation, authorHuman: true }) }
    catch { throw new Error('Original RPC receipt lost') }
  })
  await fill(activeCard().querySelector('textarea')!, 'Original unknown answer')
  await act(async () => activeCard().querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  await vi.waitFor(() => expect(activeCard().dataset.questionState).toBe('unknown'))
  const input = send.mock.calls[0]![1], exact = h.client.agentSession('question-session')
  expect(exact.promptCompletionAdmission).toMatchObject({ submissionId: input.operationId, notApplied: true })
  expect(h.writes).toHaveLength(0)
  await fill(activeCard().querySelector('textarea')!, 'New explicit answer')
  const count = reads.mock.calls.length
  const publish = async (session: typeof exact) => {
    await act(async () => useAppStore.setState(state => reduceRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session } })))
    await flush()
  }
  await publish({ ...exact, promptCompletionAdmission: { ...exact.promptCompletionAdmission!, submissionId: 'another-operation' } })
  expect(activeCard().dataset.questionState).toBe('unknown')
  await publish({ ...exact, updatedAt: exact.updatedAt + 1 })
  await vi.waitFor(() => expect(Object.values(useAppStore.getState().questionReplies['question-session']!)[0]!.phase).toBe('rejected'))
  expect(activeCard().querySelector('.agent-question__footer button')?.textContent).toContain('Submit reply')
  expect(activeCard().querySelector('textarea')?.value).toBe('New explicit answer')
  expect(send).toHaveBeenCalledOnce(); expect(reads.mock.calls.length).toBe(count)
  const projected = useAppStore.getState().sessions[0]!
  expect(projected.kind === 'agent' && projected.promptInputNotApplied).toEqual({ submissionId: input.operationId, run: control.run })
  // Initial host projection consumes the same Core helper as the real-time reducer.
  const runtime = new RuntimeController(h.store, async () => { throw new Error('No connection side effect') })
  Object.assign(runtime, { hosts: new Map([['local', { client: h.client, config: { id: 'local', kind: 'local', label: 'Private host' } }]]) })
  vi.spyOn(runtime as any, 'connectedClient').mockResolvedValue(h.client)
  vi.spyOn(h.client, 'runtimeProjection').mockResolvedValue({ subjects: [{ kind: 'agent', agentSession: exact, providerId: 'codex', executorId: 'codex',
    workspacePath: h.directory, hostId: 'local', run: { ...control.run, state: 'running', observedAt: exact.updatedAt, latestOutputBytes: 0, acceptedInputBytes: 0 } }] } as any)
  const snapshot = await runtime.resolveSession('question-session', useAppStore.getState().config!)
  expect(snapshot?.kind === 'agent' && snapshot.promptInputNotApplied).toEqual({ submissionId: input.operationId, run: control.run })
  await act(async () => root.render(<div>Another surface</div>)); await act(async () => root.render(pane())); await flush()
  expect(activeCard().querySelector('textarea')?.value).toBe('New explicit answer'); expect(send).toHaveBeenCalledOnce()
  h.inner.kernel.input = nativeInput
  await act(async () => activeCard().querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect(send.mock.calls[1]![1]).toMatchObject({ answers: [{ questionId: request.questions[1]!.id, answer: 'New explicit answer' }], afterSubmissionId: input.operationId })
  expect(send.mock.calls[1]![1].operationId).not.toBe(input.operationId)
  await vi.waitFor(() => expect(activeCard().dataset.questionState).toBe('submitted'))
  // A later unrelated Core admission must clear the old projected negative fact.
  await publish({ ...exact, updatedAt: exact.updatedAt + 2, promptCompletionAdmission: undefined })
  expect((useAppStore.getState().sessions[0] as Extract<SessionSnapshot, {kind:'agent'}>).promptInputNotApplied).toBeUndefined()
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('ORIGINAL UNSENT')
})

it('keeps the actual Activity observation quiet on unrelated rerenders but confirms a newly retained original intent against its unchanged page', async () => {
  const observe = vi.spyOn(questionOwner, 'observeConversationQuestionAnswers')
  const { page, reads, send } = await setup(true)
  const observations = observe.mock.calls.length, readCount = reads.mock.calls.length
  expect(observations).toBeGreaterThan(0)
  await act(async () => root.render(pane())); await flush()
  expect(observe.mock.calls.length).toBe(observations)
  await act(async () => useAppStore.setState(state => ({ questionReplies: { ...state.questionReplies, foreign: {} },
    sessions: state.sessions.map(session => ({ ...session, updatedAt: session.updatedAt + 1 })) }))); await flush()
  expect(observe.mock.calls.length).toBe(observations)
  const input = { source: page.source, turnId: 'question-turn', recordId: 'native-async-call', operationId: 'late-retained-original',
    expectedRun: control.run, afterSubmissionId: null, answers: [{ questionId: request.questions[1]!.id, answer: 'Original exact answer' }] }
  const key = questionReplyKey(control.agentSessionId, input)
  await act(async () => useAppStore.setState(state => ({ questionReplies: { ...state.questionReplies,
    [control.agentSessionId]: { [key]: { hostId: control.hostId, input, phase: 'unknown' } } } }))); await flush()
  await vi.waitFor(() => expect(useAppStore.getState().questionReplies[control.agentSessionId]?.[key]?.phase).toBe('confirmed'))
  expect(reads.mock.calls.length).toBe(readCount); expect(send).not.toHaveBeenCalled()
})

it('keeps the first submit-phase zero-byte refusal unknown after real Native payload acceptance and retries only that original input', async () => {
  const { h, send, reads } = await setup()
  const nativeInput = h.inner.kernel.input
  h.inner.kernel.input = async (runId, operation) => {
    if (operation.data === '\r') throw new AgentMuxError('Submit Native phase refused', 'CTXMUX_input_cursor_mismatch', 'not_applied',
      { disposition: 'not_applied', confirmedInputBytes: 0 })
    return nativeInput(runId, operation)
  }
  await fill(activeCard().querySelector('textarea')!, 'Original partially accepted answer')
  await act(async () => activeCard().querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  const input = send.mock.calls[0]![1]
  await vi.waitFor(() => expect(activeCard().dataset.questionState).toBe('unknown'))
  const exact = h.client.agentSession('question-session')
  expect(exact.terminalPromptSubmission).toMatchObject({ submissionId: input.operationId,
    payload: { acknowledged: true }, submit: { notApplied: true, acknowledged: false } })
  expect(agentPromptNotApplied(exact)).toBeUndefined(); expect(h.writes).toHaveLength(1)
  expect(h.writes[0]!.data).toContain('Original partially accepted answer')
  await fill(activeCard().querySelector('textarea')!, 'Another unsent answer')
  const count = reads.mock.calls.length
  await act(async () => activeCard().querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(activeCard().dataset.questionState).toBe('unknown'))
  expect(send.mock.calls[1]![1]).toEqual(input); expect(h.writes).toHaveLength(1)
  expect(activeCard().querySelector('textarea')?.value).toBe('Another unsent answer')
  expect(reads.mock.calls.length).toBe(count)
})
