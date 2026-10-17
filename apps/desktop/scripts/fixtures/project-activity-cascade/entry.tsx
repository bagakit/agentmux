import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { api } from '../../../src/renderer/src/lib/api'
import { agentRegionExecution, useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../../../src/shared/space-addresses'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { ProjectActivity } from '../../../src/renderer/src/components/ProjectActivity'
import { AgentInformationPreviewHost } from '../../../src/renderer/src/components/AgentInformationPreview'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

const bridge = (window as any).activityCascadeBridge
mountThemeRuntime(window, { appAppearance: 'dark' })
api.spatial.read = bridge.read
api.spatial.commit = bridge.commit
api.spatial.retainLabels = bridge.retainLabels
api.spatial.onChange = bridge.onChange
api.ui.requestStorageFlush = bridge.flush
const originalConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base) throw new Error('The maintained typed preview must contain an Agent')
const workspace = { ...originalConfig.workspaces[0]!, id: 'activity-project', hostId: 'local', path: fixturePath('fixture/activity-project'), name: 'AgentMux', kind: 'folder' as const }
const worktree = { ...workspace, id: 'activity-review', path: fixturePath('fixture/activity-review'), name: 'AgentMux review', kind: 'worktree' as const, branch: 'review/activity' }
const scratch = { ...workspace, id: '__scratch__', path: fixturePath('fixture/activity-notes'), name: 'Notes' }
const topic = { id: 'activity-mote', title: 'Release coordination', summary: '', kind: 'mote' as const, directoryPath: 'activity-mote',
  physicalDirectoryPath: fixturePath('fixture/activity-notes/activity-mote'), identityDirectoryPath: fixturePath('fixture/activity-notes/activity-mote'),
  confirmedDirectoryPaths: [fixturePath('fixture/activity-notes/activity-mote')], topicPath: 'activity-mote/topic.md', collaborators: [] }
const now = Date.now(), longReply = Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 段：保留原会话、输入与选区。正在核对活跃 Agent 的进展，移动到浮窗可以继续阅读；位置和执行身份由各自的原始事实确定。`).join('\n\n')
const definitions = [
  ['activity-a', 'Core · durable session recovery', 'working', workspace.path],
  ['activity-b', 'Desktop · activity cascade polish', 'waiting', workspace.path],
  ['activity-c', 'Review · interaction and density', 'working', worktree.path],
  ['activity-orphan', 'Review · no confirmed position', 'error', workspace.path],
  ['activity-mote-agent', 'Mote · release coordination', 'working', topic.physicalDirectoryPath]
] as const
const sessions = definitions.map(([id, label, state, workspacePath]) => ({ ...base, id, label, hostId: 'local', workspacePath,
  createdAt: now - 60000, updatedAt: now, agentSessionUpdatedAt: now, processState: 'running' as const,
  status: { state, source: 'native-hook' as const, observedAt: now },
  semanticStatus: { state, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - 20000 },
  control: { ...base.control, hostId: 'local', agentSessionId: id, run: { runId: `preview-${id}` } } }))
const timelines = Object.fromEntries(sessions.map(session => [session.id, { agentSessionId: session.id, revision: 1, items: [
  { id: `${session.id}-request`, agentSessionId: session.id, kind: 'user_message', title: 'Prompt', content: '检查活跃状态入口、位置与完整阅读。', status: 'complete', source: 'native-hook', createdAt: now - 30000, updatedAt: now - 30000 },
  { id: `${session.id}-reply`, agentSessionId: session.id, kind: 'assistant_message', title: 'Reply', content: session.id === 'activity-a' ? longReply : '正在验证同一 Agent 身份、状态和进展的共享阅读入口。', status: 'complete', source: 'native-hook', createdAt: now - 1000, updatedAt: now - 1000 }
] }]))
const spaceId = directoryIdentity('local', workspace.path), zoneId = workspaceZoneId(spaceId, workspace.id), reviewZone = workspaceZoneId(spaceId, worktree.id)
const moteSpace = directoryIdentity('local', topic.identityDirectoryPath), moteZone = homeZoneId(moteSpace)
let first = { ...createWorkbenchTab('activity-main-tab', { regionId: 'activity-a-left', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'activity-a' }), name: 'Core runtime', space: { spaceId, zoneId } }
first = addWorkbenchRegion(first, 'activity-a-left', 'right', { regionId: 'activity-b-right', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'activity-b' }) as typeof first
const second = { ...createWorkbenchTab('activity-second-tab', { regionId: 'activity-a-second', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'activity-a' }), name: 'Recovery check', space: { spaceId, zoneId } }
const review = { ...createWorkbenchTab('activity-review-tab', { regionId: 'activity-review-region', kind: 'agent', phase: 'attached', workspaceId: worktree.id, sessionId: 'activity-c' }), name: 'Visual review', space: { spaceId, zoneId: reviewZone } }
const mote = { ...createWorkbenchTab('activity-mote-tab', { regionId: 'activity-mote-region', kind: 'agent', phase: 'attached', workspaceId: scratch.id, sessionId: 'activity-mote-agent' }), name: 'Coordination', topicId: topic.id, space: { spaceId: moteSpace, zoneId: moteZone } }
const tabs = Object.fromEntries([first, second, review, mote].map(tab => [tab.id, tab]))
const config = { ...originalConfig, workspaces: [workspace, worktree, scratch], hosts: originalConfig.hosts.filter(host => host.id === 'local'), executors: {} }
api.config.get = async () => config
api.sessions.snapshot = async () => ({ ...snapshot, sessions, timelines: timelines as any, recoveryCandidates: [] })
api.scratch.listTopics = async id => id === scratch.id ? [topic] : []
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
const controls: string[] = []
for (const name of ['stop', 'resume', 'launchAgent', 'write', 'interrupt'] as const) {
  const operation = api.sessions[name] as (...args: any[]) => any
  ;(api.sessions as any)[name] = (...args: any[]) => { controls.push(name); return operation(...args) }
}
const arranged = { loading: false, config, sessions, timelines: timelines as any, tabs, layouts: {
  [workspace.id]: createWorkspaceLayout('activity-main-group', [first.id, second.id]),
  [worktree.id]: createWorkspaceLayout('activity-review-group', [review.id]),
  [scratch.id]: createWorkspaceLayout('activity-mote-group', [mote.id]) },
  activeWorkspaceId: workspace.id, mainSurface: 'workbench' as const, spaceZoneBindings: {
    [zoneId]: { spaceId, workspaceId: workspace.id }, [reviewZone]: { spaceId, workspaceId: worktree.id },
    [moteZone]: { spaceId: moteSpace, workspaceId: scratch.id, topicId: topic.id, contentKind: 'mote' as const, directoryPath: topic.physicalDirectoryPath }
  }, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], error: null, reading: false } },
  agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])),
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, workbenchSpaceSelection: null,
  agentComposerDrafts: { 'activity-a': '原 Agent 草稿与会话必须保留。' }, error: null, lastError: null, errorDismissed: false }
useAppStore.setState(arranged)
if (await api.spatial.read()) throw new Error('Private spatial seed may only be created once')
await api.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), [topic]) })
await useAppStore.getState().initialize()
useAppStore.setState(arranged)
const execution = agentRegionExecution({ tabId: first.id, regionId: 'activity-a-left', agentSessionId: 'activity-a' })
if (execution?.hostId !== 'local') throw new Error('Original Core spatial execution identity did not reach its actual Store consumer')
const references = { sessions: useAppStore.getState().sessions, drafts: useAppStore.getState().agentComposerDrafts }
function Scene() {
  const current = useAppStore(state => state.sessions)
  return <div style={{ height: '100%', background: 'var(--bg-0)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: '16px' }}><strong>AgentMux</strong><ProjectActivity sessions={current} /></header>
    <main style={{ flex: 1, padding: '20px', border: '1px solid var(--border-0)', borderRadius: 'var(--radius-md)' }}>
      <h2>Core runtime</h2><p>The workface stays available while inspecting Agent activity.</p>
      <input aria-label="Original workface input" defaultValue="保留原输入和选区" style={{ width: '100%', maxWidth: '520px', padding: '10px' }} />
    </main><AgentInformationPreviewHost /><WindowOverlayHost />
  </div>
}
createClientUiRoot(document.getElementById('root')!).render(<Scene />)
Object.assign(window, { activityCascadeScene: { ready: true, zoneId, reviewZone, moteZone, longReply,
  facts() { const state = useAppStore.getState(); return { activeWorkspaceId: state.activeWorkspaceId, selection: state.workbenchSpaceSelection,
    selectedId: state.agentFocus.execution.sessionId, selectedMoteId: state.agentFocus.pmo.sessionId, mainSurface: state.mainSurface,
    controls: [...controls], draft: state.agentComposerDrafts['activity-a'], sameDrafts: state.agentComposerDrafts === references.drafts,
    sameSessions: state.sessions === references.sessions, error: state.error, input: (document.querySelector('[aria-label="Original workface input"]') as HTMLInputElement)?.value,
    executions: Object.values(tabs).flatMap(tab => Object.values(tab.regions).filter(region => region.kind === 'agent').map(region => ({ tabId: tab.id, regionId: region.regionId,
      value: agentRegionExecution({ tabId: tab.id, regionId: region.regionId, agentSessionId: (region as any).sessionId }) }))) } }
} })
