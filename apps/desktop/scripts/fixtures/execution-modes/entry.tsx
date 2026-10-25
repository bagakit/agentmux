import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { App } from '../../../src/renderer/src/App'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { workspaceProjectId } from '../../../src/renderer/src/lib/workspace-projects'
import { workspaceZoneId } from '../../../src/shared/space-addresses'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

// Real Core durable spatial storage is provided by this isolated Main owner.
const spatial = (window as typeof window & { executionModesSpatial: Pick<typeof api.spatial, 'read' | 'commit' | 'retainLabels' | 'onChange'> }).executionModesSpatial
Object.assign(api.spatial, spatial)
// Only machine/configuration/Session/API facts are controlled. The Renderer,
// Store, persistence, components, Editor and complete CSS are production source.
const local = { id: 'local', kind: 'local' as const, label: 'This Mac' }
const remote = { id: 'execution-host', kind: 'ssh' as const, label: 'Remote execution host', hostname: 'remote.example.invalid', user: 'developer' }
const otherRemote = { id: 'build-host', kind: 'ssh' as const, label: 'Build laboratory', hostname: 'build.example.invalid', user: 'developer' }
const project = { id: 'local-project', hostId: local.id, name: 'AgentMux', path: '/workspace/projects/agentmux', kind: 'folder' as const }
const remoteProject = { id: 'remote-project', hostId: remote.id, name: 'AgentMux server', path: '/srv/projects/agentmux', kind: 'folder' as const }
const runtime = { id: 'agent-environment', hostId: remote.id, name: 'Agent environment', path: '/srv/agent-runtime', kind: 'folder' as const }
const other = { id: 'build-project', hostId: otherRemote.id, name: 'Build tools', path: '/srv/projects/build-tools', kind: 'folder' as const }
const empty = { id: 'empty-project', hostId: local.id, name: 'New local project', path: '/workspace/projects/new-project', kind: 'folder' as const }
const baseConfig = await api.config.get()
const config = { ...baseConfig, appearance: { ...baseConfig.appearance, appAppearance: 'dark' as const, themeId: 'graphite' }, hosts: [local, remote, otherRemote], workspaces: [project, remoteProject, runtime, other, empty] }
api.config.get = async () => config
const original: SessionSnapshot = {
  id: 'retained-original-agent', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: remote.id, workspacePath: runtime.path,
  promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, label: 'Retained original work', createdAt: 1, updatedAt: 1,
  latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: remote.id, agentSessionId: 'retained-original-agent', run: { runId: 'retained-original-run' } },
  toolExecution: { bindingId: 'retained-original-binding', resourceHostId: local.id, resourceRuntimeId: 'local-runtime', workspacePath: project.path }
}
const snapshot = api.sessions.snapshot
api.sessions.snapshot = async () => ({ ...await snapshot(), sessions: [original] })
api.executors.discover = async hostId => ({ routeHostId: hostId, runtimeId: `controlled-runtime-${hostId}`, executors: [
  { executorId: 'codex', providerId: 'codex', label: 'Codex', command: 'codex', source: 'registered', configRevision: `revision-${hostId}`, availability: 'available' },
  { executorId: 'claude', providerId: 'claude', label: 'Claude', command: 'claude', source: 'registered', configRevision: `claude-revision-${hostId}`, availability: 'available' }
] })
const availableDiscovery = api.executors.discover
function inventory(kind: 'ready' | 'empty' | 'unavailable', hostId: string) {
  api.executors.discover = kind === 'ready' ? availableDiscovery : kind === 'empty'
    ? async routeHostId => ({ routeHostId, runtimeId: `controlled-runtime-${routeHostId}`, executors: [] })
    : async () => { throw new Error('The original Host observation is temporarily unavailable.') }
  return useAppStore.getState().detectExecutors(hostId, { source: 'host' })
}
const forbiddenCalls: string[] = [], launchRequests: unknown[] = []
let allowLaunch = false
api.sessions.launchAgent = async request => {
  if (!allowLaunch) forbiddenCalls.push('launchAgent')
  launchRequests.push(request)
  throw Object.assign(new Error('Controlled owner confirmed the original launch was not applied.'), { controlFailure: { disposition: 'not_applied' } })
}
for (const name of ['submitPrompt', 'stop', 'resume'] as const) Object.assign(api.sessions, {
  [name]: async () => { forbiddenCalls.push(name); throw new Error('The arrangement scene must not start or alter Agents: ' + name) }
})
let ready = false, restored = false, startupInvocations = 0
let refs: { local: { tabId: string; regionId: string }; remote: { tabId: string; regionId: string } }
function seedScene() {
restored = localStorage.getItem('execution-modes-proof-seeded') === 'yes'
if (!restored) {
  const retained = { ...createWorkbenchTab('retained-tab', { kind: 'agent', phase: 'attached', regionId: 'retained-region', workspaceId: project.id, sessionId: original.id }),
    space: { spaceId: workspaceProjectId(project), zoneId: workspaceZoneId(workspaceProjectId(project), project.id) } }
  useAppStore.setState({ projectRailOpen: true, toolsOpen: true, workspaceTool: 'files-branches', workspaceGitView: 'changes', config, sessions: [original], tabs: { 'retained-tab': retained },
    layouts: { [project.id]: createWorkspaceLayout('local-group', ['retained-tab']),
      [remoteProject.id]: createWorkspaceLayout('remote-group', []), [empty.id]: createWorkspaceLayout('empty-group', []) },
    activeWorkspaceId: project.id, mainSurface: 'workbench', loading: false,
    retainedSpatialFocus: null, workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
    agentComposerDrafts: { 'retained-region': 'Keep the original Agent draft unsent.' },
    launcherNameDrafts: {}, launcherOptionDrafts: {}, hostExecutorInventories: {}, executorDetections: {}, spaceZoneBindings: {} })
  const open = (workspace: typeof project, reveal: boolean) => {
    const tabId = useAppStore.getState().openLauncher({ workspaceId: workspace.id,
      zoneId: workspaceZoneId(workspaceProjectId(workspace), workspace.id), reveal })
    if (!tabId) throw new Error('The original Launcher operation did not create its exact workface')
    return { tabId, regionId: useAppStore.getState().tabs[tabId]!.layout.activeRegionId }
  }
  refs = { remote: open(remoteProject, false), local: open(project, true) }
  useAppStore.setState({ agentComposerDrafts: { [refs.local.regionId]: 'Review the execution flow and keep [local.md](agentmux-file:%40local.md) in this project.',
    [refs.remote.regionId]: 'Continue the server-side investigation.', 'retained-region': 'Keep the original Agent draft unsent.' },
    launcherNameDrafts: { [refs.local.regionId]: { agentName: 'Execution review', tabName: 'Local research' } },
    launcherOptionDrafts: { [refs.local.regionId]: { codex: { model: 'gpt-6.1' } } } })
  useLauncherState.setState({ sections: { [project.id]: { agents: 'expanded', terminal: 'collapsed', browser: 'collapsed', note: 'collapsed' },
    [remoteProject.id]: { agents: 'expanded', terminal: 'collapsed', browser: 'collapsed', note: 'collapsed' } }, drafts: {}, executors: {} })
  localStorage.setItem('execution-modes-proof-refs', JSON.stringify(refs))
  localStorage.setItem('execution-modes-proof-seeded', 'yes')
} else refs = JSON.parse(localStorage.getItem('execution-modes-proof-refs')!)
ready = true
}
const initialize = useAppStore.getState().initialize
useAppStore.setState({ initialize: async () => {
  startupInvocations += 1
  const dispose = await initialize()
  seedScene()
  return dispose
} })

const trustedEvents: { type: string; trusted: boolean; key?: string }[] = []
for (const type of ['click', 'keydown']) document.addEventListener(type, event => trustedEvents.push({ type, trusted: event.isTrusted,
  ...(event instanceof KeyboardEvent ? { key: event.key } : {}) }), true)
const io: { kind: string; workspaceId: string; path?: string; marker: string }[] = []
api.files.readDirectory = async (workspaceId, path) => {
  const marker = workspaceId + '.marker.md'; io.push({ kind: 'directory', workspaceId, path, marker })
  return path === '' ? [{ name: marker, path: marker, isDirectory: false, isSymlink: false }] : []
}
api.files.read = async (workspaceId, path) => {
  const marker = `File content from ${workspaceId}: ${path}`; io.push({ kind: 'file', workspaceId, path, marker })
  return { status: 'read', document: { path, content: '# Project marker\n\n' + marker, revision: `marker:${workspaceId}:${path}` } }
}
Object.assign(window, { agentmux: { git: {
  status: async (workspaceId: string) => {
    const resource = config.workspaces.find(item => item.id === workspaceId)!
    const marker = workspaceId + '.changed.md'; io.push({ kind: 'git-status', workspaceId, marker })
    return { kind: 'git-repository', hostId: resource.hostId, repoPath: resource.path, repoRelativePrefix: '', branch: 'main',
      changes: [{ path: marker, origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }] }
  }
} } })
function Scene() { return <App /> }

flushSync(() => createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><Scene /></DesktopClientUiProvider>))
Object.assign(window, { executionModesVisual: {
  get ready() { return ready }, get restored() { return restored }, get refs() { return refs }, io, project, remoteProject, runtime, other, empty, trustedEvents,
  theme(value: 'light' | 'dark') { updateThemeSelection({ appAppearance: value, themeId: 'graphite' }) },
  show(workspaceId: string) { flushSync(() => useAppStore.getState().selectWorkspace(workspaceId)) },
  checkpoint() { return prepareRendererUpdate('reload') },
  catalog() { return workbenchSelectionCatalog(useAppStore.getState()) },
  allowLaunch() { allowLaunch = true },
  inventory,
  unknown() { return inventory('unavailable', remote.id) },
  facts() { const state = useAppStore.getState(); return { tabs: state.tabs, layouts: state.layouts,
    activeWorkspaceId: state.activeWorkspaceId, sessions: state.sessions.filter(session => session.kind === 'agent'),
    drafts: state.agentComposerDrafts, names: state.launcherNameDrafts, options: state.launcherOptionDrafts,
    selection: state.workbenchSpaceSelection, documents: Object.entries(state.documents).map(([key, document]) => ({ key, path: document.path, content: document.content })), utilityDrafts: useLauncherState.getState().drafts, forbiddenCalls, launchRequests, io, startupInvocations,
    persisted: localStorage.getItem('agentmux-workbench-v1') } }
} })
