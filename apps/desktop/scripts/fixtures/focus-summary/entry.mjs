import '../focus-context-card-interaction/entry.mjs'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useAppStore } from '../../../src/renderer/src/store'
import { createAgentInformationRoot } from '../../../test/helpers/agent-information-root'

// Extend the maintained typed preview scene with exact source-qualified held
// recaps. Production Global/Row/Reader/projection and input owners stay intact.
mountThemeRuntime()
const readerHost = document.createElement('div'); document.body.append(readerHost)
createAgentInformationRoot(readerHost).render(null)
const held = useAppStore.getState(), template = held.timelines['recap-a']
const completeReason = 'Original Runtime interrupted this Run. 原 Session、草稿和已记录回复仍保留；请在原工作面核对并恢复，不创建替代会话。'
const originalReply = '历史摘录：已核对调用链与滚动锚点，下一步比较窄窗口。原文与准确来源保留，不能把历史摘录当作当前执行结果。'
useAppStore.setState({
  sessions: held.sessions.map(session => session.id === 'offline' ? { ...session, processState: 'interrupted', status: { state: 'running', source: 'run-process', observedAt: Date.now(), detail: completeReason } }
    : session.id === 'recap-b' ? { ...session, status: { state: 'running', source: 'run-process', observedAt: Date.now() } } : session),
  agentNames: { ...held.agentNames, 'recap-a': '核对滚动锚点与保留原会话', 'recap-b': '未知活动保持原工作能力', offline: '恢复原工作面并接续已有任务' },
  timelines: { ...held.timelines, ...Object.fromEntries(['offline', 'recap-b'].map(id => [id, { ...template, agentSessionId: id,
    items: [{ id: 'held-reply-' + id, agentSessionId: id, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: originalReply, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000 }]
  }])) }
})
const summaryBaseline = useAppStore.getState()
Object.assign(window.cardInteractionScene, { summaryReady: true, completeReason, originalReply,
  theme: appearance => updateThemeSelection({ appAppearance: appearance }),
  summaryFacts: () => ({ sessionRefsPreserved: useAppStore.getState().sessions === summaryBaseline.sessions, timelineRefsPreserved: useAppStore.getState().timelines === summaryBaseline.timelines, sessions: useAppStore.getState().sessions.map(session => ({ id: session.id, runId: session.control.run.runId, processState: session.processState })), draft: useAppStore.getState().agentComposerDrafts['recap-b'], selected: useAppStore.getState().agentFocus.execution.sessionId })
})
