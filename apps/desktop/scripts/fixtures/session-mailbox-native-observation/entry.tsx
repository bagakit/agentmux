import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentSessionHistoryObservation, AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { SessionMailbox } from '../../../src/renderer/src/components/SessionMailbox'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const sample: { control: AgentSessionControl; sessions: SessionSnapshot[]; config: AppConfig; earlierPages: AgentSessionHistoryPage[]; latest: AgentSessionHistoryPage } = await (await fetch('./public-reader-pages.json')).json()
const listeners = new Set<(observation: AgentSessionHistoryObservation) => void>(), reads: string[] = [], controls: string[] = []
let latest = false, failRead = false, unsupported = false
api.sessions.historyPage = async (reference, options) => {
  reads.push(reference.agentSessionId)
  if (failRead) throw new Error('The native source could not be read. Existing messages are kept.')
  if (!options?.cursor) return latest ? sample.latest : sample.earlierPages[0]!
  const previous = sample.earlierPages.findIndex(page => page.nextCursor === options.cursor)
  if (previous < 0 || !sample.earlierPages[previous + 1]) throw new Error('This private sample ends at its three recorded pages.')
  return sample.earlierPages[previous + 1]!
}
api.sessions.observeHistory = async (_reference, listener, options) => {
  if (unsupported) throw Object.assign(new Error('This source cannot be automatically observed. Refresh remains available.'), { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' })
  listeners.add(listener); const dispose = () => { listeners.delete(listener) }; options?.signal?.addEventListener('abort', dispose, { once: true })
  return { source: sample.latest.source, dispose }
}
for (const key of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) api.sessions[key] = async () => { controls.push(key); throw new Error('No user Runtime control in the private reading scene') }
useAppStore.setState({ config: sample.config, sessions: sample.sessions, timelines: {}, noticeReadReceipts: {} })
const invalidate = () => { for (const listener of listeners) listener({ kind: 'invalidated', agentSessionId: sample.control.agentSessionId, source: sample.latest.source }) }
Object.assign(window, { mailboxNativePreview: { sample, reads, controls, listeners } })
function Scene() {
  const [draft, setDraft] = useState('Keep the original unsent reply draft.')
  return <main className="mailbox-native-preview" style={{ width: new URLSearchParams(location.search).get('width') === '332' ? 332 : 1000, maxWidth: '100%' }}>
    <header><strong>Mailbox · native source reading</strong><span>Private public reader pages · no user Runtime</span></header>
    <nav aria-label="Private source controls">
      <button onClick={() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.kind === 'agent' ? ({ ...session, updatedAt: session.updatedAt + 1, agentSessionUpdatedAt: (session.agentSessionUpdatedAt ?? 0) + 1, latestOutputBytes: 999 }) : session) }))}>Session facts only</button>
      <button onClick={() => { latest = true; invalidate() }}>Append source records</button>
      <button onClick={() => { failRead = true; invalidate() }}>Simulate read failure</button>
      <button onClick={() => { failRead = false; invalidate() }}>Restore source reading</button>
      <button onClick={() => { unsupported = true; for (const listener of listeners) listener({ kind: 'unavailable', agentSessionId: sample.control.agentSessionId, code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE', message: 'Automatic observation of this source is unavailable. Existing messages are kept.' }) }}>Observation unavailable</button>
    </nav>
    <section data-workbench-region-id="private-mailbox-region" className="mailbox-native-preview__region">
      <div className="composer"><div className="mailbox-native-preview__entry"><span>Read existing inputs</span><SessionMailbox system={{ available: true, notices: [], unread: [], acknowledge: () => {} }} queued={[]} control={sample.control} /></div>
        <label><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /></label>
      </div>
    </section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
