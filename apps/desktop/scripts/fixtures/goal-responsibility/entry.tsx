import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAmuxObjectLink } from '@agentmux/core/sharing'
import { deriveObjectId } from '@agentmux/core/object-id'
import type { GoalDelegationResult } from '@agentmux/core/goal-delegation'
import type { Demand } from '@agentmux/demand'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench, restorePersistedWorkbench, type PersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { applyGoalDelegationResult } from '../../../src/renderer/src/lib/goal-delegation-work'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { EMPTY_AGENT_FOCUS } from '../../../src/renderer/src/lib/agent-focus'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { AppConfig, SessionSnapshot, ScratchTopicSnapshot } from '../../../src/shared/contracts'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'
import '../../../src/renderer/src/styles/index.css'

type Snapshot = { id: string; goal: DemandRecord; delegation: GoalDelegationResult; sessions: SessionSnapshot[];
  history: Record<string, Awaited<ReturnType<typeof api.sessions.historyPage>>> }
type Source = { sourceSha256: string; source: { boundary: string }; config: AppConfig; snapshots: Snapshot[]; privateRoot: string;
  journey: { initialSnapshotId: string; deliveredSnapshotId: string; reportedSnapshotId: string;
    patrol: { method: 'goal.patrol'; params: { goalId: string; operationId: string }; response: GoalDelegationResult } } }
type Call = { kind: 'recorded-request' | 'recorded-publication' | 'navigation' | 'unrecorded'; method: string; params: unknown }
type Saved = { schema: 'agentmux.goal-responsibility-preview-state.v1'; sourceSha256: string; snapshotId: string;
  workbench: PersistedWorkbench; drafts: Record<string, string>; notes: Record<string, string>; calls: Call[];
  appearance: 'dark' | 'light'; mainSurface: 'board' | 'workbench'; selectedDemandId: string | null; toolsOpen: boolean }
const source = (window as unknown as { goalResponsibilitySource: Source }).goalResponsibilitySource
if (!source?.sourceSha256) throw new Error('A validated original public journey source is required.')
const storageKey = 'agentmux-goal-responsibility-preview-state-v1'
const retained = localStorage.getItem(storageKey)
const saved: Saved | null = retained === null ? null : JSON.parse(retained)
if (saved && (saved.schema !== 'agentmux.goal-responsibility-preview-state.v1' || saved.sourceSha256 !== source.sourceSha256))
  throw new Error('The saved private workface belongs to another source. Keep it and use another private profile.')
const snapshotById = (id: string): Snapshot => {
  const snapshot = source.snapshots.find(item => item.id === id)
  if (!snapshot) throw new Error('The original snapshot is missing: ' + id)
  return snapshot
}
let current = snapshotById(saved?.snapshotId ?? source.journey.initialSnapshotId)
const calls: Call[] = saved?.calls ?? []
const initial = useAppStore.getState()
const workerId = snapshotById(source.journey.initialSnapshotId).delegation.responsibility!.executions[0]!.execution.agentSessionId
const supervisorId = snapshotById(source.journey.initialSnapshotId).delegation.responsibility!.supervisor.agentSessionId
const topicId = deriveObjectId('goal-responsibility-visual-mote', source.sourceSha256)
const scratch = { id: SCRATCH_WORKSPACE_ID, name: '责任巡查', hostId: current.sessions[0]!.hostId,
  path: source.privateRoot + '/mote-preview', kind: 'folder' as const }
const topicPath = scratchTopicDirectoryName(topicId)
// This is private presentation scaffolding. Session execution cwd/Run and Goal associations stay verbatim.
const topic: ScratchTopicSnapshot = { id: topicId, title: '责任巡查', directoryPath: topicPath, topicPath: topicPath + '/topic.md',
  summary: '', collaborators: [], kind: 'mote', soul: { path: topicPath + '/SOUL.md', content: '# Private visual fixture', version: 'preview' } }
const config: AppConfig = { ...source.config, workspaces: [...source.config.workspaces.filter(workspace => workspace.id !== scratch.id), scratch],
  appearance: { ...source.config.appearance, appAppearance: saved?.appearance ?? 'light' } }
const primaryRegion = 'goal-responsibility-worker-region'
let tab = { ...createWorkbenchTab('goal-responsibility-preview-tab', { kind: 'agent', phase: 'attached', regionId: primaryRegion,
  workspaceId: scratch.id, sessionId: workerId }, '原执行与管理'), topicId }
if (supervisorId && supervisorId !== workerId && current.sessions.some(session => session.id === supervisorId)) {
  // A vertical split keeps both original identities readable at the narrow desktop width.
  tab = { ...addWorkbenchRegion(tab, primaryRegion, 'down', { kind: 'agent', phase: 'attached',
    regionId: 'goal-responsibility-manager-region', workspaceId: scratch.id, sessionId: supervisorId }), topicId }
}
const firstWorkbench = projectPersistedWorkbench({ tabs: { [tab.id]: tab },
  layouts: { [scratch.id]: createWorkspaceLayout('goal-responsibility-preview-group', [tab.id]) } })
const restored = restorePersistedWorkbench({ config, sessions: current.sessions, persisted: saved?.workbench ?? firstWorkbench,
  createTabGroupId: () => 'goal-responsibility-preview-restored-group', retiredSessionIds: new Set() })
if (restored.repairs.length) throw new Error('The original private workface did not restore exactly.')
const filesystemGoal = (goal: DemandRecord): Demand => ({ ...goal, executorId: null, tags: goal.tags ?? [], plannedStartAt: goal.plannedStartAt ?? null,
  targetAt: goal.targetAt ?? null, parentDemandId: goal.parentDemandId ?? null, phaseIndex: goal.phaseIndex ?? null,
  assigneeSessionIds: goal.assigneeSessionIds ?? [], supervisorSessionId: goal.supervisorSessionId ?? null,
  participations: goal.participations ?? [], activities: goal.activities ?? [], decisions: goal.decisions ?? [] })
const record = (call: Call) => { calls.push(structuredClone(call)); save() }
const deny = (method: string) => async (...params: unknown[]) => {
  record({ kind: 'unrecorded', method, params })
  throw new Error('This recorded transport preview cannot perform an unrecorded operation: ' + method)
}
// No preview Start, send, interrupt or acceptance can be mistaken for a real owner receipt.
for (const [owner, methods] of [
  [api.sessions, ['launchAgent', 'launchTerminal', 'write', 'paste', 'submitPrompt', 'submitMessage', 'replyQuestion', 'respondInteraction', 'setPosture', 'reopen', 'resume', 'interrupt', 'stop']],
  [api.demands, ['create', 'update', 'delete', 'linkSession', 'unlinkSession', 'confirmAlignment', 'acceptGrounding', 'activity', 'decision']]
] as const) for (const method of methods) {
  const transport = owner as unknown as Record<string, unknown>
  if (typeof transport[method] === 'function') transport[method] = deny(method)
}
api.config.get = async () => structuredClone(config)
api.demands.list = async () => [filesystemGoal(current.goal)]
api.demands.delegation = async (method, params) => {
  record({ kind: 'recorded-request', method, params })
  if (method === 'goal.delegations' && params.goalId === current.goal.id) return structuredClone(current.delegation)
  const expected = source.journey.patrol
  if (method !== expected.method || JSON.stringify(params) !== JSON.stringify(expected.params) || current.id !== source.journey.initialSnapshotId)
    return await deny(method)(params)
  current = snapshotById(source.journey.deliveredSnapshotId)
  installSnapshot(); save()
  return structuredClone(expected.response)
}
api.demands.onChanged = () => () => {}
api.scratch.listTopics = async () => [topic]
api.scratch.readTopic = async () => topic
api.scratch.ensureMote = async () => topic
api.files.list = async () => ({ status: 'listed', files: [], complete: true, omitted: 'none', partialReason: null })
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.files.read = async (_workspaceId, path) => path === topic.topicPath || path === topic.soul?.path
  ? { status: 'read', document: { path, content: path === topic.soul?.path ? topic.soul.content : '', revision: 'private-preview' } }
  : { status: 'deleted' }
api.sessions.historyPage = async control => {
  const history = current.history[control.agentSessionId]
  if (!history) throw new Error('This recorded transport contains no native transcript. Original Runtime state is unchanged.')
  return structuredClone(history)
}
api.sessions.observeHistory = async control => {
  const history = current.history[control.agentSessionId]
  if (!history) throw Object.assign(new Error('Native history observation is outside this recorded preview.'), { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' })
  return { source: history.source, dispose() {} }
}
api.sessions.refresh = async control => {
  const session = current.sessions.find(item => item.id === (control.kind === 'agent' ? control.agentSessionId : control.runId))
  if (!session) throw new Error('No original recorded client Session projection.')
  return structuredClone(session)
}
api.sessions.onEvent = () => () => {}
api.continuousProgress.goals = async () => []
api.ui.openObjectLink = async link => {
  const target = parseAmuxObjectLink(link)
  if (target.kind !== 'agent' || !current.sessions.some(session => session.id === target.agentSessionId))
    throw new Error('The original client projection does not contain this Agent.')
  record({ kind: 'navigation', method: 'ui.openObjectLink', params: { link } })
  useAppStore.getState().selectSession(target.agentSessionId)
}
function installSnapshot() {
  flushSync(() => {
    useAppStore.setState(state => ({ sessions: structuredClone(current.sessions), demands: {
      ...state.demands, [current.goal.id]: { ...current.goal, source: current.goal.source ?? 'session' }
    } }))
    applyGoalDelegationResult(current.delegation)
  })
}
flushSync(() => {
  useAppStore.setState({ ...initial, initialize: async () => () => {}, config, loading: false, sessions: structuredClone(current.sessions),
    tabs: restored.tabs, layouts: restored.layouts, activeWorkspaceId: scratch.id, mainSurface: saved?.mainSurface ?? 'board',
    demands: { [current.goal.id]: current.goal }, selectedDemandId: saved?.selectedDemandId ?? null,
    toolsOpen: saved?.toolsOpen ?? false, projectRailOpen: false, workspaceTool: 'files-branches', toolDockWidth: 360,
    scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], error: null, reading: false } },
    viewModes: Object.fromEntries(current.sessions.map(session => [session.id, 'activity'])), agentFocus: EMPTY_AGENT_FOCUS,
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], timelines: {},
    agentComposerDrafts: saved?.drafts ?? {}, agentComposerNotes: saved?.notes ?? {}, agentSteerQueues: {}, agentSteerInFlight: {},
    demandPmoTabIds: {}, retainedSpatialFocus: null, error: null, lastError: null, errorNoticeContext: null })
  applyGoalDelegationResult(current.delegation)
})
function save() {
  const state = useAppStore.getState()
  const projection: Saved = { schema: 'agentmux.goal-responsibility-preview-state.v1', sourceSha256: source.sourceSha256,
    snapshotId: current.id, workbench: projectPersistedWorkbench({ tabs: state.tabs, layouts: state.layouts }),
    drafts: state.agentComposerDrafts, notes: state.agentComposerNotes, calls,
    appearance: state.config?.appearance.appAppearance === 'dark' ? 'dark' : 'light',
    mainSurface: state.mainSurface === 'workbench' ? 'workbench' : 'board', selectedDemandId: state.selectedDemandId, toolsOpen: state.toolsOpen }
  localStorage.setItem(storageKey, JSON.stringify(projection))
}
useAppStore.subscribe(save)
save()
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
Object.assign(window, { goalResponsibilityVisual: {
  restoredFromStorage: saved !== null,
  snapshot: (id: string) => { current = snapshotById(id); installSnapshot(); save() },
  publishReport: () => {
    if (current.id !== source.journey.deliveredSnapshotId) throw new Error('Read the original delivered patrol before publishing its actual recorded report.')
    record({ kind: 'recorded-publication', method: 'goal.patrol.report', params: { snapshotId: source.journey.reportedSnapshotId } })
    current = snapshotById(source.journey.reportedSnapshotId); installSnapshot(); save()
  },
  appearance: (appAppearance: 'dark' | 'light') => flushSync(() => useAppStore.setState(state => ({ config: {
    ...state.config!, appearance: { ...state.config!.appearance, appAppearance } } }))),
  surface: (surface: 'list' | 'workbench' | 'mote') => flushSync(() => useAppStore.setState({
    mainSurface: surface === 'list' ? 'board' : 'workbench', selectedDemandId: surface === 'list' ? null : useAppStore.getState().selectedDemandId,
    activeWorkspaceId: scratch.id, toolsOpen: surface === 'mote', projectRailOpen: false })),
  facts: () => {
    const state = useAppStore.getState(), goal = state.demands[current.goal.id]
    return { sourceSha256: source.sourceSha256, sourceBoundary: source.source.boundary, snapshotId: current.id, goalId: current.goal.id,
      goal, sessions: state.sessions, workbench: projectPersistedWorkbench({ tabs: state.tabs, layouts: state.layouts }),
      drafts: state.agentComposerDrafts, notes: state.agentComposerNotes, calls, selectedDemandId: state.selectedDemandId,
      mainSurface: state.mainSurface, toolsOpen: state.toolsOpen, primaryRegion, workerId, supervisorId }
  }, flush: save
} })
