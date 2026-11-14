import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { AgentInformationPreviewHost } from '../../../src/renderer/src/components/AgentInformationPreview'
import { WorkspaceAgentRow } from '../../../src/renderer/src/components/WorkspaceAgentRow'
import { ExecutorIdentityContext } from '../../../src/renderer/src/components/AgentAvatar'
import { agentContextForSession } from '../../../src/renderer/src/lib/focus-context'
import { registerWorkbenchDocument } from '../../../src/renderer/src/lib/workbench-window-registry'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AgentTakeoverProvenance, AgentTakeoverRecord } from '@agentmux/core/agent-takeover'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'research', name: 'Product architecture', hostId: 'local', path: '/project/research', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } }
const provenance: AgentTakeoverProvenance = {
  source: { hostId: 'local', runtimeId: 'research-runtime', agentSessionId: 'architecture-research', run: { runId: 'research-run' },
    organization: { kind: 'project', title: 'Product architecture · research and implementation', organizationId: 'research', reference: { runtimeId: 'research-runtime', spaceId: 'research-space' } } },
  destination: { owner: { runtimeId: 'admission-runtime' }, address: { spaceId: 'research-club', zoneId: 'club-home', workspaceId: 'clubs', displayWorkspaceId: 'research', groupId: 'research-group', tabId: 'continuing-work', regionId: 'new-agent' },
    organization: { kind: 'mote', title: 'Product research Club · long-running decisions and careful follow-through', organizationId: 'product-research', reference: { runtimeId: 'admission-runtime', spaceId: 'research-club' } } }, nature: 'promotion'
}
const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: 'reviewing-agent', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/project/research',
  label: 'Architecture review · keep the original work intact', promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, createdAt: 1, updatedAt: 1,
  latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
  creation: { createOperationId: 'original-source-operation', takeover: provenance },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'reviewing-agent', run: { runId: 'reviewing-run' } } }
let mode = 'normal'
const owner = (runtimeId: string) => ({ owner: { runtimeId, ownerInstanceId: 'instance-' + runtimeId, protocolVersion: 2 as const, processId: null, availability: 'connected' as const, ctxmux: null } })
api.spatial.owner = async () => owner('admission-runtime')
api.sessions.owner = async () => owner('research-runtime')
api.sessions.creation = async () => {
  if (mode === 'unknown') throw Error('The original source owner is temporarily unavailable. Keep this reading and refresh its original source.')
  return { kind: 'agent', hostId: 'local', agentSessionId: session.control.agentSessionId, providerId: 'codex', executorId: 'codex', workspacePath: session.workspacePath,
    run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 1, creation: session.creation }
}
api.sessions.takeovers = async query => {
  if (mode === 'unknown') throw Error('Recorded Takeovers cannot be read from the selected admission owner. Existing work remains available.')
  const native: AgentTakeoverProvenance = { ...provenance, source: { ...provenance.source, agentSessionId: null, run: null, organization: null,
    nativeSource: { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-provider-conversation' }, workspacePath: '/project/research', revision: 'confirmed-provider-revision' }, executorId: 'codex' }, nature: null }
  const incoming: AgentTakeoverRecord = { requestId: 'original-parent-operation', agent: { hostId: 'local', runtimeId: query.subject.runtimeId, agentSessionId: query.subject.agentSessionId, run: session.control.run },
    takeover: mode === 'native' ? native : provenance, phase: 'active', issue: null }
  const outgoing: AgentTakeoverRecord[] = ['thread-follow-through', 'completed-investigation', 'pending-confirmation'].map((id, index) => ({ requestId: 'takeover-' + id,
    agent: { hostId: 'local', runtimeId: index === 2 ? null : 'successor-runtime', agentSessionId: id, run: index === 2 ? null : { runId: 'run-' + id } },
    takeover: { ...provenance, source: { ...provenance.source, agentSessionId: query.subject.agentSessionId }, nature: index === 0 ? 'promotion' : index === 1 ? 'transfer' : null },
    phase: index === 1 ? 'retired' : index === 2 ? 'unconfirmed' : 'active', issue: index === 2 ? 'The original creation result is not confirmed. Its admitted position and source are retained.' : null }))
  return { owner: { runtimeId: query.expectedRuntimeId, ownerInstanceId: 'admission-instance' }, direction: query.direction, subject: query.subject,
    records: mode === 'empty' ? [] : query.direction === 'incoming' ? [incoming] : query.cursor ? outgoing.slice(1) : outgoing.slice(0, 1),
    nextCursor: mode !== 'empty' && query.direction === 'outgoing' && !query.cursor ? 'next-original-page' : null,
    coverage: { scope: 'selected-owner', history: 'recorded-takeovers' } }
}
const forbidden: string[] = []
for (const name of ['launchAgent', 'recover', 'submitPrompt'] as const) Object.assign(api.sessions, { [name]: async () => { forbidden.push(name); throw Error('This Source reading cannot control an Agent.') } })
useAppStore.setState({ config, sessions: [session], loading: false, tabs: {}, layouts: {}, mainSurface: 'agents', agentNames: {}, agentComposerDrafts: { [session.id]: 'Keep this original draft. Reading Source does not send it.' } })
mountThemeRuntime(window, config.appearance)
registerWorkbenchDocument(document, { windowId: 'source-review-window', documentGeneration: 'source-review-document' })
const context = { ...agentContextForSession(session, undefined, session.label, config.workspaces[0]),
  access: { identity: { runtimeId: 'research-runtime', agentSessionId: session.control.agentSessionId }, session, locations: [], select() {}, open() {}, refresh() {}, isCurrent: () => true } }
createClientUiRoot(document.getElementById('root')!).render(<ExecutorIdentityContext.Provider value={{ config }}><AgentInformationPreviewHost />
  <main style={{ padding: 32, maxWidth: 760, margin: '0 auto', color: 'var(--text)' }}><p style={{ color: 'var(--text-3)', fontSize: 12 }}>Product architecture</p><h2 style={{ fontWeight: 500 }}>The original work continues.</h2>
    <div style={{ width: 300, maxWidth: '100%' }}><WorkspaceAgentRow context={context} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => { forbidden.push('navigate') }} /></div>
    <textarea aria-label="Original draft" defaultValue={useAppStore.getState().agentComposerDrafts[session.id]} style={{ width: '100%', minHeight: 100, marginTop: 32 }} />
  </main></ExecutorIdentityContext.Provider>)
Object.assign(window, { takeoverSourceProbe: { ready: true, mode(value: string) { mode = value }, theme(value: 'light' | 'dark') { updateThemeSelection({ ...config.appearance, appAppearance: value }) },
  facts: () => ({ forbidden, draft: useAppStore.getState().agentComposerDrafts[session.id], sessionId: session.control.agentSessionId, runId: session.control.run.runId }) } })
