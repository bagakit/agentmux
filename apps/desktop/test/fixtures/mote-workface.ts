import { fixturePath as _hygiene_fixturePath } from "../../scripts/lib/fixture-values.mjs"
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../src/shared/scratch-topics'
import { createWorkbenchTab } from '../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { moteWorkbenchProjection } from '../../src/renderer/src/lib/mote-workbench-projection'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { pmoTeamsTopicFloatingTargetTabId } from '../../src/renderer/src/lib/pmo-teams-topic-floating'
import { useAppStore } from '../../src/renderer/src/store'

export const savedMoteKey = 'agentmux.leader-topic-floating.v1'
export const customMoteId = 'launcher:analyst'
export const quietMoteId = 'launcher:quiet'
export const ordinaryTopicId = 'launcher:ordinary'
export const scratchWorkspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("topics"), name: 'Topics', kind: 'folder' as const }
export const moteConfig: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { fixture: { label: 'Fixture', providerId: 'fixture', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [scratchWorkspace, { id: 'project', hostId: 'local', path: _hygiene_fixturePath("project"), name: 'Project', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
export function moteTopic(id: string, title: string, soul: boolean): ScratchTopicSnapshot {
  const directoryPath = _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(id)
  return { id, title, directoryPath, topicPath: directoryPath + '/topic.md', summary: '', collaborators: [],
    ...(soul ? { soul: { path: directoryPath + '/SOUL.md', content: '# Identity', version: 'v1' }, moteArchive: { state: 'active', version: 'fixture-active' } as const } : {}) }
}
export const moteTopics = [moteTopic(PMO_TEAMS_TOPIC_ID, 'Mote', true), moteTopic(customMoteId, 'Analyst with a long persistent name', true),
  moteTopic(quietMoteId, 'Quiet collaborator', true), moteTopic(ordinaryTopicId, 'Ordinary Topic', false)]
export function moteAgent(id: string, topicId: string | null, state: 'working' | 'waiting' = 'working'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
    workspacePath: topicId ? _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(topicId) : _hygiene_fixturePath("project"), label: id,
    createdAt: 1, updatedAt: 2, agentSessionUpdatedAt: 2, processState: 'running', latestOutputBytes: 0,
    status: { state, source: 'native-hook', observedAt: 2 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'original-run-' + id } } }
}
export const defaultAgent = moteAgent('default-agent', PMO_TEAMS_TOPIC_ID)
export const neighborAgent = moteAgent('neighbor-agent', PMO_TEAMS_TOPIC_ID, 'waiting')
export const customAgent = moteAgent('custom-agent', customMoteId, 'waiting')
export const ordinaryAgent = moteAgent('ordinary-agent', ordinaryTopicId)
export const executionAgent = moteAgent('execution-agent', null)
export const moteSessions = [defaultAgent, neighborAgent, customAgent, ordinaryAgent, executionAgent]
export const defaultTab = { ...createWorkbenchTab('default-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'default-region', sessionId: defaultAgent.id }, 'Ship the target goal'), topicId: PMO_TEAMS_TOPIC_ID }
export const neighborTab = { ...createWorkbenchTab('neighbor-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'neighbor-region', sessionId: neighborAgent.id }, 'Other goal'), topicId: PMO_TEAMS_TOPIC_ID }
export const customTab = { ...createWorkbenchTab('custom-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'custom-region', sessionId: customAgent.id }, 'Analyst work'), topicId: customMoteId }
export const quietTab = { ...createWorkbenchTab('quiet-tab', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'quiet-region' }, 'Quiet work'), topicId: quietMoteId }
export const ordinaryTab = { ...createWorkbenchTab('ordinary-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'ordinary-region', sessionId: ordinaryAgent.id }, 'Execution Topic'), topicId: ordinaryTopicId }
export const moteTabs = Object.fromEntries([defaultTab, neighborTab, customTab, quietTab, ordinaryTab].map(tab => [tab.id, tab]))
export function seedMoteWorkface({ directory = true }: { directory?: boolean } = {}): void {
  // This seed is a new observation. An advisory boot read still in flight must
  // not publish its earlier catalog over the fixture's confirmed object set.
  const revision = (useAppStore.getState().workspaceFileRevisions[SCRATCH_WORKSPACE_ID] ?? 0) + 1
  useAppStore.setState({ config: moteConfig, sessions: moteSessions, tabs: moteTabs,
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(moteTabs)), project: createWorkspaceLayout('project-group') },
    workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: revision }, scratchTopicSnapshots: directory ? { [SCRATCH_WORKSPACE_ID]: {
      scope: scratchTopicsScope(scratchWorkspace), revision, topics: moteTopics, error: null, reading: false
    } } : {},
    timelines: {}, agentNames: {}, viewModes: {}, demands: {}, recoveryCandidates: [], pendingAgentLaunches: {},
    activeWorkspaceId: 'project', mainSurface: 'board', projectRailOpen: false, toolsOpen: false,
    agentFocus: { execution: { sessionId: executionAgent.id, history: [{ sessionId: executionAgent.id, focusedAt: 123 }] }, pmo: { sessionId: defaultAgent.id } },
    agentComposerDrafts: { [defaultAgent.id]: 'Default unsent', [customAgent.id]: 'Analyst unsent', 'quiet-region': 'Launcher unsent', [executionAgent.id]: 'Execution unsent' },
    spaceObjectIcons: {}, launcherNameDrafts: {}, agentSteerQueues: {}, agentSteerInFlight: {}, warmTerminal: null })
}

/** DOM host boundary only. Actual Chromium/native top-layer proof belongs to Root. */
export function installNativePopover(): () => void {
  const proto = HTMLElement.prototype
  const descriptors = ['showPopover', 'hidePopover', 'matches'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const)
  const matches = proto.matches
  const visible = new WeakSet<HTMLElement>()
  function toggle(element: HTMLElement, newState: string): void {
    const event = new Event('toggle')
    Object.defineProperty(event, 'newState', { value: newState })
    element.dispatchEvent(event)
  }
  Object.defineProperty(proto, 'showPopover', { configurable: true, value: function(this: HTMLElement) { visible.add(this); toggle(this, 'open') } })
  Object.defineProperty(proto, 'hidePopover', { configurable: true, value: function(this: HTMLElement) { visible.delete(this); toggle(this, 'closed') } })
  Object.defineProperty(proto, 'matches', { configurable: true, value: function(this: HTMLElement, selector: string) {
    return selector === ':popover-open' ? visible.has(this) : matches.call(this, selector)
  } })
  return () => { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(proto, key, descriptor); else delete (proto as unknown as Record<string, unknown>)[key] } }
}

/** Standalone host fixtures consume the same full catalog/projector as production App. */
export function fixtureMoteProjection(floating: import('../../src/renderer/src/lib/pmo-teams-topic-floating').PmoTeamsTopicFloatingState,
  onSelect: import('../../src/renderer/src/lib/workbench-projection').WorkbenchProjection['onSelect']) {
  const state = useAppStore.getState()
  const id = pmoTeamsTopicFloatingTargetTabId(floating, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], state.agentFocus.pmo.sessionId)
  return moteWorkbenchProjection(spatialCatalog(state, moteTopics), id ? state.tabs[id] : undefined, floating, onSelect, state.layouts)
}
