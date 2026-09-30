import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentSessionHistoryObservation, AgentSessionHistoryPage, AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { useSessionUserMessages } from '../../../src/renderer/src/lib/session-user-messages'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const sample: { now: number; control: AgentSessionControl; initial: AgentSessionHistoryPage; appended: AgentSessionHistoryPage; config: AppConfig; sessions: SessionSnapshot[]; historySources: AgentSessionHistoryDescriptor[] } = await (await fetch('./public-reader-pages.json')).json()
let page = sample.initial, failRead = false
const listeners = new Set<(event: AgentSessionHistoryObservation) => void>(), reads: string[] = [], controls: string[] = [], copies: string[] = []
api.sessions.historyPage = async reference => { reads.push(reference.agentSessionId); if (failRead) throw new Error('Native source could not be read. The current window is retained.'); return page }
api.sessions.observeHistory = async (_reference, listener, options) => {
  listeners.add(listener)
  const dispose = () => listeners.delete(listener)
  options?.signal?.addEventListener('abort', dispose, { once: true })
  return { source: page.source, dispose }
}
api.sessions.historySources = async () => sample.historySources
api.scratch.listTopics = async () => []
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/private' })
api.workspaces.appearance = async () => ({ kind: 'directory', icon: null })
api.ui.writeClipboardText = async text => { copies.push(text) }
for (const key of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) api.sessions[key] = async () => { controls.push(key); throw new Error('Private source scene forbids Run control') }
const config = { ...sample.config, workspaces: [{ id: 'native-project', hostId: 'local', name: 'Native reading', path: '/private', kind: 'folder' as const }] }
const sessions = sample.sessions.map(session => ({ ...session, workspacePath: '/private' }))
useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, layouts: {}, recoveryCandidates: [], agentNames: {}, mainSurface: 'agents', activeWorkspaceId: 'native-project',
  agentFocus: { execution: { sessionId: sample.control.agentSessionId, history: [] }, pmo: { sessionId: null } } })
const invalidate = () => { for (const listener of listeners) listener({ kind: 'invalidated', agentSessionId: sample.control.agentSessionId, source: page.source }) }
Object.assign(window, { nativeRefreshPreview: { reads, controls, copies, listeners, sample,
  append: () => { page = sample.appended; invalidate() }, fail: () => { failRead = true; invalidate() }, recover: () => { failRead = false; invalidate() } } })
function Conversation({ visible }: { visible: boolean }) {
  const read = useSessionUserMessages(sample.control, { enabled: visible })
  Object.assign(window, { nativeRefreshRead: read })
  return <ActivityView sessionId={sample.control.agentSessionId} items={[]} userMessages={read.messages} nativeHistoryPage={read.nativeHistoryPage}
    userMessageRead={{ loading: read.loading, error: read.error, observationError: read.observationError, windowFrozen: read.windowFrozen,
      hasMore: read.hasMore, onRetry: () => void read.refresh(), onReadEarlier: () => {} }} capability="complete-events" displayState="done" />
}
function Scene() {
  const [draft, setDraft] = useState('Keep the original unsent reply draft.'), [visible, setVisible] = useState(true)
  return <main className="native-refresh-preview" style={{ width: new URLSearchParams(location.search).get('width') === '332' ? 332 : 1000, maxWidth: '100%' }}>
    <header className="native-refresh-preview__header"><strong>Conversation · native reading</strong><span>Private recorded source · public Claude / FileStore page</span></header>
    <nav className="native-refresh-preview__actions" aria-label="Private source controls">
      <button type="button" onClick={() => { page = sample.appended; invalidate() }}>Append recorded inputs</button>
      <button type="button" onClick={() => { failRead = true; invalidate() }}>Simulate read failure</button>
      <button type="button" onClick={() => { failRead = false; invalidate() }}>Restore source reading</button>
      <button type="button" onClick={() => setVisible(value => !value)}>{visible ? 'Pause reading' : 'Return to reading'}</button>
    </nav>
    <section className="native-refresh-preview__conversation"><Conversation visible={visible} /></section>
    <label className="native-refresh-preview__draft"><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /></label>
    {visible ? <section className="native-refresh-preview__focus"><GlobalFocusSurface /></section> : <p className="native-refresh-preview__paused">Reading paused. The existing conversation and draft are kept.</p>}
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
