import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { api } from '../../../src/renderer/src/lib/api'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { SessionHistoryView } from '../../../src/renderer/src/components/SessionHistoryView'
import { ConversationAnnotationNote, type ConversationAnnotationNoteHandle } from '../../../src/renderer/src/components/ConversationAnnotationNote'
import { createSpeakerResolver } from '../../../src/renderer/src/lib/conversation-speaker'
import type { AgentSessionControl } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'

const id = 'private-chat-reader'
const at = (day: number, h: number, m: number, s = 0) => new Date(2026, 9, day, h, m, s).getTime()
const item = (key: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({
  id: key, agentSessionId: id, source: 'native-hook', kind: 'assistant_message', status: 'complete', title: 'Message',
  createdAt: at(4, 0, 4), updatedAt: at(4, 0, 4), ...overrides
})
const captured = [
  item('manual', { source: 'user', kind: 'user_message', authorHuman: true, content: '把聊天做清楚：我发的消息放右边，其他 Agent 的消息要一眼认出来。', createdAt: at(2, 0, 0) }),
  item('peer', { source: 'user', kind: 'user_message', authorAgentSessionId: 'review-agent', content: '已复核读取边界。保留原消息 ID、选区与草稿，工具结果继续按需展开。', createdAt: at(4, 0, 3) }),
  item('peer-long', { source: 'user', kind: 'user_message', authorAgentSessionId: 'long-agent', content: '同 Provider 的 Agent 也有自己的名字和身份；不能把这条误认成当前 Agent 的回答。', createdAt: at(4, 0, 3, 20) }),
  item('legacy', { source: 'user', kind: 'user_message', content: '再检查一下窄分栏里的阅读体验。', createdAt: at(4, 0, 5) })
]
const messages = projectSessionUserMessages({ agentSessionId: id, timeline: { agentSessionId: id, revision: 1, items: captured } })
const items = [
  item('system-context', { source: 'agentmux', kind: 'system_message', title: 'AgentMux runtime context', createdAt: at(2, 0, 0), updatedAt: at(2, 0, 0), content: '## AgentMux runtime guide\n\nYou are running inside AgentMux. Your Session, View, Region and Workspace identify the current working surface.\n\n- Read the existing page before acting on its named elements.\n- Keep the original working surface and healthy Agent Run.\n- Split where both the old and new content stay readable.\n- Use the public Core API for Agent lifecycle and interaction requests.\n\nThis private scene consumes a declared system record. The public create/FileStore writer is verified separately; the UI never infers System from this text.' }),
  item('step-1', { kind: 'tool_call', title: 'Read', toolName: 'read_file', toolInput: '{"path":"src/conversation.tsx"}', createdAt: at(3, 23, 59, 40), updatedAt: at(4, 0, 2, 30) }),
  item('step-2', { kind: 'tool_call', title: 'Test', toolName: 'shell', toolInput: '{"command":"check message identity"}', toolOutput: '7 checks passed', createdAt: at(4, 0, 0), updatedAt: at(4, 0, 1) }),
  item('answer', { content: '### 同一个聊天阅读面\n\n用户消息靠右，协作消息有独立来源，当前 Agent 的回答保持开放宽度。\n\n- 名字和时间可以直接扫读\n- 正文与代码都从左边读起\n- 复制和划线便签沿用原文与原 ID\n\n```ts\nconst author = recordedAuthor\n// display defaults do not rewrite the source\n```' })
]
const page: AgentSessionHistoryPage = { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: 'private-native-chat' }, items: [
  { id: 'history-user', kind: 'user-message', startedAt: at(4, 0, 0), contentParts: [{ kind: 'text', text: '保留同一套用户样式。原始作者元数据不会因为显示默认而改写。' }] },
  { id: 'history-answer', kind: 'assistant-message', startedAt: at(4, 0, 1), contentParts: [
    { kind: 'reasoning', text: '将正文、思考和工具分开，让阅读先落在回答上。\n\n**原文与身份**保持，折叠内容按需加载。' },
    { kind: 'text', text: '### History 继续复用共同组件\n\n这条回答与聊天使用同样的字体、层级和复制动作。' },
    { kind: 'tool-result', name: 'checks', callId: 'history-tool', output: 'Identity and record order preserved.' }
  ] }
], nextCursor: null }
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'private-display-only-run' } }
const describeSpeaker = createSpeakerResolver({ currentSession: { id, label: 'Implementation', providerId: 'codex' }, lookupAgent: sid =>
  sid === 'review-agent' ? { label: 'Review Agent', providerId: 'claude' } : sid === 'long-agent' ? { label: 'Interface review / 长名字的协作 Agent', providerId: 'claude' } : undefined })
const reads: unknown[] = [], copies: string[] = [], controls: string[] = []
api.sessions.historyPage = async (...args) => { reads.push(args); return page }
api.ui.writeClipboardText = async text => { copies.push(text) }
for (const name of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) api.sessions[name] = async () => { controls.push(name); throw new Error('Private display scene forbids Run control') }
Object.assign(window, { chatPreview: { reads, copies, controls, originalMessages: messages, control } })
function Scene() {
  const history = new URLSearchParams(location.search).get('mode') === 'history'
  const regionRef = useRef<HTMLDivElement>(null)
  const annotationRef = useRef<ConversationAnnotationNoteHandle>(null)
  const onSelectAnnotation = (selection: Parameters<ConversationAnnotationNoteHandle['select']>[0]) => annotationRef.current?.select(selection, id)
  const [draft, setDraft] = useState('Keep this existing reply draft.')
  return <main className="chat-preview">
    <div className="chat-preview__toolbar"><strong>{history ? 'Conversation history' : 'Conversation'}</strong><span>Private actual Renderer · controlled public records · no Agent Run</span></div>
    <div className="chat-preview__reading" ref={regionRef}>
      {history ? <SessionHistoryView control={control} visible label="Implementation" themeId="graphite" fontSize={12} workspaceRoot="/private-chat"
        describeSpeaker={describeSpeaker} onSelectAnnotation={onSelectAnnotation} openWorkspaceFile={() => {}} openHttpLink={() => {}} onClose={() => {}} /> :
        <ActivityView sessionId={id} capability="complete-events" displayState="done" items={items} userMessages={messages} describeSpeaker={describeSpeaker} onSelectAnnotation={onSelectAnnotation} />}
    </div>
    <ConversationAnnotationNote ref={annotationRef} regionRef={regionRef} sessionId={id} active onAnnotate={note => setDraft(value => `${value}\n\nRegarding ${note.messageId}: ${note.quote}\n${note.note}`)} />
    <label className="chat-preview__draft"><textarea aria-label="Reply draft" value={draft} onChange={e => setDraft(e.target.value)} /></label>
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
