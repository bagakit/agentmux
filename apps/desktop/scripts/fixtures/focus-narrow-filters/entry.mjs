import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

// Existing typed web-preview transport only; these presentation facts do not claim real Runs.
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base?.control.run.runId || !config.workspaces[0]) throw new Error('Nonempty existing typed preview inputs required')
const { repoPath: _repoPath, ...workspaceBase } = config.workspaces[0]
const { pendingInteraction: _pendingInteraction, ...agentBase } = base
const alpha = { ...workspaceBase, id: 'alpha', path: '/private/alpha', name: '长中文项目：连续输入与性能研究，保留完整名称' }
const beta = { ...alpha, id: 'beta', path: '/private/beta', name: 'Beta · second independent project' }
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: id === alpha.id ? alpha.path : beta.path })
api.scratch.listTopics = async () => []
const states = ['working', 'error', 'done', 'running', 'disconnected', 'disconnected']
const now = Date.now()
const sessions = states.map((state, i) => ({ ...agentBase, id: ['working','attention','results','idle','offline','healthy-lost'][i],
  label: ['Repair parser','Review permission','Reviewed change','Idle context','Archived context','Healthy observation lost'][i],
  workspacePath: alpha.path, processState: i === 4 ? 'interrupted' : 'running',
  status: { state, source: 'native-hook', observedAt: now }, control: { ...base.control, agentSessionId: ['working','attention','results','idle','offline','healthy-lost'][i], run: { runId: `typed-filter-${i}` } } }))
sessions.push({ ...sessions[0], id: 'beta-agent', workspacePath: beta.path, label: 'Beta parser' })
const tab = createWorkbenchTab('original', { regionId: 'original-region', workspaceId: alpha.id, kind: 'agent', phase: 'attached', sessionId: 'working' }, 'Original work')
window.presentationLeaves = { mounts: [], unmounts: [] }
const calls = { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 }
for (const key of Object.keys(calls)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { calls[key]++; return original(...args) } }
const reads = { historyPage: 0, timeline: 0, historySources: 0, topics: 0, appearance: 0 }
for (const key of ['historyPage','timeline','historySources']) { const original = api.sessions[key]; api.sessions[key] = (...args) => { reads[key]++; return original(...args) } }
for (const [port,key,counter] of [[api.scratch,'listTopics','topics'],[api.workspaces,'appearance','appearance']]) { const original = port[key]; port[key] = (...args) => { reads[counter]++; return original(...args) } }
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [alpha,beta] }, sessions,
  activeWorkspaceId: alpha.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
  tabs: { original: tab }, layouts: { alpha: createWorkspaceLayout('original-group', [tab.id]), beta: createWorkspaceLayout('beta-group') },
  timelines: { results: { agentSessionId: 'results', revision: 1, items: [{ id: 'answer', agentSessionId: 'results', kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Answer', content: 'Reviewed and complete', createdAt: now, updatedAt: now }] } },
  agentNames: Object.fromEntries(sessions.map(session => [session.id,session.label])),
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { working: 'Original unsent draft' } })
createRoot(document.getElementById('root')).render(createElement(App))
let primary, originalDraft, originalSearch, originalTrigger
window.filterProof = {
  ready: true, longProject: alpha.name,
  enter() {
    useAppStore.getState().focusRegion(alpha.id, tab.id, 'original-region', 'pointer', 'original-group')
    primary = useAppStore.getState()
    originalDraft = document.querySelector('[data-owner-tab="original"][data-owner-region="original-region"] textarea')
    if (!originalDraft) throw new Error('Original mounted work surface required before Focus')
    originalDraft.setSelectionRange(7,15)
  },
  remember() { originalSearch = document.querySelector('[aria-label="Search contexts"]'); originalTrigger = document.querySelector('[aria-label="Focus filters"]'); if (!originalSearch || !originalTrigger) throw new Error('Persistent filter input/trigger required') },
  irrelevantOutputs() { for(let i=0;i<20;i++) useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='beta-agent'?{...session,latestOutputBytes:session.latestOutputBytes+1,status:{...session.status,observedAt:now+i+1}}:session)})) },
  facts() { const state=useAppStore.getState();return {
    sameSearch: document.querySelector('[aria-label="Search contexts"]')===originalSearch,
    sameTrigger: document.querySelector('[aria-label="Focus filters"]')===originalTrigger,
    sameDraft: document.querySelector('[data-owner-tab="original"][data-owner-region="original-region"] textarea')===originalDraft,
    draft: originalDraft?.value, range: [originalDraft?.selectionStart,originalDraft?.selectionEnd],
    sameTabs: state.tabs===primary?.tabs, sameLayouts: state.layouts===primary?.layouts, sameDrafts: state.agentComposerDrafts===primary?.agentComposerDrafts,
    sameFocus: state.agentFocus===primary?.agentFocus, runs: state.sessions.map(session=>session.control.run.runId),
    mounts: [...window.presentationLeaves.mounts], unmounts: [...window.presentationLeaves.unmounts], calls: {...calls}, reads: {...reads}
  } }
}
