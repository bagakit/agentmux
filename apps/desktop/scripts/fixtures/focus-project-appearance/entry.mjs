import '../focus-composable-filters/entry.mjs'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, agentRegionLocationsKnown, agentRegionLocationBindings, agentRegionExecution } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/contracts'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { createFocusContextIdentitySelector } from '../../../src/renderer/src/lib/focus-context-identity'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'

// Reuse the maintained actual App/preview setup. Only original image transport
// is routed to this private Main's real projectAppearance recognition owner.
const before = useAppStore.getState(), alpha = before.config.workspaces.find(workspace => workspace.id === 'alpha')
const root = { ...alpha, name: 'AgentMux' }, beta = { ...before.config.workspaces.find(workspace => workspace.id === 'beta'), name: 'Design Systems' }
const branches = ['interface', 'protocol'].map(branch => ({ ...root, id: 'branch-' + branch, repoPath: root.path, path: root.path + '/.worktrees/' + branch, branch, name: branch }))
const unknown = { ...root, id: 'unknown-image', name: 'Research project with a long original name', path: root.path + '-research' }
const orphan = { ...root, id: 'orphan', name: 'Retained checkout', path: root.path + '-checkout', repoPath: root.path + '-unregistered', branch: 'retained' }
const added = [...branches, unknown, orphan]
const sample = before.sessions.find(session => session.id === 'alpha-working')
const sessions = added.flatMap((workspace, index) => Array.from({ length: index < 2 ? 3 : 1 }, (_, n) => ({ ...sample,
  id: workspace.id + '-task-' + n, workspacePath: workspace.path, label: 'Original task',
  control: { ...sample.control, agentSessionId: workspace.id + '-task-' + n, run: { runId: 'appearance-' + workspace.id + '-' + n } },
  status: { state: n === 0 ? 'working' : n === 1 ? 'done' : 'running', source: 'native-hook', observedAt: Date.now() } })))
const scratch = before.config.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
if (!scratch) throw Error('Original Topic workspace required')
const topicSnapshot = before.scratchTopicSnapshots[scratch.id]
const originalTopic = topicSnapshot.topics.find(topic => topic.kind === 'topic')
const secondTopic = { ...originalTopic, id: 'launcher:organization-second', title: 'Reading complete product evidence while preserving the original shared workspace and its exact source identity',
  directoryPath: scratch.path + '/organization-second', identityDirectoryPath: scratch.path + '/organization-second', topicPath: scratch.path + '/organization-second/topic.md' }
const categoryPath = scratch.path + '/category--research'
const category = { categoryId: '11111111-1111-4111-8111-111111111111', hostId: 'local', directoryPath: categoryPath, title: 'Research', revision: 'original-category', spaceId: directoryIdentity('local', categoryPath) }
const collectionKey = JSON.stringify(['collection', 'local', category.spaceId])
const collectionBindings = { ...before.spaceZoneBindings }
for (const topic of [originalTopic, secondTopic]) {
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath ?? topic.directoryPath)
  collectionBindings[homeZoneId(spaceId)] = { spaceId, workspaceId: scratch.id, topicId: topic.id, contentKind: 'topic', directoryPath: topic.directoryPath,
    relations: { [category.spaceId]: true }, resource: { kind: 'home', hostId: 'local', directoryPath: topic.directoryPath, branch: null } }
}
sessions.push({ ...sample, id: 'organization-second-task', label: 'Read the latest implementation evidence', workspacePath: secondTopic.directoryPath,
  control: { ...sample.control, agentSessionId: 'organization-second-task', run: { runId: 'original-second-topic-run' } } })
const tabs = { ...before.tabs }, layouts = { ...before.layouts }
const secondTab = createWorkbenchTab('organization-second-tab', { kind: 'agent', phase: 'attached', workspaceId: scratch.id, sessionId: 'organization-second-task', regionId: 'organization-second-region' })
tabs[secondTab.id] = secondTab
layouts[scratch.id] = { ...layouts[scratch.id], groups: layouts[scratch.id].groups.map((group, index) => index === 0 ? { ...group, tabOrder: [...group.tabOrder, secondTab.id] } : group) }
for (const workspace of added) {
  const session = sessions.find(session => session.workspacePath === workspace.path)
  const tab = createWorkbenchTab('appearance-tab-' + workspace.id, { kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id, regionId: 'appearance-region-' + workspace.id })
  tabs[tab.id] = tab; layouts[workspace.id] = createWorkspaceLayout('appearance-group-' + workspace.id, [tab.id])
}
// Every ordinary fixture actor gets an explicit original Region. The one
// genuinely unregistered Topic remains unknown rather than borrowing a project.
const located = new Set(Object.values(tabs).flatMap(tab => Object.values(tab.regions).flatMap(region => region.kind === 'agent' ? [region.sessionId] : [])))
for (const session of [...before.sessions, ...sessions]) {
  if (located.has(session.id)) continue
  const workspace = [root, beta, ...added].find(workspace => workspace.path === session.workspacePath)
  if (!workspace) continue
  const tab = createWorkbenchTab('appearance-original-' + session.id, { kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id, regionId: 'appearance-original-region-' + session.id })
  tabs[tab.id] = tab
  const layout = layouts[workspace.id]
  layouts[workspace.id] = { ...layout, groups: layout.groups.map((group, index) => index === 0 ? { ...group, tabOrder: [...group.tabOrder, tab.id] } : group) }
}
const names = Object.fromEntries(sessions.map((session, i) => [session.id, ['Simplify project finding routes', 'Preserve the shared conversation reader', 'Review original protocol observations'][i % 3]]))
const calls = [], pending = new Map()
api.workspaces.appearance = async id => {
  calls.push(id)
  if (id === 'unknown-image') return new Promise(resolve => pending.set(id, resolve))
  return window.projectAppearanceFixture.read(id)
}
const copiedInputs = []
api.ui.writeClipboardText = async value => { copiedInputs.push(value) }
const retainedSource = { hostId: 'local', agentSessionId: 'retained-design', state: 'retired', history: {
  providerId: 'generic', executorId: 'generic', workspacePath: root.path, createdAt: Date.now(),
  nativeHandle: { kind: 'provider', providerId: 'generic', sessionId: 'retained-original-native' } } }
api.sessions.historySources = async options => options?.observation ? { sources: [retainedSource], warnings: [] } : [retainedSource]
let saveFailure = false
const save = api.config.save
api.config.save = (...args) => saveFailure ? Promise.reject(Error(('The original project settings changed while editing. Your note and color draft remain here. Review current settings and retry. ').repeat(3))) : save(...args)
useAppStore.setState({ config: { ...before.config, workspaces: [root, beta, ...before.config.workspaces.filter(workspace => !['alpha', 'beta'].includes(workspace.id)), ...added],
  focus: { ...before.config.focus, projects: [{ key: JSON.stringify(['local', 'alpha']), pinned: true, note: 'Daily collaboration', color: 'blue', collapsed: null }] } },
  spaceZoneBindings: collectionBindings, topicCategories: [category], scratchTopicSnapshots: { ...before.scratchTopicSnapshots, [scratch.id]: { ...topicSnapshot, topics: [...topicSnapshot.topics, secondTopic] } },
  agentSteerQueues: { ...before.agentSteerQueues, 'retained-design': [{ operationId: 'original-review-input', text: 'Review the original workspace without sending this retained input.', status: 'deferred', archived: true, awaitingExplicitSend: true,
    directInputControl: { kind: 'agent', hostId: 'local', agentSessionId: 'retained-design', run: { runId: 'retained-original-run' } } }] },
  tabs, layouts, sessions: [...before.sessions, ...sessions], agentNames: { ...before.agentNames, ...names } })
// Admit the arranged workface through the original restore owner, as the actual
// component tests do. Missing directory observations are not confirmed projects.
const arranged = useAppStore.getState()
await save(arranged.config, await api.config.get())
api.sessions.snapshot = async () => ({ sessions: arranged.sessions, timelines: arranged.timelines, recoveryCandidates: [] })
api.demands.list = async () => []
api.ui.requestStorageFlush = async () => {}
const saved = await api.spatial.read(), snapshot = api.sessions.snapshot
useAppStore.setState({ sessions: [], tabs: {}, layouts: {} })
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
await api.spatial.commit({ expectedRevision: saved?.revision ?? 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
const dispose = await useAppStore.getInitialState().initialize()
const started = await api.spatial.read()
await api.spatial.commit({ expectedRevision: started.revision, graph: desktopSpatialGraph(arranged, Object.values(arranged.scratchTopicSnapshots).flatMap(snapshot => snapshot.topics)) })
await new Promise(resolve => setTimeout(resolve, 0))
dispose()
api.sessions.snapshot = snapshot
useAppStore.setState(arranged, true)
let preserved
window.appearanceProof = {
  remember() { preserved = useAppStore.getState() },
  copiedInputs, collectionKey,
  selection() { return useAppStore.getState().workbenchSpaceSelection },
  preservation() { const state = useAppStore.getState(); return { sameTabs: state.tabs === preserved.tabs, sameLayouts: state.layouts === preserved.layouts,
    sameDrafts: state.agentComposerDrafts === preserved.agentComposerDrafts, sameQueues: state.agentSteerQueues === preserved.agentSteerQueues,
    sameRuns: state.sessions.every(session => session.control.run === preserved.sessions.find(original => original.id === session.id)?.control.run),
    controls: window.filterProof.facts().calls } },
  debug() { const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state), contexts = createFocusProjectionSelector()(state, true, 'metadata', true).contexts; return { contexts: contexts.map(context => ({ id: context.id, hostId: context.hostId, control: context.control })), identities: [...createFocusContextIdentitySelector()(catalog, state.tabs, contexts, state.config, state.layouts, agentRegionExecution, agentRegionLocationsKnown(), agentRegionLocationBindings())], known: agentRegionLocationsKnown(), bindings: agentRegionLocationBindings(), catalog: workbenchSelectionCatalog(state), error: state.error, warning: state.workbenchSaveWarning } },
  calls, enter: () => useAppStore.setState({ mainSurface: 'agents', focusView: 'list' }),
  theme: appAppearance => useAppStore.setState(state => ({ config: { ...state.config, appearance: { ...state.config.appearance, appAppearance } } })),
  failSave(value) { saveFailure = value },
  async finishUnknown() { pending.get('unknown-image')?.({ kind: 'directory', icon: null }) },
  facts() { const state = useAppStore.getState(); return { mainSurface: state.mainSurface, focusView: state.focusView, organizationPreferences: state.config.focus?.zonePresentations ?? [], calls: [...calls], groups: [...document.querySelectorAll('[data-project-group-key]')].map(group => ({ key: group.dataset.projectGroupKey,
    entries: group.querySelectorAll('.focus-project-preferences__trigger').length, branches: group.querySelectorAll('[data-lane-id]').length, zones: new Set([...group.querySelectorAll('[data-focus-zone-id]')].map(element => element.dataset.focusZoneId)).size, watermarks: group.querySelectorAll('[data-project-watermark]').length })) } }
}
