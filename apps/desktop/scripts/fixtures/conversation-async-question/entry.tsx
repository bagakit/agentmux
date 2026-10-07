import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const scene: { page: AgentSessionHistoryPage; config: AppConfig; sessions: SessionSnapshot[]; draft: string } =
  (window as unknown as { questionScene?: typeof scene }).questionScene ?? await (await fetch('/public-scene.json')).json()
const session = scene.sessions.find(session => session.kind === 'agent')!
if (session.kind !== 'agent') throw Error('The scene must retain its original Agent Session')
const question = scene.page.items.find(item => item.questionRequest)!, target = { source: scene.page.source, recordId: question.id, turnId: question.turnId! }
const key = questionReplyKey(session.id, target), copies: string[] = [], forbiddenControls: string[] = [], terminalVisits: unknown[] = []
const oldAttempt = { phase: 'unknown' as const, hostId: session.control.hostId, input: { ...target, operationId: 'original-operation', expectedRun: session.control.run, afterSubmissionId: 'original-predecessor', answers: [{ questionId: question.questionRequest!.questions[0]!.id, answer: 'Original frozen answer' }] }, diagnostic: { code: 'ORIGINAL_UNKNOWN', message: 'Original reply receipt remains unknown. Check the original terminal before answering.' } }
api.sessions.historyPage = async () => scene.page
api.sessions.onEvent = () => () => {}
api.sessions.attach = async control => {
  terminalVisits.push(control)
  const dataBytes = new TextEncoder().encode('Original terminal · original Run\r\nAnswer the original question here.\r\n')
  return { attachmentId: 'private-attachment', session: { ...session, latestOutputBytes: dataBytes.length }, currentSize: { cols: 80, rows: 24 }, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [{ runId: control.run.runId, startByte: 0, endByte: dataBytes.length, dataBytes }], gap: null, nextCursor: dataBytes.length } as Awaited<ReturnType<typeof api.sessions.attach>>
}
api.sessions.detach = async () => {}
api.ui.writeClipboardText = async text => { if (window.questionPreview.failCopy) throw Error('Clipboard unavailable; answer retained.'); copies.push(text) }
for (const action of ['write', 'paste', 'resume', 'recover', 'stop', 'replyQuestion'] as const) api.sessions[action] = async () => { forbiddenControls.push(action); throw Error('Question navigation never controls a Run') }
useAppStore.setState({ config: scene.config, sessions: scene.sessions, agentComposerDrafts: { [session.id]: scene.draft }, timelines: {}, viewModes: { [session.id]: 'activity' }, questionReplies: new URL(location.href).searchParams.has('fresh') ? {} : { [session.id]: { [key]: oldAttempt } }, questionReplyDrafts: {}, focusRegion: () => {}, workbenchSaveWarning: null })
declare global { interface Window { questionPreview: { failCopy: boolean; copies: string[]; forbiddenControls: string[]; terminalVisits: unknown[]; facts(): unknown; conflict(): void } } }
window.questionPreview = { failCopy: false, copies, forbiddenControls, terminalVisits, conflict: () => useAppStore.setState(state => ({ sessions: state.sessions.map(current => current.kind === 'agent' ? { ...current, nativeHandle: { kind: 'provider', providerId: scene.page.source.providerId, sessionId: 'changed-native-source' } } : current) })), facts: () => ({ copies, forbiddenControls, terminalVisits, drafts: useAppStore.getState().questionReplyDrafts, attempt: useAppStore.getState().questionReplies[session.id]?.[key], mode: useAppStore.getState().viewModes[session.id], currentSession: useAppStore.getState().sessions.find(current => current.id === session.id) }) }
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><main className="question-preview"><SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible readOnly={false} linkOrigin={{ workspaceId: scene.config.workspaces[0]?.id ?? 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }}/></main></DesktopClientUiProvider>)
