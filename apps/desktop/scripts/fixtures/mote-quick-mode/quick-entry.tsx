import { createRoot } from 'react-dom/client'
import { useState } from 'react'
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
import '../mote-companion-workflows/persona-scene.css'

const workspacePath = new URLSearchParams(location.search).get('workspacePath')
if (!workspacePath) throw Error('An isolated original workspace is required.')
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspacePath, name: 'Motes', kind: 'folder' as const }
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const soul = '# Mote\n\nA thoughtful collaborator. Keep original decisions and ask before changing direction.\n\n' + MOTE_BEHAVIOR_LINK + '\n'
const topic: ScratchTopicSnapshot = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '', directoryPath: workspace.path + '/' + rootPath,
  topicPath: workspace.path + '/' + rootPath + '/topic.md', collaborators: [], soul: { path: workspace.path + '/' + rootPath + '/SOUL.md', content: soul, version: 'display-only' } }
const secondTopic = { ...topic, id: 'launcher:analyst', title: 'Analyst', directoryPath: workspace.path + '/' + scratchTopicDirectoryName('launcher:analyst') }
const topics = [topic, secondTopic], spaceId = directoryIdentity('local', topic.directoryPath), zoneId = homeZoneId(spaceId)
const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: 'original-display-session', kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
  workspacePath: topic.directoryPath, label: 'Our ongoing discussion', createdAt: 1, updatedAt: 2, agentSessionUpdatedAt: 2, processState: 'running', latestOutputBytes: 0,
  status: { state: 'waiting', source: 'native-hook', observedAt: 2 }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-core-session', run: { runId: 'original-controlled-run' } } }
const tab = { ...createWorkbenchTab('original-discussion', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: workspace.id, sessionId: session.id }, 'Our ongoing discussion'), topicId: topic.id, space: { spaceId, zoneId } }
const launcher = { ...createWorkbenchTab('original-launcher', { kind: 'launcher', regionId: 'launcher-region', workspaceId: workspace.id }, 'New discussion'), topicId: topic.id, space: { spaceId, zoneId } }
const other = { ...createWorkbenchTab('analyst-launcher', { kind: 'launcher', regionId: 'analyst-region', workspaceId: workspace.id }), topicId: secondTopic.id, space: { spaceId: directoryIdentity('local', secondTopic.directoryPath), zoneId: homeZoneId(directoryIdentity('local', secondTopic.directoryPath)) } }
const conversation = { hostId: 'local', sessionId: session.control.agentSessionId, displayWorkspaceId: workspace.id, groupId: 'mote-group', tabId: tab.id, regionId: 'original-region' }
const initialQuick = serializeMoteQuickMode('', { executorId: 'fixture', conversation }) + '# User notes\nKeep this paragraph.\n'
let disk: Record<string,string> = { [rootPath + '/MOTE.md']: initialQuick, [rootPath + '/SOUL.md']: soul, [rootPath + '/BEHAVIOR.md']: DEFAULT_MOTE_BEHAVIOR }
const calls: { operation: string; path?: string }[] = []
let unknown = false
const revision = async (value: string) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2,'0')).join('')
const quickTopic = () => { const parsed = parseMoteQuickMode(disk[rootPath + '/MOTE.md']!); return { ...topic, quickMode: parsed.status === 'valid' ? { status: 'saved' as const, defaults: parsed.defaults, version: disk[rootPath + '/MOTE.md']! } : parsed } }
api.files.readDirectory = async (_workspace, directory) => Object.keys(disk).filter(path => path.startsWith(directory + '/')).map(path => ({ path, name: path.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false, mtimeMs: 1 }))
api.files.read = async (_workspace, path) => { calls.push({ operation: 'read', path }); return disk[path] === undefined ? { status: 'deleted' } : { status: 'read', document: { path, content: disk[path]!, revision: await revision(disk[path]!) } } }
api.files.readPublic = async (params: FileReadParams): Promise<FileReadResult> => {
  calls.push({ operation: 'file.read', path: params.path })
  if (unknown) return { resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'The original settings file is unconfirmed. Saved choices and ongoing work remain available.' } }
  const path = rootPath + '/' + params.path
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: topic.directoryPath, path }, result: disk[path] === undefined ? { status: 'deleted' } : { status: 'read', document: { path, content: disk[path]!, revision: await revision(disk[path]!) } } }
}
api.files.write = async (_workspace, input) => { calls.push({ operation: 'write', path: input.path }); if (await revision(disk[input.path] ?? '') !== input.expectedRevision) return { status: 'conflict', observedRevision: await revision(disk[input.path] ?? '') }; disk[input.path] = input.content; return { status: 'written', revision: await revision(input.content) } }
api.files.observe = async () => {}; api.files.unobserve = async () => {}; api.files.onInvalidated = () => () => {}
api.scratch.listTopics = async () => [quickTopic(), secondTopic]; api.scratch.readTopic = async (_workspace, id) => id === topic.id ? quickTopic() : secondTopic; api.scratch.ensureMote = async () => quickTopic()
const goals: Demand[] = ['experiment', 'research'].map((id, index) => ({ id: 'choice-' + id,
  title: index ? 'Compare the evidence before choosing our next experiment' : 'Explore a small useful experiment',
  description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  sessionIds: [session.control.agentSessionId], contentRefs: [{ hostId: workspace.hostId, workspaceId: workspace.id, zoneId }], createdAt: 1, updatedAt: 2, executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, activities: [], decisions: [] }))
api.demands.list = async () => goals
api.continuousProgress.goals = async () => []
api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'fixture', nativeSessionId: 'original-controlled-native' }, nextCursor: null,
  items: [{ id: 'original-message', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Let’s compare a small experiment before expanding the project.' }] }] })
function reset() {
  disk[rootPath + '/MOTE.md'] = initialQuick; calls.length = 0; unknown = false
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {
    fixture: { label: 'Thoughtful colleague', providerId: 'fixture', command: 'not-executed', args: [], env: {}, injectAgentMuxGuide: true },
    analyst: { label: 'Research partner', providerId: 'fixture', command: 'not-executed', args: [], env: {}, injectAgentMuxGuide: true } }, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    tabs: { [launcher.id]: launcher, [tab.id]: tab, [other.id]: other }, layouts: { [workspace.id]: createWorkspaceLayout('mote-group', [launcher.id, tab.id, other.id]) }, sessions: [session], documents: {}, dirtyDocuments: {}, documentIssues: {},
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', viewModes: { [session.id]: 'activity' }, agentComposerDrafts: { [session.id]: 'An original unsent question stays here.', 'launcher-region': 'Another original question.', 'analyst-region': 'Analyst draft.' }, scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), topics: [quickTopic(), secondTopic], revision: 0, error: null, reading: false } }, workspaceFileRevisions: {},
    workbenchSpaceSelection: { workspaceId: workspace.id, groupId: 'mote-group', tabId: tab.id, regionId: 'original-region', topicId: topic.id, spaceId, zoneId },
    prewarmTerminal: async () => {}, detectExecutors: async () => {}, launchAgent: async () => { throw Error('No Run may be launched by this Renderer proof') }, reportError: error => { calls.push({ operation: 'error' }); console.warn(String(error)) } })
}
reset()
function Scene() {
  const [epoch, setEpoch] = useState(0)
  const scope = useMoteWorkfaceScope(workspace.id)!
  const selection = useAppStore(state => state.workbenchSpaceSelection)
  const reference = selection?.tabId && selection.regionId && selection.groupId ? { displayWorkspaceId: selection.workspaceId, groupId: selection.groupId, tabId: selection.tabId, regionId: selection.regionId } : null
  const materials = useMoteMaterialsActions(scope, { reference })
  Object.assign(window, { moteQuick: {
    theme: (light: boolean) => { document.documentElement.dataset.appearance = light ? 'light' : 'dark' },
    reset: () => { reset(); setEpoch(value => value + 1) }, unknown: () => { unknown = true },
    enter: () => useAppStore.getState().openScratchTopic(topic.id, workspace.id),
    facts: () => { const state = useAppStore.getState(); return { defaults: quickTopic().quickMode, disk, drafts: state.agentComposerDrafts, tabs: state.tabs, layouts: state.layouts, selection: state.workbenchSpaceSelection, calls } },
    restartInput: () => { const state = useAppStore.getState(); return { config: state.config, sessions: [session], tabs: state.tabs, layouts: state.layouts, spaceZoneBindings: state.spaceZoneBindings, spatialRequests: state.spatialRequests, topics: [quickTopic(), secondTopic], selection: state.workbenchSpaceSelection, agentComposerDrafts: state.agentComposerDrafts,
      launcherState: useLauncherState.persist.getOptions().partialize!(useLauncherState.getState()), quickMode: { path: rootPath + '/MOTE.md', content: disk[rootPath + '/MOTE.md'], conversation } } }
  } })
  return <DesktopClientUiProvider><WindowOverlayHost /><main className="persona-scene">
    <aside className="persona-scene__profile"><MoteDetailsPanel key={epoch} scope={scope} reference={reference} onOpenPath={materials.open} onCreateNote={() => {}} /></aside>
    <section className="persona-scene__work"><MoteWorkface workspaceId={workspace.id}><WorkspaceWorkbench workspaceId={workspace.id} topicId={topic.id} topicIsolation="bound-only" /></MoteWorkface></section>
  </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
