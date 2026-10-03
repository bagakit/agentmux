import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { MoteDetailsPanel } from '../../../src/renderer/src/components/MoteDetailsPanel'
import { FileSurfaceView } from '../../../src/renderer/src/components/FileSurfaceView'
import { NewTabSurface } from '../../../src/renderer/src/components/NewTabSurface'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { useMoteMaterialsActions } from '../../../src/renderer/src/lib/mote-materials-actions'
import { useMoteWorkfaceScope } from '../../../src/renderer/src/lib/mote-workface'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import type { ScratchTopicSnapshot, WorkspaceFileReadResult, SessionSnapshot } from '../../../src/shared/contracts'
import type { Demand } from '@agentmux/demand'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
import '../../../src/renderer/src/styles/index.css'
import './persona-scene.css'

const workspacePath = new URLSearchParams(location.search).get('workspacePath')
if (!workspacePath) throw new Error('This private Renderer requires its exact isolated workspace path.')
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspacePath, name: 'Motes', kind: 'folder' as const }
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = rootPath + '/context-and-decisions-with-an-original-source.md', anotherPath = rootPath + '/another-original-material.md'
const soul = '# Mote\n\nWork with me as a thoughtful colleague. Keep my current directions first.\n\nKeep this custom paragraph unchanged.\n'
const topic: ScratchTopicSnapshot = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: 'A place to work through ideas together.', directoryPath: workspace.path + '/' + rootPath,
  topicPath: workspace.path + '/' + rootPath + '/topic.md', collaborators: [], soul: { path: workspace.path + '/' + rootPath + '/SOUL.md', content: soul, version: 'display-soul-version' } }
const secondId = 'launcher:analyst', secondRoot = scratchTopicDirectoryName(secondId)
const secondTopic: ScratchTopicSnapshot = { ...topic, id: secondId, title: 'Analyst', directoryPath: workspace.path + '/' + secondRoot,
  topicPath: workspace.path + '/' + secondRoot + '/topic.md', soul: { ...topic.soul!, path: workspace.path + '/' + secondRoot + '/SOUL.md' } }
const topics = [topic, secondTopic], spaceId = directoryIdentity('local', topic.directoryPath), zoneId = homeZoneId(spaceId)
const original = createWorkbenchTab('original-launcher', { kind: 'launcher', regionId: 'original-region', workspaceId: workspace.id })
const tab = { ...original, topicId: topic.id, space: { spaceId, zoneId } }
const secondSpace = directoryIdentity('local', secondTopic.directoryPath)
const secondTab = { ...createWorkbenchTab('second-launcher', { kind: 'launcher', regionId: 'second-region', workspaceId: workspace.id }), topicId: secondId,
  space: { spaceId: secondSpace, zoneId: homeZoneId(secondSpace) } }
const contextSession: Extract<SessionSnapshot, { kind: 'agent' }> = { id: 'renderer-fixture-context', kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
  workspacePath: topic.directoryPath, label: 'Original fixture discussion', createdAt: 1, updatedAt: 2, agentSessionUpdatedAt: 2, processState: 'running', latestOutputBytes: 0,
  status: { state: 'waiting', source: 'native-hook', observedAt: 2 }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'core-fixture-context', run: { runId: 'fixture-context-run' } } }
const calls: { operation: string; path?: string; message?: string; agentSessionId?: string; hostId?: string; limit?: number }[] = []
let unknown = false, editorUnconfirmed = false, unknownWrite = false, deferNextRead = false, lateRead: { params: FileReadParams; resolve(result: FileReadResult): void } | null = null, unsubscribeLater: (() => void) | null = null
let fileDisk: Record<string, string> = { [rootPath + '/SOUL.md']: soul, [path]: '# A saved decision\n\nSource: the team discussion on 6 October.\nScope: this project.\n\nKeep the current design until the next review. The earlier preference applies only to the draft.\n',
  [anotherPath]: '# Another original material\n\nThis file has its own confirmed content.', [secondRoot + '/SOUL.md']: soul, [secondRoot + '/analyst-original-material.md']: '# Analyst material\n\nSource: the Analyst Mote directory.\nThis belongs to the other original scope.' }
const revision = async (content: string) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
api.files.readDirectory = async (_workspace, directory) => Object.keys(fileDisk).filter(path => path.startsWith(directory + '/')).map(path => ({ path, name: path.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false, mtimeMs: 20 }))
api.files.read = async (_workspace, path): Promise<WorkspaceFileReadResult> => {
  calls.push({ operation: 'read', path })
  return editorUnconfirmed ? { status: 'error', code: 'EACCES', message: 'The original SOUL could not be read. Its saved source stays unchanged.' }
    : { status: 'read', document: { path, content: fileDisk[path] ?? '', revision: await revision(fileDisk[path] ?? '') } }
}
const materialResult = async (params: FileReadParams, content?: string): Promise<FileReadResult> => {
  const owner = topics.find(topic => homeZoneId(directoryIdentity(workspace.hostId, topic.directoryPath)) === params.zoneId)!
  const root = scratchTopicDirectoryName(owner.id), path = root + '/' + params.path
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: workspace.path + '/' + root, path },
    result: { status: 'read', document: { path, content: content ?? fileDisk[path] ?? '', revision: await revision(content ?? fileDisk[path] ?? '') } } }
}
api.files.readPublic = async params => {
  calls.push({ operation: 'file.read', path: params.path })
  if (deferNextRead) { deferNextRead = false; return new Promise(resolve => { lateRead = { params, resolve } }) }
  return unknown ? { resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'The original file resource is temporarily unconfirmed. Your saved content and reference are kept.' } } : materialResult(params)
}
api.files.observe = async () => {}; api.files.unobserve = async () => {}; api.files.onInvalidated = () => () => {}
api.files.write = async (_workspace, input) => { calls.push({ operation: 'write', path: input.path }); fileDisk[input.path] = input.content;
  return unknownWrite ? { status: 'unknown', code: 'RECEIPT_LOST', message: 'The write receipt is unconfirmed. Check the same saved file.' } : { status: 'written', revision: await revision(input.content) } }
api.scratch.listTopics = async () => topics; api.scratch.readTopic = async (_workspace, id) => topics.find(topic => topic.id === id)!; api.scratch.ensureMote = async () => topic
api.sessions.historyPage = async (control, options) => {
  calls.push({ operation: 'historyPage', ...control, limit: options?.limit })
  return { agentSessionId: control.agentSessionId, source: { providerId: contextSession.providerId, nativeSessionId: 'fixture-native-context' }, nextCursor: null,
    items: [{ id: 'original-context-message', kind: 'user-message', contentParts: [{ kind: 'text', text: 'We chose to compare a small experiment before expanding the project.' }] }] }
}
api.demands.list = async () => {
  calls.push({ operation: 'demands.list' })
  const goal = (id: string, sessionIds: string[]): Demand => ({ id, title: id, description: 'A small inspectable experiment with an original Goal source.', sessionIds,
    status: 'in_progress', priority: 'normal', projectId: null, projectName: null, executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, activities: [], decisions: [], createdAt: 10, updatedAt: 20 })
  return [goal('renderer-linked-idea-goal', [contextSession.id]), goal('core-alias-not-linked', [contextSession.control.agentSessionId]), goal('background-goal-not-selected', ['other-renderer-session'])]
}

function reset() {
  topic.title = 'Mote'
  unknown = false; editorUnconfirmed = false; unknownWrite = false; deferNextRead = false; lateRead = null; unsubscribeLater?.(); unsubscribeLater = null; calls.length = 0
  fileDisk[rootPath + '/SOUL.md'] = soul
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    tabs: { [tab.id]: tab, [secondTab.id]: secondTab }, layouts: { [workspace.id]: createWorkspaceLayout('mote-group', [tab.id, secondTab.id]) }, sessions: [], documents: {}, dirtyDocuments: {}, documentIssues: {},
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', agentComposerDrafts: { 'original-region': 'An original unsent question stays here.', 'second-region': 'The other Mote keeps its own unsent draft.' }, scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), topics, revision: 0, error: null, reading: false } }, workspaceFileRevisions: {},
    workbenchSpaceSelection: { workspaceId: workspace.id, groupId: 'mote-group', tabId: tab.id, regionId: 'original-region', topicId: topic.id, spaceId, zoneId },
    prewarmTerminal: async () => {}, detectExecutors: async () => {}, reportError: error => { calls.push({ operation: 'error', message: String(error) }); console.warn(String(error)) } })
}
reset()
function Scene() {
  const [epoch, setEpoch] = useState(0)
  const scope = useMoteWorkfaceScope(workspace.id)!
  const selection = useAppStore(state => state.workbenchSpaceSelection)
  const selected = useAppStore(state => selection?.tabId ? state.tabs[selection.tabId] : undefined)
  const region = selected && selection?.regionId ? selected.regions[selection.regionId] : undefined
  const reference = selection?.tabId && selection.regionId && selection.groupId ? { displayWorkspaceId: workspace.id, groupId: selection.groupId, tabId: selection.tabId, regionId: selection.regionId } : null
  const materials = useMoteMaterialsActions(scope, { reference })
  Object.assign(window, { moteCompanion: { calls, reset: () => { reset(); setEpoch(value => value + 1) }, unknown: () => { unknown = true; useAppStore.setState(state => ({ workspaceFileRevisions: { [workspace.id]: (state.workspaceFileRevisions[workspace.id] ?? 0) + 1 } })) },
    selectMote: (id: string) => useAppStore.getState().openScratchTopic(id, workspace.id, { tabId: id === secondId ? secondTab.id : tab.id }),
    unknownSave: () => { unknownWrite = true }, longName: () => { topic.title = 'Mote for thoughtful choices and a long project name'; setEpoch(value => value + 1) },
    originalSoul: () => soul,
    behaviorInput: () => ({ path: rootPath + '/SOUL.md', initialContent: soul, content: fileDisk[rootPath + '/SOUL.md'] }),
    unconfirmedEditor: () => { editorUnconfirmed = true },
    restartInput: () => { const state = useAppStore.getState(), launcher = useLauncherState.getState(); return {
      config: state.config, tabs: state.tabs, layouts: state.layouts, spaceZoneBindings: state.spaceZoneBindings, spatialRequests: state.spatialRequests,
      topics, selection: state.workbenchSpaceSelection, agentComposerDrafts: state.agentComposerDrafts,
      launcherState: useLauncherState.persist.getOptions().partialize!(launcher),
      ...(fileDisk[rootPath + '/SOUL.md'] !== soul ? { behavior: { path: rootPath + '/SOUL.md', initialContent: soul, content: fileDisk[rootPath + '/SOUL.md'] } } : {})
    } },
    selectExactContext: () => useAppStore.setState(state => ({ sessions: [contextSession], tabs: { ...state.tabs, [tab.id]: { ...tab, regions: {
      'original-region': { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: workspace.id, sessionId: contextSession.id } } } } })),
    armLaterDraft: () => {
      const before = useAppStore.getState().tabs
      unsubscribeLater = useAppStore.subscribe(current => {
        const tab = Object.values(current.tabs).find(candidate => !before[candidate.id])
        if (tab && current.agentComposerDrafts[tab.layout.activeRegionId] === undefined) current.setAgentComposerDraft(tab.layout.activeRegionId, 'Later user input stays in the new Launcher.')
      })
    }, armLateRead: () => { deferNextRead = true }, finishLateRead: async (fresh = false) => {
      if (!lateRead) throw new Error('No captured original read')
      const captured = lateRead; lateRead = null; captured.resolve(await materialResult(captured.params, fresh ? undefined : 'STALE ORIGINAL MOTE SECRET'))
    }, facts: () => { const state = useAppStore.getState(); return { drafts: state.agentComposerDrafts, selection: state.workbenchSpaceSelection,
      selectedDraft: state.agentComposerDrafts[state.workbenchSpaceSelection?.regionId ?? ''], tabs: Object.keys(state.tabs), documents: state.documents, dirty: state.dirtyDocuments,
      ideaInputs: Object.values(useLauncherState.getState().drafts).flatMap(draft => draft.moteIdea ? [draft.moteIdea] : []), calls, hasLateRead: !!lateRead } },
    theme: (light: boolean) => { document.documentElement.dataset.appearance = light ? 'light' : 'dark' } } })
  return <DesktopClientUiProvider><WindowOverlayHost /><main className="persona-scene">
    <aside className="persona-scene__profile"><MoteDetailsPanel key={epoch} scope={scope} reference={reference} onOpenPath={materials.open} onCreateNote={() => {}} /></aside>
    <section className="persona-scene__work"><div className="persona-scene__tab"><div className="persona-scene__navigation" aria-label="Fixture original Mote navigation">{topics.map(topic => <button key={topic.id} className="small-button" data-fixture-mote={topic.id} onClick={() => useAppStore.getState().openScratchTopic(topic.id, workspace.id, { tabId: topic.id === secondId ? secondTab.id : tab.id })}>{topic.title}</button>)}</div>{region?.kind === 'file' ? region.path.split('/').at(-1) : 'New discussion'}</div><div className="workbench-region" style={{ flex: 1, minHeight: 0 }}>
      {selected && region?.kind === 'file' ? <FileSurfaceView tabId={selected.id} surface={region} /> : selected && region?.kind === 'launcher' ? <NewTabSurface tabId={selected.id} regionId={region.regionId} tabGroupId="mote-group" /> : null}
    </div></section>
  </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
