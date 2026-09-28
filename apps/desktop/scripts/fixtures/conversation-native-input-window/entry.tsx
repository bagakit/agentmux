import { createRoot } from 'react-dom/client'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'

const mode = new URLSearchParams(location.search).get('mode') ?? 'empty'
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: 'private-reading-agent', kind: 'agent', hostId: 'local', workspacePath: '/private-reading',
  label: 'Reading preview', providerId: 'codex', executorId: 'codex',
  agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, createdAt: 1, updatedAt: 1,
  processState: 'running', status: { state: 'done', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'private-reading-agent', run: { runId: 'private-reading-run' } }
}
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private preview' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'preview-project', hostId: 'local', path: '/private-reading', kind: 'folder', name: 'Private preview' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const source = { providerId: 'codex' as const, nativeSessionId: 'private-native-transcript' }
const latest: AgentSessionHistoryPage = {
  agentSessionId: session.id, source,
  items: Array.from({ length: 30 }, (_, i) => ({
    id: `assistant-${i}`, kind: 'assistant-message', contentParts: [{ kind: 'text', text: `Assistant record ${i + 1}` }]
  })), nextCursor: 'private-opaque-earlier'
}
const older: AgentSessionHistoryPage = {
  agentSessionId: session.id, source, nextCursor: null,
  items: [{ id: 'earlier-original-input', kind: 'user-message', contentParts: [{ kind: 'text', text: '这条较早的原生输入仍在。它没有记录作者，不能猜成人类。\n\n请让回答好读，思考与工具按需展开。' }] }]
}
const reads: unknown[] = []
const controls: string[] = []
let attemptedRead = 0
api.sessions.historyPage = async (control, options) => {
  reads.push({ control, options })
  attemptedRead++
  if (mode === 'loading' && attemptedRead === 1) return await new Promise(() => {})
  if (mode === 'error' && attemptedRead === 1) throw new Error('Native records are temporarily unavailable')
  if (options?.cursor) return older
  if (mode === 'populated' && options?.limit) return {
    ...latest, items: [{ id: 'recent-original-input', kind: 'user-message', contentParts: [{ kind: 'text', text: '保留原文、选区与草稿；较早消息可以继续阅读。' }] }]
  }
  return latest
}
for (const name of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) {
  api.sessions[name] = async () => { controls.push(name); throw new Error(`Private preview forbids ${name}`) }
}
useAppStore.setState({ config, sessions: [session], pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
  viewModes: { [session.id]: 'activity' }, timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [] } },
  agentNames: {}, agentComposerDrafts: { [session.id]: 'This draft stays with the original Session.' }, agentSteerQueues: {} })
Object.assign(window, { readingPreview: { reads, controls, sessionId: session.id, runId: session.control.run.runId } })
createRoot(document.getElementById('root')!).render(
  <main className="reading-preview">
    <p className="reading-preview__label">Private product scene · typed native-record transport · {mode}</p>
    <div className="reading-preview__pane"><SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible
      linkOrigin={{ workspaceId: 'preview-project', tabGroupId: 'preview-group', tabId: 'preview-tab', regionId: 'preview-region' }} /></div>
  </main>
)
