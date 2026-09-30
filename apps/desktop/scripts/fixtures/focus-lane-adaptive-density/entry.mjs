import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import '../../../src/renderer/src/styles/index.css'

// The maintained preview transport provides typed presentation facts, not real Runs.
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base?.control.run.runId || !config.workspaces[0]) throw new Error('Nonempty original preview inputs required')
const { repoPath: _repoPath, ...workspaceBase } = config.workspaces[0]
const { pendingInteraction: _pendingInteraction, ...agentBase } = base
const alpha = { ...workspaceBase, id: 'alpha', path: '/private/alpha', name: '长中文项目：连续输入与性能研究，保留完整名称' }
const scratch = { ...alpha, id: SCRATCH_WORKSPACE_ID, path: '/private/topics', name: 'Scratch' }
const topics = ['first', 'second'].map((id, i) => ({ id: 'launcher:' + id, title: ['Scrolling investigation', 'Another precise Topic'][i], summary: ['Review original input and timeline flow', 'Independent Context, same project'][i], directoryPath: scratch.path + '/topic--launcher--' + id, topicPath: scratch.path + '/topic--launcher--' + id + '/topic.md', collaborators: [] }))
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: id === alpha.id ? alpha.path : scratch.path })
api.scratch.listTopics = async () => topics
const now = Date.now()
function agent(id, state, path = alpha.path) { return { ...agentBase, id, label: id === 'original' ? 'Original investigation' : 'Offline context ' + id, workspacePath: path, processState: state === 'disconnected' ? 'interrupted' : 'running', status: { ...agentBase.status, state, source: 'native-hook', observedAt: now }, control: { ...base.control, agentSessionId: id, run: { runId: 'typed-lane-' + id } } } }
const original = agent('original', 'working')
const tab = createWorkbenchTab('original', { regionId: 'original-region', workspaceId: alpha.id, kind: 'agent', phase: 'attached', sessionId: original.id }, 'Original work')
window.presentationLeaves = { mounts: [], unmounts: [] }
const calls = { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 }
for (const key of Object.keys(calls)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { calls[key]++; return original(...args) } }
const reads = { historyPage: 0, timeline: 0, historySources: 0, topics: 0, appearance: 0 }
for (const key of ['historyPage', 'timeline', 'historySources']) { const original = api.sessions[key]; api.sessions[key] = (...args) => { reads[key]++; return original(...args) } }
for (const [port, key, counter] of [[api.scratch, 'listTopics', 'topics'], [api.workspaces, 'appearance', 'appearance']]) { const original = port[key]; port[key] = (...args) => { reads[counter]++; return original(...args) } }
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [alpha, scratch] }, sessions: [original],
  activeWorkspaceId: alpha.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
  tabs: { original: tab }, layouts: { alpha: createWorkspaceLayout('original-group', [tab.id]), [scratch.id]: createWorkspaceLayout('topics-group') }, timelines: {},
  agentNames: { original: 'Original investigation' }, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 0, topics, error: null, reading: false } },
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { original: 'Original unsent draft' } })
createRoot(document.getElementById('root')).render(createElement(App))
let retained, originalDraft, originalSearch
window.laneProof = {
  ready: true,
  scratchProjectId: scratch.id,
  enter() {
    useAppStore.getState().focusRegion(alpha.id, tab.id, 'original-region', 'pointer', 'original-group')
    originalDraft = document.querySelector('[data-owner-tab="original"][data-owner-region="original-region"] textarea')
    if (!originalDraft) throw new Error('Original mounted content host required')
    originalDraft.setSelectionRange(7, 15)
  },
  remember() { retained = useAppStore.getState(); originalSearch = document.querySelector('[aria-label="Search contexts"]'); if (!originalSearch) throw new Error('Actual persistent search required') },
  mode(kind) {
    let sessions, timelines = {}
    if (kind === 'results') {
      sessions = [agent('original', 'done')]
      timelines = { original: { agentSessionId: 'original', revision: 1, items: [{ id: 'answer', agentSessionId: 'original', kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Answer', content: 'Reviewed input and timeline behavior; original work retained.', createdAt: now, updatedAt: now }] } }
    } else if (kind === 'offline') sessions = [agent('original', 'running'), ...Array.from({ length: 5 }, (_, i) => agent('archived-' + i, 'disconnected'))]
    else if (kind === 'topics') sessions = [agent('original', 'running'), ...topics.flatMap((topic, i) => [agent('topic-live-' + i, 'working', topic.directoryPath), agent('topic-off-' + i, 'disconnected', topic.directoryPath)])]
    else throw new Error('Explicit scene required')
    useAppStore.setState({ sessions, timelines, agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])) })
  },
  facts() { const state = useAppStore.getState(); return {
    sameSearch: document.querySelector('[aria-label="Search contexts"]') === originalSearch,
    sameDraft: document.querySelector('[data-owner-tab="original"][data-owner-region="original-region"] textarea') === originalDraft,
    draft: originalDraft?.value, range: [originalDraft?.selectionStart, originalDraft?.selectionEnd],
    sameTabs: state.tabs === retained?.tabs, sameLayouts: state.layouts === retained?.layouts, sameDrafts: state.agentComposerDrafts === retained?.agentComposerDrafts,
    sameFocus: state.agentFocus === retained?.agentFocus, originalRun: state.sessions.find(session => session.id === 'original')?.control.run.runId,
    mounts: [...window.presentationLeaves.mounts], unmounts: [...window.presentationLeaves.unmounts], calls: { ...calls }, reads: { ...reads }
  } }
}
