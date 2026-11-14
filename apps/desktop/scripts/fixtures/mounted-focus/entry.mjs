import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { updateThemeSelection } from "@agentmux/client-ui/theme"
import { spaceMountKey } from "../../../src/shared/space-mount"
import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
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
const alpha = { ...workspaceBase, id: 'alpha', path: _hygiene_fixturePath("private/alpha"), name: '长中文项目：连续输入与性能研究，保留完整名称' }
const beta = { ...alpha, id: 'beta', path: _hygiene_fixturePath("private/beta"), name: 'Beta · second independent project' }
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

updateThemeSelection({themeId:'graphite',appAppearance:'dark'})
const reference={runtimeId:'source-project-runtime',spaceId:'source-project-space'}, source={runtimeId:reference.runtimeId,ownerInstanceId:'source-instance'}, key=spaceMountKey(reference)
const target={hostId:'source-carrier',reference,zoneId:'original-zone',workspaceId:'source-workspace'}
const sourceTabs=Array.from({length:14},(_,index)=>({tabId:'source-tab-'+index,zoneId:target.zoneId,workspaceId:target.workspaceId,name:index===0?'检查数据入口与检索流程':index===1?'追踪跨端导航的长名称任务，保留原始工作上下文':index===2?'参考资料与待续工作':null,regionIds:['source-region-'+index]}))
const sourceRegions=sourceTabs.map((tab,index)=>({regionId:tab.regionIds[0],tabId:tab.tabId,kind:index<2?'agent':index===13?'launcher':'browser',agentSessionId:index<2?'source-agent-'+index:null,runId:index<2?'source-run-'+index:null,...(index<2?{execution:{hostId:'local',runtimeId:reference.runtimeId,cwd:'/original/project'}}:{})}))
const sourceSnapshot={reference,source,revision:4,scope:{space:{spaceId:reference.spaceId,kind:'folder',name:'Sample Project',hostId:'local',directoryPath:'/original/project',projectId:'source-project'},zones:[{zoneId:target.zoneId,workspaceId:target.workspaceId,hostId:'local',kind:'directory',directoryPath:'/original/project',branch:'main'}],tabs:sourceTabs,regions:sourceRegions,bindings:[{zoneId:target.zoneId,spaceId:reference.spaceId}]}}
const opening={reference,source,revision:4}, events=sourceRegions.slice(0,2).map((region,index)=>({...opening,type:'member',member:{hostId:'local',runtimeId:reference.runtimeId,agentSessionId:region.agentSessionId},occurrences:[{regionId:region.regionId,projectRuntimeId:reference.runtimeId,agentRuntimeId:reference.runtimeId,executionRoute:{kind:'same'}}],state:index===1?{status:'unavailable',issue:{code:'OBSERVATION_UNAVAILABLE',message:'The original Session observation is temporarily unavailable.'}}:{status:'observed',authority:source,session:{kind:'agent',sessionProjection:'summary',agentSessionId:region.agentSessionId,hostId:'local',providerId:'codex',executorId:'codex',workspacePath:'/original/project',run:{runId:region.runId},retiredRuns:[],createdAt:now,updatedAt:now,semanticStatus:{state:'working',source:'native-hook',observedAt:now,stateEnteredAt:now-12000}}}}))
api.spaceMounts.watch=async(_input,_listener)=>({initial:sourceSnapshot,dispose(){}})
api.spaceMounts.sessions=async(_input,listener)=>{queueMicrotask(()=>events.forEach(observation=>listener({type:'observation',observation})));return{initial:opening,dispose(){}}}
const draftKey=JSON.stringify([reference.runtimeId,reference.spaceId,'source-tab-13','source-region-13'])
useAppStore.setState(state=>({mainSurface:'agents',focusView:'list',config:{...state.config,hosts:[...state.config.hosts,{id:target.hostId,kind:'ssh',label:'Research device',hostname:'source.example'}]},mountedSpaceInputs:{[key]:{target,drafts:{[draftKey]:'Keep this original unsent task'}}},mountedSpaceObservations:{},mountedSpaceSessions:{},selectedSpaceMount:null}))
window.mountedFocusProof={ready:true,key,sourceTabs,theme(value){updateThemeSelection({themeId:'graphite',appAppearance:value})},facts(){const s=useAppStore.getState();return{selected:s.selectedSpaceMount,input:s.mountedSpaceInputs[key],tabs:s.tabs,layouts:s.layouts,runs:s.sessions.map(x=>x.control?.run),drafts:s.agentComposerDrafts,reference,snapshotRegions:sourceSnapshot.scope.regions.length}},back(){useAppStore.setState({selectedSpaceMount:null,mainSurface:'agents'})}}

createRoot(document.getElementById('root')).render(createElement(App))
