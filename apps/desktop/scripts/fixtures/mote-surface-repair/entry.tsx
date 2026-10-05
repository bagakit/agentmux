import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { moteWorkbenchProjection } from '../../../src/renderer/src/lib/mote-workbench-projection'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { PmoTeamsTopicFloatingPanel } from '../../../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { usePmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose, pmoTeamsTopicFloatingViewTargets, pmoTeamsTopicFloatingTargetTabId } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkspaceLayout } from '@agentmux/layout'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { MoteDetailsPanel } from '../../../src/renderer/src/components/MoteDetailsPanel'
import { MoteWorkface } from '../../../src/renderer/src/components/MoteWorkface'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { useMoteMaterialsActions } from '../../../src/renderer/src/lib/mote-materials-actions'
import { useMoteWorkfaceScope } from '../../../src/renderer/src/lib/mote-workface'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { MOTE_BEHAVIOR_LINK, DEFAULT_MOTE_BEHAVIOR } from '../../../src/shared/mote-behavior'
import { parseMoteQuickMode, serializeMoteQuickMode } from '../../../src/shared/mote-quick-mode'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import type { ScratchTopicSnapshot, SessionSnapshot } from '../../../src/shared/contracts'
import type { Demand } from '@agentmux/demand'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'

const terminalRestartOnly = new URLSearchParams(location.search).get('terminalRestartOnly') === '1'
const contextProof = new URLSearchParams(location.search).get('contextProof') === '1'
const workspacePath = new URLSearchParams(location.search).get('workspacePath')
if (!workspacePath) throw Error('An isolated original workspace is required.')
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspacePath, name: 'Motes', kind: 'folder' as const }
const moteId = new URLSearchParams(location.search).get('moteId') ?? PMO_TEAMS_TOPIC_ID
const rootPath = scratchTopicDirectoryName(moteId)
const soul = '# Mote\n\nA thoughtful collaborator. Keep original decisions and ask before changing direction.\n\n' + MOTE_BEHAVIOR_LINK + '\n'
const topic: ScratchTopicSnapshot = { id: moteId, title: moteId === PMO_TEAMS_TOPIC_ID ? 'Mote' : 'Research companion', summary: '', directoryPath: workspace.path + '/' + rootPath,
  topicPath: workspace.path + '/' + rootPath + '/topic.md', collaborators: [], soul: { path: workspace.path + '/' + rootPath + '/SOUL.md', content: soul, version: 'display-only' } }
const secondTopic = { ...topic, id: 'launcher:analyst', title: 'Analyst', directoryPath: workspace.path + '/' + scratchTopicDirectoryName('launcher:analyst') }
const topics = [topic, secondTopic], spaceId = directoryIdentity('local', topic.directoryPath), zoneId = homeZoneId(spaceId)
const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: 'original-display-session', kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
  workspacePath: topic.directoryPath, label: 'Our ongoing discussion', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 2), agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 2), processState: 'running', latestOutputBytes: 0,
  status: { state: 'waiting', source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 2) }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-core-session', run: { runId: 'original-controlled-run' } } }
const tab = { ...createWorkbenchTab('original-discussion', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: workspace.id, sessionId: session.id }, 'Our ongoing discussion'), topicId: topic.id, space: { spaceId, zoneId } }
const launcher = { ...createWorkbenchTab('original-launcher', { kind: 'launcher', regionId: 'launcher-region', workspaceId: workspace.id }, 'New discussion'), topicId: topic.id, space: { spaceId, zoneId } }
const other = { ...createWorkbenchTab('analyst-launcher', { kind: 'launcher', regionId: 'analyst-region', workspaceId: workspace.id }), topicId: secondTopic.id, space: { spaceId: directoryIdentity('local', secondTopic.directoryPath), zoneId: homeZoneId(directoryIdentity('local', secondTopic.directoryPath)) } }
const conversation = { hostId: 'local', sessionId: session.control.agentSessionId, displayWorkspaceId: workspace.id, groupId: 'mote-group', tabId: tab.id, regionId: 'original-region' }
const initialQuick = serializeMoteQuickMode('', { executorId: 'fixture', conversation }) + '# User notes\nKeep this paragraph.\n'
let disk: Record<string,string> = { [rootPath + '/MOTE.md']: initialQuick, [rootPath + '/SOUL.md']: soul, [rootPath + '/BEHAVIOR.md']: DEFAULT_MOTE_BEHAVIOR }
const calls: { operation: string; path?: string }[] = []
let unknown = false
let contextFailure = false, contextReadFailure = false, contextPending: (() => void) | null = null
const revision = async (value: string) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2,'0')).join('')
const quickTopic = () => { const parsed = parseMoteQuickMode(disk[rootPath + '/MOTE.md']!); return { ...topic, quickMode: parsed.status === 'valid' ? { status: 'saved' as const, defaults: parsed.defaults, version: disk[rootPath + '/MOTE.md']! } : parsed } }
api.files.readDirectory = async (_workspace, directory) => Object.keys(disk).filter(path => path.startsWith(directory + '/')).map(path => ({ path, name: path.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false, mtimeMs: _reshape_fixtureEpoch(0, 0, 1) }))
api.files.read = async (_workspace, path) => { calls.push({ operation: 'read', path }); return disk[path] === undefined ? { status: 'deleted' } : { status: 'read', document: { path, content: disk[path]!, revision: await revision(disk[path]!) } } }
api.files.readPublic = async (params: FileReadParams): Promise<FileReadResult> => {
  calls.push({ operation: 'file.read', path: params.path })
  if (unknown) return { resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'The original settings file is unconfirmed. Saved choices and ongoing work remain available.' } }
  const path = rootPath + '/' + params.path
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: topic.directoryPath, path }, result: disk[path] === undefined ? { status: 'deleted' } : { status: 'read', document: { path, content: disk[path]!, revision: await revision(disk[path]!) } } }
}
api.files.write = async (_workspace, input) => { calls.push({ operation: 'write', path: input.path }); if (await revision(disk[input.path] ?? '') !== input.expectedRevision) return { status: 'conflict', observedRevision: await revision(disk[input.path] ?? '') }; disk[input.path] = input.content; return { status: 'written', revision: await revision(input.content) } }
api.files.observe = async () => {}; api.files.unobserve = async () => {}; api.files.onInvalidated = () => () => {}
api.scratch.listTopics = async () => [quickTopic(), secondTopic]
api.scratch.readTopic = async (_workspace, id) => {
  if (contextReadFailure) throw Error('Original discussion read rejected (controlled source failure).')
  return id === topic.id ? quickTopic() : secondTopic
}
api.scratch.ensureMote = async () => {
  if (contextFailure) throw Error('Original Mote metadata read failed (controlled source failure).')
  if (contextPending) await new Promise<void>(resolve => { contextPending = resolve })
  return quickTopic()
}
const goals: Demand[] = ['experiment', 'research'].map((id, index) => ({ id: 'choice-' + id,
  title: index ? 'Compare the evidence before choosing our next experiment' : 'Explore a small useful experiment',
  description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  sessionIds: [session.control.agentSessionId], contentRefs: [{ hostId: workspace.hostId, workspaceId: workspace.id, zoneId }], createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 2), executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, activities: [], decisions: [] }))
api.demands.list = async () => goals
api.continuousProgress.goals = async () => []
api.sessions.attach = async () => ({attachmentId: 'controlled-original-attachment', session, currentSize: null, terminal: {type: 'unknown', reason: 'origin_unknown'}, resizeRevision: 0, replay: [], gap: null})
api.sessions.detach = async () => {}
api.sessions.resize = async () => { calls.push({operation: 'resize'}) }
api.sessions.onEvent = () => () => {}
api.sessions.onData = () => () => {}
api.ui.listAgentSkills = async () => []
if (new URLSearchParams(location.search).get('avatarVisual')) {
  api.scratch.readMoteAvatar = async (workspaceId, topicId, ref, objectKey) => {
    if (workspaceId !== workspace.id || topicId !== topic.id || objectKey !== spaceId) throw Error('Wrong original avatar target')
    calls.push({operation: 'readImmutableAvatar', path: ref.fileName})
    return await (window as unknown as {avatarVisual: {read(ref: unknown): Promise<{dataUrl: string; width: number; height: number}>}}).avatarVisual.read(ref)
  }
  api.config.save = async () => { calls.push({operation: 'saveConfig'}); throw Error('This visual proof must never save a preference') }
}
api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'fixture', nativeSessionId: 'original-controlled-native' }, nextCursor: null,
  items: [{ id: 'original-message', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Let’s compare a small experiment before expanding the project.' }] }] })
function reset() {
  disk[rootPath + '/MOTE.md'] = initialQuick; calls.length = 0; unknown = false
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {
    fixture: { label: 'Thoughtful colleague', providerId: 'codex', command: 'not-executed', args: [], env: {}, injectAgentMuxGuide: true },
    analyst: { label: 'Research partner', providerId: 'claude', command: 'not-executed', args: [], env: {}, injectAgentMuxGuide: true }, missing: { label: 'Writing partner', providerId: 'codex', command: 'not-executed', args: [], env: {}, injectAgentMuxGuide: true } }, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    loading: false, tabs: { [launcher.id]: launcher, [tab.id]: tab, [other.id]: other }, layouts: { [workspace.id]: createWorkspaceLayout('mote-group', [launcher.id, tab.id, other.id]) }, sessions: [session], documents: {}, dirtyDocuments: {}, documentIssues: {},
    activeWorkspaceId: workspace.id, mainSurface: terminalRestartOnly ? 'survey' : 'workbench', viewModes: { [session.id]: 'activity' }, agentComposerDrafts: { [session.id]: 'An original unsent question stays here.', 'launcher-region': 'Another original question.', 'analyst-region': 'Analyst draft.' }, scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), topics: [quickTopic(), secondTopic], revision: 0, error: null, reading: false } }, workspaceFileRevisions: {},
    workbenchSpaceSelection: { workspaceId: workspace.id, groupId: 'mote-group', tabId: tab.id, regionId: 'original-region', topicId: topic.id, spaceId, zoneId },
    moteContextOperations: {}, prewarmTerminal: async () => {}, detectExecutors: async () => {}, launchAgent: async () => { throw Error('No Run may be launched by this Renderer proof') }, reportError: error => { calls.push({ operation: 'error' }); console.warn(String(error)) } })
  const config = useAppStore.getState().config!
  useAppStore.setState({ executorDetections: Object.fromEntries(Object.entries(config.executors).map(([id, executor]) => ['local\0'+id, { state: id === 'fixture' ? 'ready' : id === 'missing' ? 'missing' : 'error', input: { executorId: id, providerId: executor.providerId, command: executor.command, host: config.hosts[0]! } }])) })
}
reset()
const restored = new URLSearchParams(location.search).get('restore')
if (restored) {
  const previous = JSON.parse(restored)
  disk = previous.disk
  useAppStore.setState({config: previous.config, sessions: previous.sessions, tabs: previous.tabs, layouts: previous.layouts,
    spaceZoneBindings: previous.spaceZoneBindings, spatialRequests: previous.spatialRequests,
    workbenchSpaceSelection: previous.selection, agentComposerDrafts: previous.agentComposerDrafts, viewModes: previous.viewModes,
    scratchTopicSnapshots: {[workspace.id]: {scope: scratchTopicsScope(workspace), topics: [quickTopic(),secondTopic], revision: 1, error: null, reading: false}}})
}
function Scene() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  // Match App visibility: a floating close is not a background Space entry.
  const backgroundVisible = terminalRestartOnly ? false : !floating.open
  const state = useAppStore()
  const catalog = spatialCatalog(state, [quickTopic(), secondTopic])
  // Consume the same resolved target entity as App, including a File selected after Save.
  const floatingTabId = pmoTeamsTopicFloatingTargetTabId(floating, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], state.agentFocus.pmo.sessionId)
  const selectReference = (reference: {displayWorkspaceId: string; groupId: string; tabId: string; regionId: string}) => setFloating({targetTabId: reference.tabId, reference})
  const projection = moteWorkbenchProjection(catalog, floatingTabId ? state.tabs[floatingTabId] : undefined, floating, selectReference, state.layouts)
  const wrongOriginalAgentProjection = floatingTabId !== tab.id ? moteWorkbenchProjection(catalog, state.tabs[tab.id], floating, selectReference, state.layouts) : null
  const targets = pmoTeamsTopicFloatingViewTargets(floating, state.tabs, state.layouts[workspace.id], state.agentFocus.pmo.sessionId, projection.projection)
  const [epoch, setEpoch] = useState(0)
  const scope = useMoteWorkfaceScope(workspace.id)!
  const selection = useAppStore(state => state.workbenchSpaceSelection)
  const reference = selection?.tabId && selection.regionId && selection.groupId ? { displayWorkspaceId: selection.workspaceId, groupId: selection.groupId, tabId: selection.tabId, regionId: selection.regionId } : null
  const materials = useMoteMaterialsActions(scope, { reference })
  Object.assign(window, { moteQuick: {
    contextScenario: async (scenario: 'normal' | 'prepare-failure' | 'read-failure' | 'parent-available' | 'location-choice') => {
      requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
      await new Promise(resolve => setTimeout(resolve, 30))
      reset(); contextPending = null; contextFailure = scenario === 'prepare-failure'; contextReadFailure = scenario === 'read-failure'
      const reference = { displayWorkspaceId: workspace.id, groupId: 'mote-group', tabId: tab.id, regionId: 'original-region' }
      if (scenario === 'location-choice') useAppStore.setState({ layouts: { [workspace.id]: {
        root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', groupId: 'mote-group' }, second: { type: 'leaf', groupId: 'other-display' } }, activeGroupId: 'mote-group',
        groups: [{ id: 'mote-group', activeTabId: tab.id, tabOrder: [tab.id], recentTabIds: [tab.id] }, { id: 'other-display', activeTabId: tab.id, tabOrder: [tab.id], recentTabIds: [tab.id] }] } } })
      if (scenario === 'location-choice') setFloating({ reference: undefined, targetAgent: undefined })
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id, targetTabId: tab.id,
        ...(scenario === 'location-choice' ? {} : { reference: scenario === 'parent-available' ? { ...reference, regionId: 'retained-old-region' } : reference }) })
    },
    contextPending: () => { contextFailure = false; contextPending = () => {} },
    contextConfirm: () => { const finish = contextPending; contextPending = null; finish?.() },
    seedAvatar: (choice: unknown) => { const state = useAppStore.getState(); state.setConfig({...state.config!, appearance: {...state.config!.appearance, spaceObjectIcons: {[spaceId]: choice}}}) },
    retarget: (otherMote: boolean) => setFloating(otherMote ? {targetTopicId: secondTopic.id, targetTabId: other.id, reference: {displayWorkspaceId: workspace.id, groupId: 'mote-group', tabId: other.id, regionId: 'analyst-region'}} : {targetTopicId: topic.id, targetTabId: tab.id, reference: conversation}),
    open: () => requestPmoTeamsTopicFloatingOpen({targetTopicId: topic.id, targetTabId: tab.id, reference: conversation}), close: () => requestPmoTeamsTopicFloatingClose({restoreFocus: false}),
    mode: (mode: 'activity' | 'terminal') => useAppStore.getState().setViewMode(session.id, mode, {focus: false}),
    floatSize: (width: number,height: number) => setFloating({size: {width,height},railMode: 'avatars'}),
    theme: (light: boolean) => { document.documentElement.dataset.appearance = light ? 'light' : 'dark' },
    missingExecutor: () => { const parsed = parseMoteQuickMode(disk[rootPath + '/MOTE.md']!); if (parsed.status !== 'valid') throw Error('Original config unavailable'); disk[rootPath + '/MOTE.md'] = serializeMoteQuickMode(disk[rootPath + '/MOTE.md']!, { ...parsed.defaults, executorId: 'saved-unavailable-executor' }); useAppStore.setState({ scratchTopicSnapshots: { [workspace.id]: { ...useAppStore.getState().scratchTopicSnapshots[workspace.id]!, topics: [quickTopic(), secondTopic], revision: 1 } } }) },
    reset: () => { reset(); setEpoch(value => value + 1) }, unknown: () => { unknown = true },
    enter: () => useAppStore.getState().openScratchTopic(topic.id, workspace.id),
    facts: () => { const state = useAppStore.getState(); return { contextOperations: state.moteContextOperations, projection: {issue: projection.issue, issueKind: projection.issueKind, selections: projection.projection?.selection ?? [], entity: projection.projection?.entity ?? null, resolvedTabId: floatingTabId, rejectedWrongOriginalAgent: wrongOriginalAgentProjection ? wrongOriginalAgentProjection.projection === null && wrongOriginalAgentProjection.issue !== null : null}, viewModes: state.viewModes, floating, defaults: quickTopic().quickMode, disk, sessions: state.sessions, drafts: state.agentComposerDrafts, tabs: state.tabs, layouts: state.layouts, selection: state.workbenchSpaceSelection, calls } },
    restartInput: () => { const state = useAppStore.getState(); return { config: state.config, sessions: [session], tabs: state.tabs, layouts: state.layouts, spaceZoneBindings: state.spaceZoneBindings, spatialRequests: state.spatialRequests, topics: [quickTopic(), secondTopic], selection: state.workbenchSpaceSelection, agentComposerDrafts: state.agentComposerDrafts,
      launcherState: useLauncherState.persist.getOptions().partialize!(useLauncherState.getState()), disk, viewModes: state.viewModes, quickMode: { path: rootPath + '/MOTE.md', content: disk[rootPath + '/MOTE.md'], conversation } } }
  } })
  return <DesktopClientUiProvider><WindowOverlayHost /><main className="persona-scene">
    {contextProof ? null : <aside className="persona-scene__profile"><MoteDetailsPanel key={epoch} scope={scope} reference={reference} onOpenPath={materials.open} onCreateNote={() => {}} /></aside>}
    <section className={"persona-scene__work" + (terminalRestartOnly ? " workspace-workbench-slot--parked" : "")} aria-hidden={terminalRestartOnly || undefined} inert={terminalRestartOnly}><MoteWorkface workspaceId={workspace.id} visible={backgroundVisible}><WorkspaceWorkbench workspaceId={workspace.id} visible={backgroundVisible} viewTargets={targets} topicId={topic.id} topicIsolation="bound-only" /></MoteWorkface></section>
    <div data-pmo-teams-topic-launcher className="surface-proof-invoker"><button type="button" aria-label="Open Mote" onClick={() => requestPmoTeamsTopicFloatingOpen({targetTopicId: topic.id, targetTabId: tab.id, reference: conversation})}>Mote</button></div>
    <PmoTeamsTopicFloatingPanel floating={floating} setFloating={setFloating} projectionState={projection} />
  </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
