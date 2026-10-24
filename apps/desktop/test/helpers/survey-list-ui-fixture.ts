import { expect, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { createWorkbenchTab } from '../../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection } from '../../src/renderer/src/lib/survey-workface'
import { composerConfig, composerSession } from './composer-dom-fixture'
import { initializeSpatialControlFixture } from './spatial-control-owner-fixture'

/** Actual Store/restore owners and three original workfaces; only external paint/transport is substituted. */
export async function arrangeSurveyListUi() {
  const workspaces = ['a', 'b', 'c'].map(id => ({ ...composerConfig.workspaces[0]!, id: `survey-${id}`, path: `${composerConfig.workspaces[0]!.path}/${id}`, name: `Research ${id.toUpperCase()}` }))
  const sessions = workspaces.map((workspace, index) => ({ ...composerSession(`survey-session-${index}`), workspacePath: workspace.path }))
  const tabs = Object.fromEntries(workspaces.map((workspace, index) => {
    const tab = createWorkbenchTab(`survey-tab-${index}`, { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
      regionId: `survey-region-${index}`, sessionId: sessions[index]!.id }, workspace.name)
    return [tab.id, tab]
  }))
  const layouts = Object.fromEntries(workspaces.map((workspace, index) => [workspace.id, createWorkspaceLayout(`survey-spatial-group-${index}`, [`survey-tab-${index}`])]))
  useAppStore.setState({ loading: false, config: { ...composerConfig, workspaces }, sessions, tabs, layouts,
    activeWorkspaceId: workspaces[0]!.id, mainSurface: 'survey', projectRailOpen: true, workspaceTool: 'agents', toolsOpen: false,
    surveyZoneSelection: null, surveyCollectedZones: {}, surveyOrganization: { ungrouped: [], groups: [] }, surveyExplorationNames: {},
    surveySidebarWidth: 260, surveySidebarCollapsed: false, surveyToolsOpen: false, notebookRecoveries: [],
    recallNotebookId: null, recallNoteId: null, recallZoneSelection: null, demands: {},
    spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, timelines: {},
    pendingAgentLaunches: {}, error: null, lastError: null, errorDismissed: true,
    retainedSpatialFocus: null, regionCaretFocus: null, displacedAgentSessionIds: [],
    agentFocus: { execution: { sessionId: sessions[0]!.id, history: [{ sessionId: sessions[0]!.id, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: Object.fromEntries(sessions.map(session => [session.id, `Unsent original ${session.id}`])),
    viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal'])), documents: {}, dirtyDocuments: {} })
  await initializeSpatialControlFixture()
  const catalog = spatialCatalog(useAppStore.getState(), [])
  const zones = workspaces.map((_, index) => catalog.tabs.find(tab => tab.tabId === `survey-tab-${index}`)!.zoneId!)
  const names = Object.fromEntries(zones.map((zoneId, index) => [zoneId, workspaces[index]!.name]))
  useAppStore.setState({ initialize: vi.fn(async () => () => {}), surveyCollectedZones: Object.fromEntries(zones.map(id => [id, true as const])),
    surveyExplorationNames: names, surveyZoneSelection: surveyInitialZoneSelection(catalog, zones[0]!, layouts, tabs, workspaces[0]!.id) })
  const lifecycle = ['launchAgent', 'launchTerminal', 'creation', 'recover', 'resume', 'stop', 'submitPrompt', 'write', 'interrupt']
    .map(name => vi.spyOn(api.sessions, name as keyof typeof api.sessions))
  const selection = useAppStore.getState().surveyZoneSelection
  return { zones, workspaces, sessions, tabs, layouts, names, selection,
    noLifecycle() { for (const call of lifecycle) expect(call).not.toHaveBeenCalled() } }
}
