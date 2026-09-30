import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity } from '../../../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'
import type { SessionSnapshot } from '../../../src/shared/contracts'

/** Preview data only; the owning mounted suite independently reads real local Main bytes. */
export function projectLinksPreview(initial: ReturnType<typeof useAppStore.getState>, render: (mode: string) => void) {
  const reads: { workspaceId: string; path: string }[] = []
  const project = { id: 'links-project', name: 'Project Alpha', hostId: 'local', path: '/Users/preview/projects/alpha', kind: 'folder' as const }
  const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: '/Users/preview/topics', kind: 'folder' as const }
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
    id: 'links-pmo', kind: 'agent', label: 'Project PMO', hostId: 'local', workspacePath: scratch.path,
    providerId: 'codex', executorId: Object.keys(initial.config!.executors)[0]!, createdAt: 1, updatedAt: 1,
    agentSessionUpdatedAt: 1, processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'links-pmo', run: { runId: 'links-original-pmo-run' } }
  }
  const tab = { ...createWorkbenchTab('links-pmo-tab', { kind: 'agent', phase: 'attached', regionId: 'links-pmo-region',
    workspaceId: scratch.id, sessionId: session.id }), topicId: PMO_TEAMS_TOPIC_ID }
  function seed(mode: 'local' | 'remote' | 'missing') {
    reads.length = 0
    const resource = { ...project, hostId: mode === 'remote' ? 'links-remote' : 'local' }
    const goal: DemandRecord = { id: 'links-goal', title: 'Understand the current project', description: '', status: 'in_progress', priority: 'normal',
      projectId: mode === 'missing' ? 'unregistered-project' : directoryIdentity(resource.hostId, resource.path), projectName: project.name,
      createdAt: 1, updatedAt: 1, source: 'session', sessionIds: [] }
    const body = '# A small place to start\n\nThe entry point is `src/a.ts`. It keeps the project configuration in one place.\n\n'
      + 'Read ~/projects/alpha/src/a.ts:12:3, then compare [the same source](./src/a.ts).\n\n'
      + 'The PMO stays in its own working directory while these file references use the project shown above.\n\n'
      + 'Next, inspect the two exported functions and decide which behavior to verify first.'
    api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'links-preview' }, items: [], nextCursor: null })
    api.files.observe = async () => {}; api.files.unobserve = async () => {}
    api.files.read = async (workspaceId, path) => { reads.push({ workspaceId, path }); return { status: 'read', document: { path,
      content: '// Project Alpha — src/a.ts\n\nexport const projectName = "Project Alpha"\n\nexport function readConfiguration() {\n  return { name: projectName, preserved: true }\n}\n', revision: 'links-preview-file' } } }
    flushSync(() => {
      useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
        config: { ...initial.config!, hosts: [...initial.config!.hosts.filter(host => host.id !== 'links-remote'),
          ...(mode === 'remote' ? [{ id: 'links-remote', kind: 'ssh' as const, label: 'Remote project Host', target: 'preview-host' }] : [])], workspaces: [resource, scratch],
          appearance: { ...initial.config!.appearance, appAppearance: mode === 'local' ? 'dark' : 'light' } },
        localHome: '/Users/preview', mainSurface: 'workbench', activeWorkspaceId: scratch.id, toolsOpen: false, projectRailOpen: true,
        sessions: [...initial.sessions, session], viewModes: { [session.id]: 'activity' }, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
        demands: { [goal.id]: goal }, demandPmoTabIds: { [goal.id]: tab.id }, selectedDemandId: goal.id,
        tabs: { [tab.id]: tab }, layouts: { [scratch.id]: createWorkspaceLayout('links-original-group', [tab.id]), [resource.id]: createWorkspaceLayout('links-project-group') },
        timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [{ id: 'links-message', agentSessionId: session.id,
          kind: 'assistant_message', source: 'native-hook', title: 'Project findings', content: body, status: 'complete', createdAt: 1791090000000, updatedAt: 1791090000000 }] } },
        documents: {}, documentIssues: {}, agentComposerDrafts: { [session.id]: '' }, error: null, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null })
      render(mode)
    })
  }
  return { seed, facts: () => {
    const state = useAppStore.getState()
    return { reads, session: state.sessions.find(item => item.id === session.id), tabs: state.tabs, layouts: state.layouts,
      mapping: state.demandPmoTabIds, documents: state.documents, originalGroup: 'links-original-group', projectWorkspaceId: project.id }
  } }
}
