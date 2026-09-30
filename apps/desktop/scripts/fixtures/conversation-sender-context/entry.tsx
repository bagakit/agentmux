import { createRoot } from 'react-dom/client'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AppConfig, SessionSnapshot, AgentTimelineSnapshot } from '../../../src/shared/contracts'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'

// This file is copied from the owning run's real public reader output, not hand-authored Human/source DTOs.
const input = await fetch('./scene-inputs.json').then(response => { if (!response.ok) throw new Error('Public scene input missing'); return response.json() }) as {
  schema: string; config: AppConfig; sessions: Extract<SessionSnapshot, { kind: 'agent' }>[]; demands: Record<string, DemandRecord>; timeline: AgentTimelineSnapshot; page: AgentSessionHistoryPage
}
if (input.schema !== 'agentmux.conversation-sender-public-scene.v1' || input.page.items.length !== 2 || input.sessions.length !== 4) throw new Error('Nonempty public scene input required')
const id = input.page.agentSessionId, reads: unknown[] = [], appearances: string[] = [], controls: string[] = []
api.sessions.historyPage = async (control, options) => { reads.push({ control, options }); return input.page }
api.workspaces.appearance = async workspaceId => { appearances.push(workspaceId); return { kind: 'directory', icon: null } }
api.continuousProgress.pauseForInput = async () => {}
for (const name of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) api.sessions[name] = async () => { controls.push(name); throw new Error(`Source preview forbids ${name}`) }
useAppStore.setState({ config: input.config, sessions: input.sessions, demands: input.demands, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
  viewModes: { [id]: 'activity' }, timelines: { [id]: input.timeline }, agentNames: {}, agentComposerDrafts: { [id]: 'Keep this existing reply draft.' }, agentSteerQueues: {} })
Object.assign(window, { senderContextPreview: { sessionId: id, rawIds: input.page.items.map(item => item.id), reads, appearances, controls,
  draft: () => useAppStore.getState().agentComposerDrafts[id],
  renameSender() { useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'sender-context-declared': 'Current sender with a long deliberate name for width testing' },
    config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => workspace.id === 'sender-project' ? { ...workspace, name: 'Current sender project with a descriptive name', branch: 'feature/precise-current-context' } : workspace) } })) },
  removeSender() { useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== 'sender-context-declared') })) }
} })
createRoot(document.getElementById('root')!).render(<main className="sender-context-preview">
  <p>Private public-reader Source scene · current metadata on explicit open · no Agent Run</p>
  <div className="sender-context-preview__pane"><SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'recipient-project', tabGroupId: 'private-source-group', tabId: 'private-source-tab', regionId: 'private-source-region' }} /></div>
</main>)
