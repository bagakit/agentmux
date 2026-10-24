import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes, focusProjectKey } from '../../../src/renderer/src/lib/focus-project-lanes'
import { focusLaneOrigins } from '../../../src/renderer/src/lib/focus-lane-origin'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { readSurveyPresentation } from '../../../src/renderer/src/lib/mobile-presentation'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { readPmoTeamsTopicFloatingState } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../../../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/contracts'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

// Use the maintained typed preview API. These are Renderer input facts, not real Runs.
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base?.control.run.runId || !config.workspaces[0]) throw new Error('Nonempty typed preview inputs required')
const alpha = { id: 'alpha', hostId: 'local', kind: 'folder', path: fixturePath('focus-composable/alpha'), name: 'AgentMux · 连续阅读与多 Agent 协作基础设施 — 保留完整的长项目名称' }
const beta = { ...alpha, id: 'beta', path: fixturePath('focus-composable/beta'), name: 'Design Systems · independent project' }
const scratch = { ...alpha, id: SCRATCH_WORKSPACE_ID, path: fixturePath('focus-composable/scratch'), name: 'Scratch' }
const topic = { id: 'launcher:filter-topic', title: 'Composing readable filters', kind: 'topic', summary: 'Combine source, project and state without losing the original work surface.',
  directoryPath: scratch.path + '/topic--launcher--filter-topic', topicPath: scratch.path + '/topic--launcher--filter-topic/topic.md', collaborators: [] }
const mote = { ...topic, id: 'launcher:filter-mote', title: 'Research Mote · coordination', kind: 'mote', directoryPath: scratch.path + '/topic--launcher--filter-mote',
  topicPath: scratch.path + '/topic--launcher--filter-mote/topic.md', soul: { path: scratch.path + '/topic--launcher--filter-mote/SOUL.md', content: '# Research coordinator', version: 'fixture-v1' } }
const writer = { ...mote, id: 'launcher:filter-writer', title: 'Writing Mote · coordination', directoryPath: scratch.path + '/topic--launcher--filter-writer',
  topicPath: scratch.path + '/topic--launcher--filter-writer/topic.md', soul: { ...mote.soul, path: scratch.path + '/topic--launcher--filter-writer/SOUL.md' } }
const topics = [topic, mote, writer].map(item => ({ ...item, identityDirectoryPath: item.directoryPath })), now = Date.now()
function agent(id, workspacePath, state = 'working', processState = 'running') {
  return { ...base, id, label: id, workspacePath, processState, status: { state, source: 'native-hook', observedAt: now },
    control: { ...base.control, agentSessionId: id, run: { runId: 'composable-original-' + id } } }
}
const sessions = [agent('alpha-working', alpha.path), agent('alpha-survey', alpha.path), agent('alpha-attention', alpha.path, 'error'),
  agent('alpha-results', alpha.path, 'done'), agent('beta-working', beta.path), agent('topic-working', topic.directoryPath),
  agent('unknown-source', scratch.path + '/topic--launcher--unread', 'running'), agent('mote-coordinator', mote.directoryPath, 'waiting'), agent('mote-writer', writer.directoryPath)]
const names = { 'alpha-working': 'Maintain the original workspace', 'alpha-survey': 'Survey protocol boundaries', 'alpha-attention': 'Review a pending change',
  'alpha-results': 'Readable filtering complete', 'beta-working': 'Independent design work', 'topic-working': 'Topic research', 'unknown-source': 'Source awaiting confirmation', 'mote-coordinator': 'Research coordinator', 'mote-writer': 'Mote writer' }
const alphaSpace = directoryIdentity(alpha.hostId, alpha.path), alphaZone = workspaceZoneId(alphaSpace, alpha.id), surveyZone = 'focus-composable-survey-alpha'
const topicSpace = directoryIdentity(scratch.hostId, topic.directoryPath), topicZone = homeZoneId(topicSpace)
const original = createWorkbenchTab('original', { regionId: 'original-region', workspaceId: alpha.id, kind: 'agent', phase: 'attached', sessionId: 'alpha-working' }, 'Original draft and selection')
original.space = { spaceId: alphaSpace, zoneId: alphaZone }
const surveyed = createWorkbenchTab('survey-tab', { regionId: 'survey-region', workspaceId: alpha.id, kind: 'agent', phase: 'attached', sessionId: 'alpha-survey' }, 'Survey projection')
surveyed.space = { spaceId: alphaSpace, zoneId: surveyZone }
const topicTab = createWorkbenchTab('topic-tab', { regionId: 'topic-region', workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId: 'topic-working' }, topic.title)
topicTab.topicId = topic.id; topicTab.space = { spaceId: topicSpace, zoneId: topicZone }
const moteSpace = directoryIdentity(scratch.hostId, mote.directoryPath), moteZone = homeZoneId(moteSpace)
const moteTab = createWorkbenchTab('mote-tab', { regionId: 'mote-target-region', workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId: 'mote-coordinator' }, 'Original research Mote')
moteTab.topicId = mote.id; moteTab.space = { spaceId: moteSpace, zoneId: moteZone }
// The original target is deliberately inactive. A real Launcher neighbor avoids
// introducing another Agent into the surveyed Mote's authoritative membership.
const inactiveMoteTab = addWorkbenchRegion(moteTab, 'mote-target-region', 'right', { regionId: 'mote-active-neighbor', workspaceId: scratch.id, kind: 'launcher' })
const writerTab = createWorkbenchTab('writer-tab', { regionId: 'writer-region', workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId: 'mote-writer' }, 'Original writing Mote')
writerTab.topicId = writer.id
const writerDuplicate = createWorkbenchTab('writer-second-location', { regionId: 'writer-second-region', workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId: 'mote-writer' }, 'Second original writing Mote location')
writerDuplicate.topicId = writer.id
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: [alpha, beta, scratch].find(item => item.id === id)?.path ?? alpha.path })
api.scratch.listTopics = async () => topics
window.presentationLeaves = { mounts: [], unmounts: [] }
const inputEvents = []
for (const type of ['keydown', 'keypress', 'click']) document.addEventListener(type, event => {
  const target = event.target instanceof Element ? event.target.closest('button') : null
  if (!target || !target.closest('.focus-coordination-results, [aria-label="Choose original Mote location"]')) return
  inputEvents.push({ type, key: event.key ?? null, code: event.code ?? null, trusted: event.isTrusted, detail: event.detail,
    sessionId: target.getAttribute('data-session-id'), text: target.textContent, scope: target.closest('.focus-coordination-results') ? 'coordination' : 'locations' })
}, true)
const appearanceCalls = []
const calls = { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 }
for (const key of Object.keys(calls)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { calls[key]++; return original(...args) } }
const reads = { historyPage: 0, timeline: 0, historySources: 0, topics: 0, appearance: 0, branches: 0 }
for (const key of ['historyPage', 'timeline', 'historySources']) { const original = api.sessions[key]; api.sessions[key] = (...args) => { reads[key]++; return original(...args) } }
for (const [port, key, counter] of [[api.scratch, 'listTopics', 'topics'], [api.workspaces, 'appearance', 'appearance'], [api.workspaces, 'listBranches', 'branches']]) {
  const original = port[key]; port[key] = (...args) => {
    reads[counter]++
    if (counter === 'appearance') appearanceCalls.push({ sequence: appearanceCalls.length + 1, workspaceId: args[0], entry: 'api.workspaces.appearance', originalCaller: 'apps/desktop/src/renderer/src/components/ProjectIcon.tsx#useEffect([workspaceId])', consumerTiming: 'Not instrumented; original owner source and explicit filtering identify the request path, exact mount timing is unmeasured.' })
    return original(...args)
  }
}
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [alpha, beta, scratch], appearance: { ...config.appearance, appAppearance: 'dark' } }, sessions,
  activeWorkspaceId: alpha.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false, tabs: { original, 'survey-tab': surveyed, 'topic-tab': topicTab, 'mote-tab': inactiveMoteTab, 'writer-tab': writerTab },
  layouts: { alpha: createWorkspaceLayout('original-group', [original.id, surveyed.id]), beta: createWorkspaceLayout('beta-group'), [scratch.id]: createWorkspaceLayout('scratch-group', [topicTab.id, moteTab.id, writerTab.id]) },
  scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics, error: null, reading: false } },
  spaceZoneBindings: { [surveyZone]: { spaceId: alphaSpace, workspaceId: alpha.id }, [topicZone]: { spaceId: topicSpace, workspaceId: scratch.id, topicId: topic.id, contentKind: 'topic', directoryPath: topic.directoryPath },
    [moteZone]: { spaceId: moteSpace, workspaceId: scratch.id, topicId: mote.id, contentKind: 'mote', directoryPath: mote.directoryPath } },
  surveyCollectedZones: { [surveyZone]: true, [topicZone]: true, [moteZone]: true }, surveyOrganization: { ungrouped: [surveyZone, topicZone, moteZone], groups: [] }, surveyExplorationNames: { [surveyZone]: 'Protocol survey', [topicZone]: 'Research survey', [moteZone]: 'Coordination survey' },
  timelines: { 'alpha-results': { agentSessionId: 'alpha-results', revision: 1, items: [{ id: 'answer', agentSessionId: 'alpha-results', kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Answer', content: 'Filters are ready to review.', createdAt: now, updatedAt: now }] } },
  agentNames: names, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { 'alpha-working': 'Original unsent draft — keep this range' } })
createRoot(document.getElementById('root')).render(createElement(App))
let primary, draft, search, trigger, variantBefore
const projection = createFocusProjectionSelector()
window.filterProof = {
  ready: true, longProject: alpha.name, alphaKey: focusProjectKey('local', alpha.id), betaKey: focusProjectKey('local', beta.id), scratchKey: focusProjectKey('local', scratch.id),
  inputEvents() { return inputEvents.map(event => ({ ...event })) },
  enter() { useAppStore.getState().focusRegion(alpha.id, original.id, 'original-region', 'pointer', 'original-group'); primary = useAppStore.getState(); draft = document.querySelector('[data-owner-tab="original"][data-owner-region="original-region"] textarea'); if (!draft) throw new Error('Original mounted workface required'); draft.setSelectionRange(7, 15) },
  remember() { search = document.querySelector('[aria-label="Search contexts"]'); trigger = document.querySelector('[aria-label="Focus filters"]'); if (!search || !trigger) throw new Error('Actual Focus controls required') },
  theme(mode) { useAppStore.setState(state => ({ config: { ...state.config, appearance: { ...state.config.appearance, appAppearance: mode } } })) },
  sources() { const state = useAppStore.getState(), projected = projection(state, true, 'metadata', true), lanes = deriveFocusProjectLanes([...projected.laneContexts, ...projected.coordinationContexts], state.config, undefined, state.tabs, now, state.scratchTopicSnapshots), catalog = workbenchSelectionCatalog(state), origins = focusLaneOrigins(lanes, catalog, state.tabs, readSurveyPresentation(state, catalog).items, { bindings: state.spaceZoneBindings, categories: state.topicCategories }); return { contexts: projected.contexts.map(row => ({ id: row.id, bucket: row.bucket, lane: row.lane })), coordination: projected.coordinationContexts.map(row => ({ id: row.id, bucket: row.bucket, recap: row.recap })), pmoAttention: projected.pmoAttention, memberships: Object.fromEntries(lanes.flatMap(lane => [...(origins.get(lane.id)?.contextTypes ?? [])])) } },
  positions(mode) {
    if (!variantBefore) variantBefore = useAppStore.getState()
    const tabs = { ...variantBefore.tabs }, tabIds = [topicTab.id, moteTab.id]
    if (mode !== 'none') { tabs[writerTab.id] = writerTab; tabIds.push(writerTab.id) } else delete tabs[writerTab.id]
    if (mode === 'multiple') { tabs[writerDuplicate.id] = writerDuplicate; tabIds.push(writerDuplicate.id) }
    useAppStore.setState({ tabs, layouts: { ...variantBefore.layouts, [scratch.id]: createWorkspaceLayout('scratch-group', tabIds) } })
  },
  grow() {
    if (!variantBefore) variantBefore = useAppStore.getState()
    const extra = Array.from({ length: 16 }, (_, index) => agent('mote-growth-' + String(index + 1).padStart(2, '0'), writer.directoryPath))
    useAppStore.setState(state => ({ sessions: [...state.sessions, ...extra], agentNames: { ...state.agentNames, ...Object.fromEntries(extra.map((session, index) => [session.id, 'Coordination result ' + String(index + 1).padStart(2, '0')])) } }))
    return extra.map(session => session.id)
  },
  restoreVariants() { if (variantBefore) { const { sessions, agentNames, tabs, layouts } = variantBefore; useAppStore.setState({ sessions, agentNames, tabs, layouts }); variantBefore = undefined } },
  irrelevantOutputs() { for (let i = 0; i < 20; i++) useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'beta-working' ? { ...session, latestOutputBytes: session.latestOutputBytes + 1, status: { ...session.status, observedAt: now + i + 1 } } : session) })) },
  facts() { const state = useAppStore.getState(); return { sameSearch: document.querySelector('[aria-label="Search contexts"]') === search, sameTrigger: document.querySelector('[aria-label="Focus filters"]') === trigger,
    sameDraft: document.querySelector('[data-owner-tab="original"][data-owner-region="original-region"] textarea') === draft, draft: draft?.value, range: [draft?.selectionStart, draft?.selectionEnd],
    sameTabs: state.tabs === primary?.tabs, sameLayouts: state.layouts === primary?.layouts, sameDrafts: state.agentComposerDrafts === primary?.agentComposerDrafts, sameFocus: state.agentFocus === primary?.agentFocus,
    sameExecutionFocus: state.agentFocus.execution === primary?.agentFocus.execution, execution: state.agentFocus.execution, pmo: state.agentFocus.pmo,
    moteOriginalActiveRegion: state.tabs['mote-tab']?.layout.activeRegionId, floating: readPmoTeamsTopicFloatingState(),
    sameRunObjects: state.sessions.every(session => session.control.run === primary.sessions.find(item => item.id === session.id)?.control.run), runs: state.sessions.map(session => session.control.run.runId),
    mounts: [...window.presentationLeaves.mounts], unmounts: [...window.presentationLeaves.unmounts], calls: { ...calls }, reads: { ...reads }, appearanceCalls: [...appearanceCalls] } }
}
