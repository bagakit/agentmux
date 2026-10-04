// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClientUiRoot } from './helpers/client-ui-render';
import { fixture, request } from './helpers/native-async-question-fixture';
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
async function setup() {
  const h = await fixture();
  const page = await h.client.sessionHistoryPage('question-session', h.invocation);
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
  await act(async () => root.render(<SessionPane
    sessionId="question-session"
    surfaceKind="agent"
    interactiveResize={false}
    visible={true}
    readOnly={false}
    linkOrigin={{
    workspaceId: 'ws',
    tabGroupId: 'group',
    tabId: 'tab',
    regionId: 'region'
  }}
  />));
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
  expect(send.mock.calls[0]![0]).toEqual(control);
  expect(send.mock.calls[0]![1].answers).toEqual([{
    questionId: request.questions[1]!.id,
    answer: 'Current exact answer'
  }]);
  expect(reads.mock.calls.length).toBe(count);
  expect(useAppStore.getState().agentComposerDrafts['question-session']).toBe('ORIGINAL UNSENT');
});
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
