import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { FocusNavigationButton } from '../../../src/renderer/src/components/FocusNavigationButton'
import { FocusNavigationPreview } from '../../../src/renderer/src/components/FocusNavigationPreview'
import { FocusWorkbenchFixture, absoluteFocusFixtureInputs } from '../../../test/fixtures/focus-workbench'
import { useAppStore, restorePersistedUiState } from '../../../src/renderer/src/store'
import { restoreAgentFocus } from '../../../src/renderer/src/lib/agent-focus'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

// Reuse the public web-preview transport and ordinary Workbench restore owner.
// These typed Sessions are presentation inputs, never evidence of live Core Runs.
const snapshot = await api.sessions.snapshot()
const inputs = absoluteFocusFixtureInputs(await api.config.get(), snapshot.sessions)
const config = inputs.config
snapshot.sessions = inputs.sessions
const base = snapshot.sessions.find(session => session.id === 'session-codex')
const workspaceId = 'workspace-demo'
const project = { id: workspaceId, name: '产品研究与终端连续阅读体验', path: base.workspacePath, hostId: base.hostId, kind: 'folder' }
const scratch = { id: '__scratch__', name: 'Scratch should not be in Topic heading', path: '/fixture/scratch', hostId: 'local', kind: 'folder' }
const topic = { id: 'launcher:lane', title: '滚动体验与消息流转', directoryPath: '/fixture/scratch/topic--launcher--lane', topicPath: '/fixture/scratch/topic--launcher--lane/topic.md', summary: '修复连续阅读，保持原有工作面', collaborators: [] }
const mote = { ...topic, id: 'launcher:research', title: '产品研究 Mote', directoryPath: '/fixture/scratch/topic--launcher--research', topicPath: '/fixture/scratch/topic--launcher--research/topic.md', soul: { path: '/fixture/scratch/topic--launcher--research/SOUL.md', content: '# Research', version: 'v1' } }
config.workspaces = [project, scratch]
api.scratch.listTopics = async () => [topic, mote]
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: id === workspaceId ? project.path : scratch.path })
api.workspaces.appearance = async () => ({ kind: 'repository', icon: null })
const session = (id, state, processState = 'running', workspacePath = project.path) => ({ ...base, id, workspacePath, processState, status: { ...base.status, state }, control: { ...base.control, agentSessionId: id, run: { ...base.control.run, runId: id === base.id ? base.control.run.runId : 'typed-'+id } } })
const terminal=(id,state='running',processState='running')=>({id,kind:'terminal',providerId:null,hostId:'local',workspacePath:project.path,label:'普通终端',createdAt:1,updatedAt:1,processState,status:{state,source:'run-process',observedAt:1},latestOutputBytes:0,control:{kind:'terminal',hostId:'local',runId:id,run:{runId:id}}})
const sessions = [terminal('ordinary'),terminal('failed-shell','error','exited'),terminal('offline-shell','disconnected','interrupted'),
  session(base.id, 'working'),
  { ...session('attention', 'waiting'), pendingInteraction: { id: 'permission', kind: 'permission', title: '是否允许编辑连续阅读逻辑？', operation: 'edit' } },
  session('results', 'done'), session('idle', 'running'), session('offline', 'disconnected', 'interrupted'),
  session('healthy-lost','disconnected','running'), session('mote', 'waiting', 'running', mote.directoryPath)
]
const tab = createWorkbenchTab('fixture-tab', { regionId: 'fixture-region', workspaceId, kind: 'terminal', phase: 'attached', sessionId: 'ordinary' })
const now = Date.now()
const resultMessage = { id: 'response', agentSessionId: 'results', kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: now, updatedAt: now, title: 'Response', content: '已完成验证，保留准确的原项目归属。' }
useAppStore.setState({
  config, sessions, focusTimelineHeight: 96,
  timelines: { ...snapshot.timelines, results: { agentSessionId: 'results', revision: 1, items: [resultMessage] } },
  providerCatalog: [], agentNames: { [base.id]: '修复滚动与右侧加载，正在验证原上下文', attention: '等待用户确认具体编辑请求', results: '已完成消息与项目识别修复', idle: '空闲，等待下一条指令', 'healthy-lost': '运行健康，连接观察暂时不可用', offline: '上一轮研究与设计记录', topic: '实现剪辑式时间轴与消息标记' },
  scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 0, topics: [topic, mote], error: null, reading: false } },
  agentComposerDrafts: { ordinary: '不要丢失这份终端草稿' },
  tabs: { [tab.id]: tab }, layouts: { [workspaceId]: { root: { type: 'leaf', groupId: 'fixture-group' }, groups: [{ id: 'fixture-group', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }], activeGroupId: 'fixture-group' } },
  mainSurface: 'agents', activeWorkspaceId: workspaceId,
  agentFocus: { execution: { sessionId: 'ordinary', history: [{ sessionId: 'ordinary', focusedAt: now-60000, identity:{name:'普通终端',kind:'terminal',providerId:null,hostId:'local',workspacePath:project.path,project:{id:workspaceId,name:project.name}} }] }, pmo: { sessionId: null } }
})
window.laneProbeState = () => {
  const { tabs, layouts, agentFocus, sessions, agentComposerDrafts, focusTimelineHeight } = useAppStore.getState()
  return { tabs, layouts, agentFocus, sessions, agentComposerDrafts, focusTimelineHeight }
}
window.restoreLaneProbe = state => useAppStore.setState({ ...state, config, ...restorePersistedUiState(config, state), agentFocus: restoreAgentFocus(state.agentFocus) })
window.laneProbeMode = mode => useAppStore.setState(state => ({ agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution, sessionId: mode === 'board' ? null : 'ordinary' } } }))
window.membershipProbe = () => {const state=useAppStore.getState();return {rows:[...document.querySelectorAll('.global-focus-surface [data-session-id]')].map(node=>node.dataset.sessionId).sort(), slot:document.querySelector('.focused-tab-workspace')?.dataset.focusTabId, terminalRegion:!!document.querySelector('.focused-tab-workspace [data-workbench-region-id=fixture-region]'),xterm:!!document.querySelector('.focused-tab-workspace .xterm'),focus:state.agentFocus.execution.sessionId,draft:state.agentComposerDrafts.ordinary,counts:[...document.querySelectorAll('[data-focus-count]')].map(node=>({key:node.dataset.focusCount,text:node.textContent})),historyTracks:[...document.querySelectorAll('[data-focus-timeline-id]')].map(node=>node.dataset.focusTimelineId)}}
window.laneProbeGeometry = () => {
  const root = document.querySelector('.global-focus-main'), lane = document.querySelector(`[data-project-id="${workspaceId}"]`)
  const columns = [...lane.querySelectorAll('section[data-bucket]')].map(node => {
    const rect = node.getBoundingClientRect(), header = node.querySelector('.focus-context-group__header')
    return { bucket: node.dataset.bucket, x: rect.x, y: rect.y, width: rect.width, height: rect.height, label: header.getAttribute('aria-label') }
  })
  const groups = lane.querySelector('.focus-project-lanes__groups')
  const overflow = [...root.querySelectorAll('.focus-project-lanes__track, .focus-project-lanes__groups, .focus-context-group')].map(node => ({ className: node.className, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }))
  const compact = lane.querySelector('[data-session-id="offline"]')
  return { containerWidth: root.getBoundingClientRect().width, display: getComputedStyle(groups).display, columns, horizontalOverflow: overflow.some(node => node.scrollWidth > node.clientWidth+1), overflow, compactHeight: compact?.getBoundingClientRect().height ?? null, topicHeading: document.querySelector('[data-topic-id]')?.textContent, regionIds: [...document.querySelectorAll('.focused-tab-workspace [data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId) }
}
function Fixture() {
  useEffect(() => { window.laneProbeReady = true }, [])
  return createElement('section', { className: 'workspace-main-surface', style: { width: '100vw', height: '100vh', position: 'relative' } },
    createElement('div', { style: { height: 'calc(100vh - 24px)' } }, createElement(FocusWorkbenchFixture, { workspaceId })),
    createElement('footer',{style:{position:'absolute',bottom:0,left:0,height:24,zIndex:5,background:'#171c22',padding:'0 8px',display:'flex'}},createElement(FocusNavigationButton,{'aria-label':'Focus'},'Focus')))
}
createRoot(document.getElementById('root')).render(createElement(Fixture))
