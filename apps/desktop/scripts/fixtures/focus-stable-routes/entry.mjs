import { fixturePath } from '../../lib/fixture-values.mjs'
import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { ExecutorIdentityContext } from '../../../src/renderer/src/components/AgentAvatar'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { applyConfigEdit } from '../../../src/shared/config-edit'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

// Original Renderer and typed preview source; no real Run, Provider, input or disk write.
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base) throw new Error('Original typed preview Agent required')
const now = Date.now(), day = 86400000
const projects = [
  ['product', 'AgentMux', '本地 Agent 工作台'],
  ['library', 'Core runtime', '公共能力与恢复合同'],
  ['research', 'Research notes', '近期调研与阅读'],
  ['old', 'Earlier experiments', '很久以前的实验'],
  ['unknown', 'Remote workspace', '原来源暂不可用']
].map(([id, name]) => ({ id, name, path: fixturePath('private/focus-routes/' + id), hostId: 'local', kind: 'folder' }))
const actor = (id, projectIndex, name, state, age) => {
  const { pendingInteraction: _pending, currentActivity: _activity, ...agent } = base
  const at = age === null ? undefined : now - age
  const status = { state, source: 'native-hook', observedAt: now, detail: state === 'disconnected' ? 'Original source is unavailable; Session and workface are kept.' : 'Original typed activity observation' }
  return { ...agent, id, label: name, hostId: 'local', workspacePath: projects[projectIndex].path,
    processState: state === 'disconnected' ? 'interrupted' : 'running', status,
    semanticStatus: { ...status, ...(at === undefined ? {} : { stateEnteredAt: at }) },
    control: { ...agent.control, hostId: 'local', agentSessionId: 'canonical-' + id, run: { runId: 'private-run-' + id } } }
}
const sessions = [
  actor('working', 0, '稳定 Focus 的项目寻找路线', 'working', 12000),
  actor('sibling', 0, '核对公共设置与原工作面', 'done', 3 * 3600000),
  actor('library-idle', 1, '整理 Session 恢复的公共合同', 'done', 2 * day),
  actor('research-idle', 2, '阅读原始调研材料并保留来源', 'done', 8 * 3600000),
  actor('old-a', 3, '早期布局实验 · 保留原会话', 'done', 14 * day),
  actor('old-b', 3, '另一份长期未关注的实验', 'done', 12 * day),
  actor('unknown-source', 4, '连接待确认 · 原任务仍然保留', 'disconnected', null)
]
const key = id => JSON.stringify(['local', id])
const candidate = { ...config, workspaces: projects, focus: { recentActivityHours: 48, replyLines: 2,
  projects: [
    { key: key('product'), pinned: true, note: '日常主线', color: 'blue', collapsed: null },
    { key: key('library'), pinned: true, note: '长期基础能力', color: 'violet', collapsed: null }
  ] } }
mountThemeRuntime(window, candidate.appearance ?? {})
api.scratch.listTopics = async () => []
api.workspaces.listBranches = async id => ({ kind: 'not-git-repository', workspaceId: id, branches: [] })
const calls = { stop: 0, resume: 0, write: 0, launchAgent: 0, interrupt: 0 }, saves = []
for (const name of Object.keys(calls)) api.sessions[name] = async () => { calls[name]++; throw new Error('No Agent control is authorized in a presentation scene') }
let failSave = false
api.config.save = async (next, expected) => {
  saves.push({ projects: next.focus?.projects, baseline: expected?.focus?.projects, failed: failSave })
  if (failSave) throw new Error('Private settings save failed. Original settings and draft are retained.')
  return applyConfigEdit(useAppStore.getState().config, expected, next)
}
const tabs = Object.fromEntries(sessions.map(session=>{const project=projects.find(project=>project.path===session.workspacePath),tab=createWorkbenchTab('route-tab-'+session.id,{kind:'agent',phase:'attached',regionId:'route-region-'+session.id,workspaceId:project.id,sessionId:session.id});return[tab.id,tab]}))
useAppStore.setState({ loading: false, config: candidate, sessions, timelines: {}, agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])),
  tabs, layouts: Object.fromEntries(projects.map((project, i) => [project.id, createWorkspaceLayout('route-group-' + i, Object.values(tabs).filter(tab=>tab.workspaceId===project.id).map(tab=>tab.id))])),
  activeWorkspaceId: projects[0].id, mainSurface: 'agents', spaceZoneBindings: {}, topicCategories: [],
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
  agentComposerDrafts: { working: '原 Agent 的未提交草稿', sibling: '另一份未提交草稿' }, error: null, lastError: null, errorDismissed: false })
const arranged=useAppStore.getState(), originalSpatial=await api.spatial.read()
await api.spatial.commit({expectedRevision:originalSpatial?.revision??0,graph:desktopSpatialGraph(arranged,[])})
api.config.get=async()=>candidate
api.sessions.snapshot=async()=>({...snapshot,sessions,timelines:{},recoveryCandidates:[]})
const dispose=await useAppStore.getState().initialize();dispose();useAppStore.setState(arranged,true)
const original = useAppStore.getState(), selections = []
let setVisible
function Scene() {
  const [visible, set] = useState(true); setVisible = set
  return h('main', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)' } },
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, h(GlobalFocusSurface, { visible, workspaceOpen: false, onSelectContext: id => selections.push(id) })))
}
createRoot(document.getElementById('root')).render(h(ExecutorIdentityContext.Provider, { value: { config: candidate } }, h(DesktopClientUiProvider, {}, h(Scene))))
window.routesProof = {
  ready: true, projects: projects.map(project => ({ id: project.id, name: project.name, key: key(project.id) })),
  theme(value) { const result = updateThemeSelection({ ...candidate.appearance, appAppearance: value }); if (!result.applied) throw new Error(result.reason) },
  visible(value) { setVisible(value) },
  failSave(value) { failSave = value },
  externalProject(id, patch) { useAppStore.setState(state=>({config:{...state.config,focus:{...state.config.focus,projects:state.config.focus.projects.map(item=>item.key===key(id)?{...item,...patch}:item)}}})) },
  idle(id, age=14*day) { useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id===id?{...session,status:{...session.status,state:'done',observedAt:Date.now()},semanticStatus:{state:'done',source:'native-hook',observedAt:Date.now(),stateEnteredAt:Date.now()-age}}:session)})) },
  reveal(id) { const session=sessions.find(session=>session.id===id);if(!session)throw Error('Original fixture target missing');useAppStore.getState().revealFocusAgent({hostId:session.control.hostId,agentSessionId:session.control.agentSessionId},session.id) },
  activity(id) { useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session,
    status: { ...session.status, state: 'working', observedAt: Date.now() }, semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() } } : session) })) },
  facts() { const state = useAppStore.getState(); return { calls, saves, selections, projects: state.config.focus.projects,
    sameTabs: state.tabs === original.tabs, sameLayouts: state.layouts === original.layouts,
    focusedSessionId:state.agentFocus.execution.sessionId,sameDrafts: state.agentComposerDrafts === original.agentComposerDrafts, sameFocus: state.agentFocus === original.agentFocus,
    controls: state.sessions.map(session => session.control), originalControls: sessions.map(session => session.control),
    rows: [...document.querySelectorAll('.focus-project-lanes__row[data-project-key]')].map(row => ({ key: row.dataset.projectKey, lane: row.dataset.laneId,
      pinned: row.dataset.pinned, color: row.dataset.focusProjectColor, collapsed: row.dataset.collapsed, text: row.textContent })) } }
}
