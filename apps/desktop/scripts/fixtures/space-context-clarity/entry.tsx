import { fixturePath as _historyFixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseTopicParams, parseTopicResult, type TopicMethod, type TopicParams, type TopicResult, type TopicUnavailable } from '@agentmux/core/control'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { SurfaceToolDock } from '../../../src/renderer/src/components/SurfaceToolDock'
import { WorkspaceSidebar } from '../../../src/renderer/src/components/WorkspaceSidebar'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { useAppStore } from '../../../src/renderer/src/store'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../../../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName, scratchTopicPhysicalPath } from '../../../src/shared/scratch-topics'
import { DEFAULT_MOTE_BEHAVIOR } from '../../../src/shared/mote-behavior'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceRecord } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import './host.css'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../../test/fixture-values.mjs'


const scratch: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _historyFixturePath("fixture/scratch"), name: 'Topics', kind: 'folder' }
const folder: WorkspaceRecord = { id: 'context-folder', hostId: 'local', path: _historyFixturePath("fixture/projects/context"), name: 'Context project', kind: 'folder', branch: 'main' }
const category = { categoryId: '11111111-1111-4111-8111-111111111111', hostId: 'local',
  spaceId: directoryIdentity('local', _historyFixturePath("fixture/categories/research")), directoryPath: _historyFixturePath("fixture/categories/research"), title: 'Research', revision: 'sha256:' + 'c'.repeat(64) }
function topic(id: string, title: string, physical: string, kind: 'topic' | 'mote'): ScratchTopicSnapshot {
  const directoryPath = scratchTopicDirectoryName(id), identityDirectoryPath = scratch.path + '/' + directoryPath
  return { id, title, summary: kind === 'mote' ? 'A retained Mote with its own material directory.' : 'Original references and working conclusions.',
    kind, directoryPath, identityDirectoryPath, physicalDirectoryPath: physical, confirmedDirectoryPaths: [identityDirectoryPath, physical],
    topicPath: directoryPath + '/topic.md', collaborators: [],
    ...(kind === 'mote' ? { soul: { path: directoryPath + '/SOUL.md', content: '# Research companion\nKeep original references available.\n', version: 'soul-fixture' },
      moteArchive: { state: 'active' as const, version: 'archive-fixture' } } : {}) }
}
const first = topic('view:context-research', 'Field research', _historyFixturePath("fixture/objects/topics/field-research"), 'topic')
const second = topic('view:context-methods', 'Working methods', _historyFixturePath("fixture/objects/topics/working-methods"), 'topic')
const mote = topic('view:context-companion', 'Research companion', _historyFixturePath("fixture/objects/motes/research-companion"), 'mote')
const primary = topic(PMO_TEAMS_TOPIC_ID, 'Mote', _historyFixturePath("fixture/objects/motes/primary"), 'mote')
const topics = [first, second, mote, primary]
const address = (value: ScratchTopicSnapshot) => {
  const spaceId = directoryIdentity(scratch.hostId, value.identityDirectoryPath!)
  return { spaceId, zoneId: homeZoneId(spaceId) }
}
const bindings = Object.fromEntries(topics.map(value => {
  const original = address(value)
  return [original.zoneId, { spaceId: original.spaceId, workspaceId: scratch.id, topicId: value.id, contentKind: value.kind,
    directoryPath: value.physicalDirectoryPath, ...(value.kind === 'topic' ? { relations: { [category.spaceId]: true } } : {}) }]
}))
const tabs = Object.fromEntries(topics.map(value => {
  const tab = { ...createWorkbenchTab(value.id + ':tab', { kind: 'launcher', workspaceId: scratch.id, regionId: value.id + ':region' }),
    topicId: value.id, space: { spaceId: value.kind === 'topic' ? category.spaceId : address(value).spaceId, zoneId: address(value).zoneId } }
  return [tab.id, tab]
}))
const originalLayout = createWorkspaceLayout('original-topic-group', Object.keys(tabs))
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Fixture Host' }], executors: {}, workspaces: [scratch, folder],
  appearance: { terminalTheme: 'graphite', appAppearance: 'dark' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } },
  notifications: { mode: 'off' } }
const transport: { method: string; params: unknown; result?: unknown }[] = []
let observation: 'partial' | 'mixed' | 'empty' | 'complete' | 'history' | 'failed' = 'partial', searchNumber = 0, moteUnavailable = false
const record = (method: string, params: unknown, result?: unknown) => transport.push({ method, params, ...(result === undefined ? {} : { result }) })
const forbidden = async (...args: unknown[]) => { record('forbidden-write', args); throw new Error('This capture does not authorize disk, Git, Browser or Runtime mutations') }
const partial: TopicUnavailable = { code: 'TOPIC_KNOWLEDGE_PARTIAL', message: 'Knowledge discovery reached its result limit. This is a partial observation.',
  source: first.id, recovery: 'Narrow the Topic or query, or open the exact original file. Refreshing keeps the same discovery budget.' }
const unavailable: TopicUnavailable = { code: 'TOPIC_DOCUMENTS_UNREADABLE', message: 'The original source could not be read; available results are retained.',
  source: first.id + ':outcome/unavailable.md', recovery: 'Restore access to this original source and retry the same Topic.' }
const historyIssue: TopicUnavailable = { code: 'TOPIC_SEARCH_HISTORY_UNAVAILABLE', message: 'The search result is available but its history could not be saved.',
  source: 'fixture-search-history', recovery: 'Restore the original history storage and retry recording. Keep the available results.' }
function fact(value: ScratchTopicSnapshot) {
  return { topicId: value.id, hostId: scratch.hostId, zoneId: address(value).zoneId, directoryPath: value.physicalDirectoryPath!,
    title: value.title, summary: value.summary, categorySpaceIds: value.kind === 'topic' ? [category.spaceId] : [],
    chatIds: [value.id + ':tab'], spatialRevision: 1 }
}
function entries(topicId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ topicId, entryId: '22222222-2222-4222-8222-' + String(index + 1).padStart(12, '0'),
    title: index === 0 ? 'Keep the original source in view' : 'Research note ' + String(index + 1).padStart(3, '0'),
    content: index === 0 ? 'The available result is still useful when discovery is bounded.\n\nKeep the original Topic, directory and unsent draft. A partial observation does not mean that the Topic is broken.' : 'A retained observation with an original source and explicit reading scope.',
    form: 'derived' as const, certainty: 'fact' as const, sources: [{ kind: 'file' as const, hostId: 'local', path: _historyFixturePath("fixture/sources/research-notes.md") }],
    revision: 'sha256:' + (index + 1).toString(16).padStart(64, '0'), updatedAt: _historyFixtureEpoch(0, 0, 0) }))
}
async function call<M extends TopicMethod>(method: M, input: TopicParams<M>): Promise<TopicResult<M>> {
  const params = parseTopicParams(method, input), requested = 'topicId' in params ? topics.find(value => value.id === params.topicId) : undefined
  let result: unknown
  if (method === 'topic.category.ls') result = { categories: [category], unavailable: [] }
  else if (method === 'topic.ls') result = { topics: [first, second].map(fact), unavailable: [] }
  else if (method === 'topic.inspect') result = { topic: requested ? fact(requested) : null, unavailable: [] }
  else if (method === 'topic.knowledge.ls' || method === 'topic.knowledge.search') {
    if (observation === 'failed') {
      const error = { code: 'TOPIC_SEARCH_UNAVAILABLE', message: 'The requested search could not be read. The original confirmed result remains available.',
        source: requested?.id ?? first.id, recovery: 'Restore this source and retry the same submitted query.' }
      record(method, params, { rejected: error })
      throw Object.assign(new Error(error.message), error)
    }
    const topicId = requested?.id ?? first.id
    const issues = observation === 'complete' || observation === 'history' ? [] : [{ ...partial, source: topicId }, ...(observation === 'mixed' ? [unavailable] : [])]
    const matches = entries(topicId, observation === 'empty' ? 0 : observation === 'complete' || observation === 'history' ? 3 : 100)
    result = { entries: matches, documents: [], unavailable: issues,
      ...(method === 'topic.knowledge.search' ? { observation: { history: observation === 'history' ? 'unavailable' : 'saved', unavailable: observation === 'history' ? [historyIssue] : [], record: {
        searchId: '33333333-3333-4333-8333-' + String(++searchNumber).padStart(12, '0'), query: 'query' in params ? params.query : '',
        topicId: requested?.id ?? null, limit: 100, startedAt: _historyFixtureEpoch(0, 0, 0), finishedAt: _historyFixtureEpoch(0, 0, 1), durationMs: 1,
        outcome: issues.length ? 'partial' : 'complete', counters: { topicsVisited: 1, candidates: matches.length, readBytes: 0,
          chargedBytes: 0, unconfirmedReads: observation === 'mixed' ? 1 : 0, entryMatches: matches.length, documentMatches: 0 },
        stopReason: issues.length ? 'result-limit' : null, issues: issues.map(({ code, source }) => ({ code, source })), omittedIssueCount: 0
      } } } : {}) }
  } else return forbidden(method, params)
  const validated = parseTopicResult(method, result, params)
  record(method, params, validated)
  return validated
}
api.topics.call = call
api.ui.requestStorageFlush = async () => undefined
api.scratch.listTopics = async workspaceId => { record('scratch.listTopics', { workspaceId }); return topics }
api.scratch.readTopic = async (workspaceId, topicId) => {
  const value = topics.find(value => value.id === topicId)
  const result = value ? moteUnavailable && value.id === mote.id ? { ...value, readError: 'The original Mote metadata observation is unavailable. Its confirmed material directory and original workface are retained.' } : value : null
  record('scratch.readTopic', { workspaceId, topicId }, result); return result
}
api.scratch.ensureMote = async (workspaceId, topicId) => {
  const value = topics.find(value => value.id === topicId && value.kind === 'mote')
  if (!value) throw new Error('Only an existing configured Mote is available in this fixture')
  record('scratch.ensureMote-existing', { workspaceId, topicId }); return value
}
api.git.projectIdentity = async workspaceId => ({ kind: 'no-remote', hostId: 'local', repoPath: folder.path })
api.files.readDirectory = async (workspaceId, path) => {
  record('files.readDirectory', { workspaceId, path })
  const names = path === '' ? (workspaceId === folder.id ? ['src', 'README.md'] : topics.map(value => value.directoryPath))
    : topics.some(value => value.directoryPath === path) ? ['outcome', 'SOUL.md', 'BEHAVIOR.md', 'topic.md'] : []
  return names.map(name => ({ name, path: path ? path + '/' + name : name, isDirectory: name === 'src' || name === 'outcome' || topics.some(value => value.directoryPath === name), isSymlink: false }))
}
api.files.observe = async (...args) => { record('files.observe', args) }
api.files.unobserve = async (...args) => { record('files.unobserve', args) }
api.files.readPublic = async params => {
  const value = topics.find(value => address(value).zoneId === params.zoneId)
  if (!value) throw new Error('No exact original fixture file resource')
  const content = params.path === 'BEHAVIOR.md' ? DEFAULT_MOTE_BEHAVIOR : '# Research companion\nKeep the original sources and working directory.\n'
  const path = value.directoryPath + '/' + params.path
  const result = { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: value.physicalDirectoryPath!,
    logicalDirectory: value.directoryPath, path }, result: { status: 'read' as const, document: { path, content, revision: 'sha256:' + 'f'.repeat(64) } } }
  record('files.readPublic', params, result)
  return result
}
api.files.write = forbidden
api.sessions.launchAgent = forbidden
api.workspaces.openBranch = forbidden
api.workspaces.createWorktreeForBranch = forbidden
api.workspaces.listBranches = async workspaceId => {
  const result = { kind: 'git-repository' as const, hostId: 'local', repoPath: folder.path,
    branches: [{ name: 'main', worktreePath: folder.path, workspaceId: folder.id, isCurrent: true }] }
  record('workspaces.listBranches', { workspaceId }, result); return result
}
Object.assign(window, { agentmux: { git: {
  status: async (workspaceId: string) => {
    const result = { kind: 'git-repository', hostId: 'local', repoPath: folder.path, repoRelativePrefix: '', branch: 'main', changes: [] }
    record('git.status', { workspaceId }, result); return result
  }, aheadBehind: async () => null, commit: forbidden, stage: forbidden, unstage: forbidden, discard: forbidden
} } })
useAppStore.setState({ config, loading: false, localHome: _historyFixturePath("fixture"), activeWorkspaceId: scratch.id, mainSurface: 'workbench',
  workspaceTool: 'files-branches', workspaceGitView: 'changes', projectRailOpen: true, toolsOpen: true,
  tabs, layouts: { [scratch.id]: originalLayout, [folder.id]: createWorkspaceLayout('original-folder-group') },
  workbenchSpaceSelection: { workspaceId: scratch.id, spaceId: category.spaceId, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null },
  spaceZoneBindings: bindings, topicCategories: [category], projectGroups: [], sessions: [], workspaceFileRevisions: {},
  scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 0, reading: false, error: null, topics } },
  spatialRequests: {}, explorerCollapsed: {}, collapsedProjectGroups: {}, scratchTopicOrder: topics.map(value => value.id),
  agentComposerDrafts: { [first.id + ':region']: 'Original unsent Topic draft', [mote.id + ':region']: 'Original unsent Mote draft' } })
mountThemeRuntime(window, config.appearance)
function Scene() {
  const workspace = useAppStore(state => state.config?.workspaces.find(value => value.id === state.activeWorkspaceId))
  return <DesktopClientUiProvider><div className="capture-host"><WorkspaceSidebar /><div className="capture-dock"><SurfaceToolDock workspace={workspace} /></div></div><WindowOverlayHost /></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
Object.assign(window, { spaceContextFixture: {
  fixtureHome: _historyFixturePath("fixture"),
  identities: { category, first, second, mote, folder, scratch, folderProject: directoryIdentity(folder.hostId, folder.path),
    folderZone: workspaceZoneId(directoryIdentity(folder.hostId, folder.path), folder.id), partial, unavailable, historyIssue },
  theme(mode: 'dark' | 'light') {
    flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: mode } } })))
    updateThemeSelection({ appAppearance: mode })
  },
  observation(mode: typeof observation) { observation = mode },
  moteUnavailable(value: boolean) { moteUnavailable = value },
  transport() { return structuredClone(transport) },
  facts() {
    const state = useAppStore.getState(), selected = state.workbenchSpaceSelection
    const original = selected?.topicId ? state.scratchTopicSnapshots[scratch.id]?.topics?.find(value => value.id === selected.topicId) : undefined
    return { activeWorkspaceId: state.activeWorkspaceId, selection: selected, tool: state.workspaceTool, view: state.workspaceGitView,
      object: original ? { id: original.id, kind: original.kind, physicalPath: scratchTopicPhysicalPath(scratch, original),
        logicalPath: original.directoryPath, issue: original.readError ?? null, ...address(original) } : null,
      tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts, sessions: state.sessions,
      catalog: workbenchSelectionCatalog(state), observation, transportCount: transport.length,
      latestDirectoryRead: [...transport].reverse().find(value => value.method === 'files.readDirectory') ?? null }
  }
} })
