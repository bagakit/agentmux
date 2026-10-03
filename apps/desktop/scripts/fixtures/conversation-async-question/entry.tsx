import { activityReadingProps } from '../../../test/helpers/activity-reading-props'
import { useState } from 'react';
import { createClientUiRoot } from '../../../test/helpers/client-ui-render';
import { ActivityView } from '../../../src/renderer/src/components/ActivityView';

import { replyConversationQuestion } from '../../../src/renderer/src/lib/conversation-question';
import { api } from '../../../src/renderer/src/lib/api';
import { useAppStore } from '../../../src/renderer/src/store';
import type { AgentSessionHistoryPage } from '@agentmux/core';
import type { AgentSessionControl, AppConfig, SessionSnapshot, SessionQuestionReplyInput } from '../../../src/shared/contracts';
import '../../../src/renderer/src/styles/index.css';
import './preview.css';
const scene: {
  page: AgentSessionHistoryPage;
  config: AppConfig;
  sessions: SessionSnapshot[];
  draft: string;
} = await (await fetch('/public-scene.json')).json();
const session = scene.sessions.find(session => session.kind === 'agent')!;
if (session.kind !== 'agent') throw Error('The actual public scene must retain its Agent Session');
const control: AgentSessionControl = session.control;
const submissions: SessionQuestionReplyInput[] = [],
  copies: string[] = [],
  forbiddenControls: string[] = [],
  reads: string[] = [];
api.sessions.historyPage = async target => {
  reads.push(target.agentSessionId);
  return scene.page;
};
// Only transport is controlled in the visual scene. The owning test crosses actual Main/Core/FileStore.
api.sessions.replyQuestion = async (target, input) => {
  submissions.push(structuredClone(input));
  return {
    agentSessionId: target.agentSessionId,
    source: input.source,
    recordId: input.recordId,
    questionIds: input.answers.map(answer => answer.questionId),
    operationId: input.operationId,
    outcome: 'submitted'
  };
};
api.ui.writeClipboardText = async text => {
  copies.push(text);
};
for (const action of ['write', 'paste', 'resume', 'recover', 'stop'] as const) api.sessions[action] = async () => {
  forbiddenControls.push(action);
  throw Error('This reading preview never controls a Run');
};
useAppStore.setState({
  config: scene.config,
  sessions: scene.sessions,
  agentComposerDrafts: {
    [session.id]: scene.draft
  },
  timelines: {}
});
Object.assign(window, {
  questionPreview: {
    scene,
    submissions,
    copies,
    forbiddenControls,
    reads
  }
});
function Scene() {
  const [history, setHistory] = useState(false),
    [draft, setDraft] = useState(scene.draft);
  return <main className="question-preview"><header><div><strong>Conversation</strong><small>Original Session · Native questions</small></div><button
    type="button"
    aria-pressed={history}
    onClick={() => setHistory(!history)}
  >{history ? 'Return to conversation' : 'History'}</button></header><div className="question-preview__reading"><div
    className="question-preview__surface"
    inert={history}
    style={{
        display: history ? 'none' : 'flex'
      }}
  ><ActivityView
        sessionId={session.id}
        capability="complete-events"
        displayState="done"
        items={[]}
        nativeHistoryPage={scene.page}
        onReplyQuestion={input => replyConversationQuestion(control, input)}
      /></div><div
        className="question-preview__surface"
        style={{
        display: history ? 'flex' : 'none'
      }}
      ><ActivityView {...activityReadingProps({ control: control, readingKey: "original-run", label: session.label, visible: history, returnLabel: "Conversation", workspaceRoot: "", openWorkspaceFile: async () => {}, openHttpLink: () => {}, onClose: () => setHistory(false), onReplyQuestion: input => replyConversationQuestion(control, input) })} /></div></div><footer><textarea
        aria-label="Original draft"
        value={draft}
        onChange={event => setDraft(event.target.value)}
      /></footer></main>;
}
createClientUiRoot(document.getElementById('root')!).render(<Scene />);
