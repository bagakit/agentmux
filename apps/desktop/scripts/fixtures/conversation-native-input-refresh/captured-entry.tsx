import { createRoot } from 'react-dom/client'
import type { AgentSessionHistoryDescriptor, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const sample: { config: AppConfig; sessions: SessionSnapshot[]; agentFocus: ReturnType<typeof useAppStore.getState>['agentFocus']; timeline: AgentTimelineSnapshot; nativePage: AgentSessionHistoryPage; historySources: AgentSessionHistoryDescriptor[] } = await (await fetch('./public-captured-reader.json')).json()
const controls: string[] = [], reads: string[] = []
api.sessions.historySources = async () => sample.historySources
api.sessions.historyPage = async reference => { reads.push(reference.agentSessionId); if (reference.agentSessionId !== sample.nativePage.agentSessionId) throw new Error('This private scene contains only its exact selected source.'); return sample.nativePage }
api.sessions.observeHistory = async () => { throw Object.assign(new Error('The private captured input adapter did not provide an automatic observer; Refresh remains available.'), { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' }) }
api.scratch.listTopics = async () => []
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/private' })
api.workspaces.appearance = async () => ({ kind: 'directory', icon: null })
for (const key of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) api.sessions[key] = async () => { controls.push(key); throw new Error('Private source scene forbids Run control') }
useAppStore.setState({ config: sample.config, sessions: sample.sessions, timelines: { [sample.timeline.agentSessionId]: sample.timeline },
  tabs: {}, layouts: {}, recoveryCandidates: [], agentNames: {}, mainSurface: 'agents', activeWorkspaceId: sample.config.workspaces[0]?.id ?? null, agentFocus: sample.agentFocus })
Object.assign(window, { capturedRefreshPreview: { controls, reads, sample } })
createRoot(document.getElementById('root')!).render(<main className="native-refresh-preview" style={{ width: 1000, maxWidth: '100%' }}>
  <header className="native-refresh-preview__header"><strong>Focus · native and accepted captured inputs</strong><span>Private public producer records · identities preserved</span></header>
  <section className="native-refresh-preview__focus"><GlobalFocusSurface /></section>
</main>)
