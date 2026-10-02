import { fixturePath as _hygiene_fixturePath, fixtureTime as _hygiene_fixtureTime } from "../../lib/fixture-values.mjs"
import { createElement, Fragment } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { desktopWorkbenchFromSpatial } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { topicSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { DEFAULT_MOTE_FACE } from '../../../src/shared/mote-avatars'
import '../../../src/renderer/src/styles/index.css'

const phase = new URLSearchParams(location.search).get('phase')
const retainedSurface = true
window.sharedFrameSetup.phase = 'controlled-public-data'
const publicConfig = await api.config.get()
const prototype = (await api.sessions.snapshot()).sessions.find(session => session.kind === 'agent')
if (!prototype) throw new Error('A nonempty typed Session prototype is required')
const project = { id: 'private-project', hostId: 'local', path: _hygiene_fixturePath("private/shared-frame/project"), name: 'Original project', kind: 'folder' }
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("private/shared-frame/topics"), name: 'Topics', kind: 'folder' }
const ordinaryId = 'launcher:ordinary'
const customId = 'launcher:reviewer', targetId = 'mote-primary-tab', neighborId = 'mote-neighbor-tab', customTabId = 'custom-mote-tab'
const floatingKey = 'agentmux.leader-topic-floating.v1', durableKey = 'agentmux-workbench-v1'
const spatialKey = 'agentmux.private-shared-frame-spatial-port.v1'
const initialSpatial = JSON.parse(localStorage.getItem(spatialKey) ?? 'null')
let spatialState = initialSpatial, initializeCalls = 0, afterOrdinaryInitialize = null, seedApplied = false
const spatialListeners = new Set()
// Controlled public-port replies only. The original DesktopSpatialPersistence owns topology,
// rebase, stage and flush; this boundary persists returned bytes in the private profile.
api.spatial.read = async () => {
  calls.push({ operation: 'spatialRead', revision: spatialState?.revision ?? 0 }); return structuredClone(spatialState)
}
api.spatial.commit = async input => {
  if (input.expectedRevision !== (spatialState?.revision ?? 0)) throw new Error('Controlled private spatial revision changed')
  const returned = { schemaVersion: 1, revision: input.expectedRevision + 1, graph: structuredClone(input.graph) }
  localStorage.setItem(spatialKey, JSON.stringify(returned)); spatialState = returned
  calls.push({ operation: 'spatialCommit', expectedRevision: input.expectedRevision, revision: returned.revision })
  for (const listener of spatialListeners) listener(structuredClone(returned))
  return structuredClone(returned)
}
api.spatial.onChange = listener => { spatialListeners.add(listener); calls.push({ operation: 'spatialSubscribe' }); return () => spatialListeners.delete(listener) }
const calls = [], recovered = new Set(), initialDurable = JSON.parse(localStorage.getItem(durableKey) ?? 'null')
const initialFloating = JSON.parse(localStorage.getItem(floatingKey) ?? 'null')
const sessions = [ ['project-worker', null], ['project-reader', null], ['mote-primary', PMO_TEAMS_TOPIC_ID],
  ['mote-neighbor', PMO_TEAMS_TOPIC_ID], ['custom-mote', customId], ['ordinary-worker', ordinaryId] ].map(([id, topicId]) => ({
  ...prototype, id, hostId: 'local', label: topicId ? 'Agent · Mote' : 'Agent · Project',
  workspacePath: topicId ? scratch.path + '/' + scratchTopicDirectoryName(topicId) : project.path,
  processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: Date.now() },
  semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'original-run-' + id } }
}))
const topic = (id, title) => {
  const directoryPath = scratch.path + '/' + scratchTopicDirectoryName(id)
  return { id, title, directoryPath, topicPath: directoryPath + '/topic.md', summary: '', collaborators: [],
    soul: { path: directoryPath + '/SOUL.md', content: '# Coordinate this original Topic', version: 'private-original-v1' } }
}
const ordinary = topic(ordinaryId, 'Ordinary Topic'); delete ordinary.soul
const topics = [topic(PMO_TEAMS_TOPIC_ID, 'Mote'), topic(customId, 'Review the next step with the original project team'), ordinary]
// These controlled public records exercise the original message owners. They
// are Renderer evidence, never a claim that a real Agent produced this text.
const timelines = { 'mote-primary': { agentSessionId: 'mote-primary', revision: 1, items: [
  { id: 'private-mote-reply', agentSessionId: 'mote-primary', kind: 'assistant_message', source: 'native-hook', status: 'complete',
    title: 'Original controlled reply', content: 'We can keep this discussion focused on the current goal. Your other discussion and its Session stay separate.', createdAt: 1000, updatedAt: 1000 },
  { id: 'private-unknown-reply', agentSessionId: 'mote-primary', authorAgentSessionId: 'unavailable-original-author', kind: 'assistant_message', source: 'native-hook', status: 'complete',
    title: 'Original unknown author', content: 'This record keeps its original author identity. An unavailable author is not presented as the current Mote.', createdAt: 2000, updatedAt: 2000 }
] } }
api.config.get = async () => { initializeCalls += 1; return structuredClone({ ...publicConfig, hosts: publicConfig.hosts.filter(host => host.id === 'local'), workspaces: [project, scratch] }) }
api.demands.list = async () => []
api.scratch.listTopics = async () => structuredClone(topics)
api.scratch.ensureMote = async (_workspace, id) => {
  calls.push({ operation: 'ensureMote', topicId: id })
  const found = topics.find(one => one.id === id)
  if (!found) throw new Error('Unknown private Mote')
  return structuredClone(found)
}
api.scratch.ensureTopic = async (_workspace, id) => structuredClone(topics.find(one => one.id === id) ?? null)
api.scratch.readTopic = async (_workspace, id) => structuredClone(topics.find(one => one.id === id) ?? null)
api.sessions.snapshot = async () => { return ({ sessions: structuredClone(sessions).map(one => phase === 'restore' &&
  ['mote-neighbor', 'project-worker'].includes(one.id) && !recovered.has(one.id) ? {
    ...one, processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: Date.now() },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() }
  } : one), timelines: structuredClone(timelines), recoveryCandidates: [] }) }
api.sessions.onEvent = () => () => {}
api.sessions.historySources = async () => sessions.map(session => ({ agentSessionId: session.id, hostId: session.hostId,
  state: 'active', history: { providerId: session.providerId, executorId: session.executorId, workspacePath: session.workspacePath, createdAt: session.createdAt } }))
api.sessions.historyPage = async control => {
  const session = sessions.find(one => one.id === control.agentSessionId)
  if (!session) throw new Error('Only original controlled Session history may read')
  return { agentSessionId: session.id, source: { providerId: session.providerId, nativeSessionId: 'private-history-' + session.id }, items: [], nextCursor: null }
}
api.sessions.observeHistory = async control => {
  const session = sessions.find(one => one.id === control.agentSessionId)
  if (!session) throw new Error('Only original controlled Session history may observe')
  return { source: { providerId: session.providerId, nativeSessionId: 'private-history-' + session.id }, dispose() {} }
}
const sessionFor = control => sessions.find(one => one.id === control.agentSessionId && one.control.run.runId === control.run.runId)
api.sessions.recover = async control => {
  const session = sessionFor(control)
  if (!session) throw new Error('Only the original private Session/Run may recover')
  calls.push({ operation: 'recover', sessionId: session.id, runId: control.run.runId })
  recovered.add(session.id)
  return { kind: 'reattachable', session }
}
api.sessions.attach = async control => {
  const session = sessionFor(control)
  if (!session) throw new Error('Only the original private Session/Run may attach')
  calls.push({ operation: 'attach', sessionId: session.id, runId: control.run.runId })
  const data = 'Original output · ' + session.id + '\r\nThe original work surface and draft remain.\r\n'
  const dataBytes = new TextEncoder().encode(data)
  return { attachmentId: 'original-attachment-' + session.id, session, currentSize: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: control.run.runId, startByte: 0, endByte: dataBytes.length, data, dataBytes }], gap: null }
}
api.sessions.refreshAttachment = async control => api.sessions.attach(control)
api.sessions.detach = async () => {}
api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (_attachment, cols, rows) => ({ cols, rows })
api.sessions.refresh = async control => sessionFor(control)
for (const operation of ['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt']) api.sessions[operation] = async () => {
  calls.push({ operation, denied: true }); throw new Error('This close/restart proof must never ' + operation)
}
const dataKey = 'agentmux.private-shared-frame-files.v1'
const storedFiles = JSON.parse(localStorage.getItem(dataKey) ?? 'null')
let noteReadFailure = false
const fileData = storedFiles ?? Object.fromEntries(topics.flatMap(one => {
  const root = scratchTopicDirectoryName(one.id)
  return [[root + '/topic.md', '# ' + one.title], ...(one.soul ? [[root + '/SOUL.md', one.soul.content]] : []),
    [root + '/next-step.md', '# A useful next step\n\nCapture a concrete thought, then continue the original discussion.'],
    [root + '/earlier-idea.md', '# An earlier recorded idea'], [root + '/undated-idea.md', '# An undated recorded idea']]
}))
const fileTimes = Object.fromEntries(topics.flatMap(one => {
  const root = scratchTopicDirectoryName(one.id)
  return [[root + '/next-step.md', _hygiene_fixtureTime(13474400000)], [root + '/earlier-idea.md', 0]]
}))
const saveFiles = () => localStorage.setItem(dataKey, JSON.stringify(fileData))
api.files.readDirectory = async (workspaceId, root) => {
  calls.push({ operation: 'readDirectory', workspaceId, root })
  if (workspaceId !== scratch.id) return []
  return Object.keys(fileData).filter(file => file.startsWith(root ? root + '/' : '')).map(file => {
    const tail = root ? file.slice(root.length + 1) : file, first = tail.split('/')[0]
    const path = (root ? root + '/' : '') + first, isDirectory = tail.includes('/')
    return { name: first, path, isDirectory, isSymlink: false,
      ...(!isDirectory && Object.hasOwn(fileTimes, path) ? { mtimeMs: fileTimes[path] } : {}) }
  }).filter((entry, index, all) => all.findIndex(other => other.path === entry.path) === index)
}
api.files.read = async (workspaceId, file) => {
  calls.push({ operation: 'readFile', workspaceId, path: file })
  if (workspaceId !== scratch.id || !Object.hasOwn(fileData, file)) throw new Error('Only original private Mote files may read: ' + file)
  if (noteReadFailure && file.endsWith('/next-step.md')) throw new Error('Original note is temporarily unavailable. Its file and discussion are kept.')
  return { status: 'read', document: { path: file, content: fileData[file], revision: 'original-file-' + fileData[file].length } }
}
api.files.observe = async () => {}; api.files.unobserve = async () => {}; api.files.onInvalidated = () => () => {}
api.files.create = async (workspaceId, input) => {
  if (workspaceId !== scratch.id || input.kind !== 'file' || Object.hasOwn(fileData, input.path)) throw new Error('Invalid private new-file request')
  calls.push({ operation: 'createFile', workspaceId, path: input.path }); fileData[input.path] = ''; saveFiles()
}
api.files.write = async () => { calls.push({ operation: 'fileWrite' }); throw new Error('Editor save is outside this frame proof') }
saveFiles()
function seedOriginalOnce() {
  seedApplied = true
  const projectTab = createWorkbenchTab('original-project-tab', { regionId: 'original-worker-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-worker' })
  projectTab.layout = splitWorkbenchRegion(projectTab.layout, 'original-worker-region', 'right', 'original-reader-region')
  projectTab.layout.root.ratio = 0.63
  projectTab.regions['original-reader-region'] = { regionId: 'original-reader-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-reader' }
  const agentTab = (id, regionId, sessionId, topicId, name) => ({ ...createWorkbenchTab(id, { regionId, workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId }, name), topicId })
  const primary = agentTab(targetId, 'mote-primary-region', 'mote-primary', PMO_TEAMS_TOPIC_ID, 'Review the current goal')
  const neighbor = agentTab(neighborId, 'mote-neighbor-region', 'mote-neighbor', PMO_TEAMS_TOPIC_ID, 'Continue the original plan')
  const custom = agentTab(customTabId, 'custom-mote-region', 'custom-mote', customId, 'Review the next step')
  const ordinaryTab = agentTab('ordinary-topic-tab', 'ordinary-topic-region', 'ordinary-worker', ordinaryId, 'An ordinary Topic task')
  const first = createWorkspaceLayout('original-mote-first', [targetId, neighborId, customTabId, ordinaryTab.id])
  const second = createWorkspaceLayout('original-mote-second', [targetId])
  useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: project.id, projectRailOpen: false, toolsOpen: false,
    spaceObjectIcons: { [topicSpaceIconTarget(scratch, topics.find(one => one.id === customId)).key]: { ...DEFAULT_MOTE_FACE } },
    tabs: Object.fromEntries([projectTab, primary, neighbor, custom, ordinaryTab].map(tab => [tab.id, tab])),
    layouts: { [project.id]: createWorkspaceLayout('original-project-group', [projectTab.id]),
      [scratch.id]: { root: { type: 'split', direction: 'horizontal', ratio: 0.54, first: first.root, second: second.root }, groups: [...first.groups, ...second.groups], activeGroupId: 'original-mote-second' } },
    agentFocus: { execution: { sessionId: 'project-worker', history: [{ sessionId: 'project-worker', focusedAt: 1000 }] }, pmo: { sessionId: 'mote-primary' } },
    viewModes: Object.fromEntries(sessions.map(session => [session.id, session.id !== 'project-reader' ? 'activity' : 'terminal'])) })
  for (const session of sessions) useAppStore.getState().setAgentComposerDraft(session.id, 'Original unsent draft · ' + session.id)
  requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: targetId })
  window.sharedFrameProof.setFloating({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: targetId, reference: { displayWorkspaceId: scratch.id, groupId: 'original-mote-second', tabId: targetId, regionId: 'mote-primary-region' } })
}
const facts = () => {
  const current = useAppStore.getState(), persisted = projectPersistedWorkbench(current)
  const tabs = Object.fromEntries(Object.entries(persisted.tabs).map(([id, tab]) => [id, { ...tab,
    regions: Object.fromEntries(Object.entries(tab.regions).map(([regionId, surface]) => {
      const { phase: _phase, ...durable } = surface; return [regionId, durable]
    })) }]))
  const panel = document.getElementById('pmo-teams-topic-floating-panel')
  return { tabs, layouts: persisted.layouts, focus: current.agentFocus, drafts: current.agentComposerDrafts,
    outbox: current.agentSteerQueues, viewModes: current.viewModes, activeWorkspaceId: current.activeWorkspaceId,
    mainSurface: current.mainSurface, selection: current.workbenchSpaceSelection, calls: [...calls],
    files: structuredClone(fileData), documents: current.documents,
    projectRailOpen: current.projectRailOpen, toolsOpen: current.toolsOpen, toolDockWidth: current.toolDockWidth,
    runs: current.sessions.map(session => session.control), floating: JSON.parse(localStorage.getItem(floatingKey) ?? 'null'), floatingState: readPmoTeamsTopicFloatingState(),
    ui: { target: panel?.dataset.moteTargetTab ?? null, topic: panel?.dataset.moteTargetTopic,
      visible: panel?.matches(':popover-open'), text: panel?.textContent,
      newTab: !!panel?.querySelector('[aria-label="New discussion"]') },
    initialization: { initializeCalls, seedApplied, initialDurable, initialSpatial, initialFloating, afterOrdinaryInitialize } }
}
let retainedLayout
const root = createRoot(document.getElementById('root'))
function ProofBridge() {
  const [, setFloating] = usePmoTeamsTopicFloatingState()
  window.sharedFrameProof.setFloating = setFloating
  return null
}
window.sharedFrameProof = { ready: false, facts, ids: { targetId, neighborId, customId, customTabId },
  persistence: () => ({ spatial: JSON.parse(localStorage.getItem(spatialKey) ?? 'null'), workbench: spatialState ? desktopWorkbenchFromSpatial(spatialState.graph) : null }),
  // Controlled config facts enter the original App appearance owner. The proof
  // never writes a DOM theme, stylesheet or product appearance implementation.
  setProfileAppearance: mode => {
    if (!['dark', 'light'].includes(mode)) throw new Error('Bounded Profile appearance requires dark or light')
    const state = useAppStore.getState()
    if (!state.config) throw new Error('Original configuration is not available')
    useAppStore.setState({ config: { ...state.config, appearance: { ...state.config.appearance, appAppearance: mode } } })
  },
  profileControlsFacts: () => ({ icons: structuredClone(useAppStore.getState().spaceObjectIcons), topics: structuredClone(topics) }),
  setProfileMoteStatus: status => {
    if (!['working', 'done'].includes(status)) throw new Error('Bounded Mote motion requires the original working or done public fact')
    const original = sessions.find(session => session.id === 'mote-primary')
    original.status = { ...original.status, state: status }
    original.semanticStatus = { ...original.semanticStatus, state: status }
    useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === original.id
      ? { ...session, status: { ...original.status }, semanticStatus: { ...original.semanticStatus } } : session) }))
  },
  setNoteReadFailure: value => { noteReadFailure = value === true },
  prepareSpace: () => useAppStore.setState({ mainSurface: 'workbench', projectRailOpen: true, toolsOpen: true }),
  prepareOriginalSurvey: () => {
    const state = useAppStore.getState(), reference = { displayWorkspaceId: project.id, groupId: 'original-project-group',
      tabId: 'original-project-tab', regionId: 'original-worker-region' }
    const locations = spatialCatalog(state, topics).locations.filter(location => Object.entries(reference).every(([name, value]) => location[name] === value))
    if (locations.length !== 1 || !locations[0].zoneId) throw new Error('Original project Agent must have one exact public catalog reference')
    state.setSurveyZoneSelection({ zoneId: locations[0].zoneId, selection: [reference], active: reference })
  },
  showGoals: () => useAppStore.getState().setMainSurface('board'),
  suspendOriginalPlacement: () => {
    const state = useAppStore.getState(); retainedLayout = state.layouts[scratch.id]
    useAppStore.setState({ layouts: { ...state.layouts, [scratch.id]: { ...retainedLayout,
      groups: retainedLayout.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => id !== targetId),
        activeTabId: group.activeTabId === targetId ? neighborId : group.activeTabId })) } } })
  },
  restoreOriginalPlacement: () => { const state = useAppStore.getState(); useAppStore.setState({ layouts: { ...state.layouts, [scratch.id]: retainedLayout } }) },
  showOriginalSpaceTree: () => useAppStore.setState({ mainSurface: 'workbench', projectRailOpen: true, toolsOpen: false,
    workbenchSpaceSelection: { spaceId: 'original-project-space', zoneId: 'original-project-zone', workspaceId: project.id,
      groupId: 'original-project-group', tabId: 'original-project-tab', regionId: 'original-worker-region' }, activeWorkspaceId: project.id }),
  showBadReference: () => window.sharedFrameProof.setFloating({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: targetId, reference: { displayWorkspaceId: scratch.id, groupId: 'saved-unconfirmed-group', tabId: targetId, regionId: 'mote-primary-region' } }),
  showAmbiguousReference: () => window.sharedFrameProof.setFloating({ reference: undefined }),
  selectOriginal: () => {
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: targetId })
    window.sharedFrameProof.setFloating({ reference: { displayWorkspaceId: scratch.id, groupId: 'original-mote-second', tabId: targetId, regionId: 'mote-primary-region' } })
  },
  dispose: () => { root.unmount(); window.sharedFrameProof.ready = false } }
window.sharedFrameSetup.phase = 'render-production-app'
root.render(createElement(Fragment, null, createElement(App), createElement(ProofBridge)))
// The real App invokes the unmodified ordinary initialize exactly once. The
// public port connection is established by the original owner after bootstrap.
await new Promise((resolve, reject) => {
  const deadline=Date.now()+10000
  const check=()=>{const state=useAppStore.getState();if(!state.loading && state.config && spatialListeners.size>0 && window.sharedFrameProof.setFloating)resolve();else if(Date.now()>deadline)reject(new Error('Original App spatial initialize did not connect'));else setTimeout(check,10)}
  check()
})
afterOrdinaryInitialize = { tabIds: Object.keys(useAppStore.getState().tabs), focus: structuredClone(useAppStore.getState().agentFocus), spatialRead: initialSpatial?.revision ?? 0, calls: structuredClone(calls) }
if (phase === 'seed') seedOriginalOnce()
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
window.sharedFrameProof.ready = true
