import {createElement} from 'react'
import {createClientUiRoot} from '../../../test/helpers/client-ui-render'
import {createWorkspaceLayout,splitWorkbenchRegion} from '@agentmux/layout'
import {App} from '../../../src/renderer/src/App'
import {api} from '../../../src/renderer/src/lib/api'
import {useAppStore} from '../../../src/renderer/src/store'
import {createWorkbenchTab} from '../../../src/renderer/src/lib/workbench-tabs'
import {spatialCatalog} from '../../../src/renderer/src/lib/space-agent-control'
import {surveyInitialZoneSelection,surveySelectReference} from '../../../src/renderer/src/lib/survey-workface'
import {fixturePath} from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

const config=await api.config.get(),snapshot=await api.sessions.snapshot()
const resource={...config.workspaces.find(w=>w.id==='workspace-demo'),path:fixturePath('private/survey-source'),name:'Research source'}
const second={...resource,id:'survey-second-workspace',path:fixturePath('private/survey-follow-up'),name:'Follow-up source'}
const session={...snapshot.sessions.find(s=>s.id==='session-codex'),workspacePath:resource.path}
if(!session.control?.run?.runId||!resource.id)throw new Error('Actual typed preview identities required')
const favicon=(color,path)=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${color}"/><path d="${path}" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`)
const icons=[favicon('#5279c7','M7 8h10M7 12h10M7 16h6'),favicon('#4c947b','m7 12 4 4 6-8'),favicon('#a06b9c','M7 7h10v10H7z')]
async function browser(tabId,regionId,workspace,title,url,icon){const native=await api.browser.create(regionId,url,workspace.id);return createWorkbenchTab(tabId,{...native,regionId,kind:'browser',workspaceId:workspace.id,browserId:native.id,title,faviconDataUrl:icon},title)}
const mixed=createWorkbenchTab('survey-a-agent',{regionId:'survey-a-agent-region',workspaceId:resource.id,kind:'agent',phase:'attached',sessionId:session.id},'Research agent')
mixed.regions['survey-a-agent-file']={regionId:'survey-a-agent-file',workspaceId:resource.id,kind:'file',path:'source-summary.md'}
mixed.layout=splitWorkbenchRegion(mixed.layout,'survey-a-agent-region','right','survey-a-agent-file')
const tabs=[
 await browser('survey-a-page','survey-a-browser',resource,'Reading notes','https://reading.example.test/notes',icons[0]),
 await browser('survey-a-source','survey-a-source-browser',resource,'Reference library','https://reference.example.test/library',icons[1]),
 mixed,
 createWorkbenchTab('survey-a-file',{regionId:'survey-a-file-region',workspaceId:resource.id,kind:'file',path:'research.md'},'Research draft'),
 await browser('survey-b-page','survey-b-browser',second,'Next reading','https://follow-up.example.test/',icons[2]),
 createWorkbenchTab('survey-b-agent',{regionId:'survey-b-agent-region',workspaceId:second.id,kind:'launcher'},'Follow-up agent')
]
useAppStore.setState({loading:false,initialize:async()=>()=>{},config:{...config,workspaces:[resource,second]},sessions:[session],
 activeWorkspaceId:resource.id,mainSurface:'survey',toolsOpen:false,projectRailOpen:false,surveyToolsOpen:false,
 tabs:Object.fromEntries(tabs.map(tab=>[tab.id,tab])),layouts:{[resource.id]:createWorkspaceLayout('survey-a-group',tabs.filter(t=>t.workspaceId===resource.id).map(t=>t.id)),[second.id]:createWorkspaceLayout('survey-b-group',tabs.filter(t=>t.workspaceId===second.id).map(t=>t.id))},
 surveySidebarWidth:260,surveySidebarCollapsed:false,surveyCollectedZones:{},surveyExplorationNames:{},surveyZoneSelection:null,
 agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}},agentComposerDrafts:{[session.id]:'Original unsent research draft'}})
const catalog=spatialCatalog(useAppStore.getState(),[])
const zoneA=catalog.tabs.find(t=>t.tabId==='survey-a-page')?.zoneId,zoneB=catalog.tabs.find(t=>t.tabId==='survey-b-page')?.zoneId
if(!zoneA||!zoneB||zoneA===zoneB)throw new Error('Two exact real Catalog Zones required')
const selection=surveySelectReference(surveyInitialZoneSelection(catalog,zoneA,useAppStore.getState().layouts,useAppStore.getState().tabs,resource.id),{tabId:'survey-a-page',regionId:'survey-a-browser'})
useAppStore.setState({surveyCollectedZones:{[zoneA]:true,[zoneB]:true},surveyExplorationNames:{[zoneA]:'Research reading',[zoneB]:'Follow-up research'},surveyZoneSelection:selection})
const original=useAppStore.getState(),calls={stop:0,resume:0,launchAgent:0,write:0,interrupt:0}
for(const key of Object.keys(calls)){const previous=api.sessions[key];api.sessions[key]=(...args)=>{calls[key]++;return previous(...args)}}
window.surveyItemProof={ready:true,zoneA,zoneB,
 facts(){const state=useAppStore.getState();return{selection:state.surveyZoneSelection,collected:state.surveyCollectedZones,collapsed:state.surveySidebarCollapsed,
  sameSessions:state.sessions===original.sessions,sameDrafts:state.agentComposerDrafts===original.agentComposerDrafts,draft:state.agentComposerDrafts[session.id],run:state.sessions[0]?.control.run.runId,calls:{...calls},
  originalTabs:tabs.map(tab=>({id:tab.id,preserved:state.tabs[tab.id]===tab})),created:Object.values(state.tabs).filter(tab=>!original.tabs[tab.id]).map(tab=>({id:tab.id,workspaceId:tab.workspaceId,zoneId:spatialCatalog(state,[]).tabs.find(f=>f.tabId===tab.id)?.zoneId,regions:Object.values(tab.regions).map(r=>({kind:r.kind,id:r.regionId}))})),
  primary:state.activeWorkspaceId,originalPrimary:original.activeWorkspaceId,rows:[...document.querySelectorAll('[data-survey-zone-id]')].map(row=>({zoneId:row.dataset.surveyZoneId,label:row.querySelector('.survey-item')?.getAttribute('aria-label'),tabs:[...row.querySelectorAll('[data-survey-tab-id]')].map(button=>({id:button.dataset.surveyTabId,label:button.getAttribute('aria-label'),selected:button.getAttribute('aria-current'),favicons:button.querySelectorAll('img').length,marks:button.querySelector('.workbench-tab__marks')?.children.length??0}))})),
  menus:[...document.querySelectorAll('[role="menu"]')].map(menu=>({text:menu.textContent,zoneId:menu.dataset.surveyContextZoneId??null})),
  originals:tabs.map(tab=>({id:tab.id,workspaceId:tab.workspaceId,regionKinds:Object.values(tab.regions).map(region=>region.kind)})),count:Object.keys(state.tabs).length,
  retainedTabIds:Object.keys(state.tabs),sessions:state.sessions.map(s=>({id:s.id,runId:s.control.run.runId})),
  mountBoundary:'Actual App/GlobalSurveySurface/SurveyZoneItem/SurveyItemOptions/Store. Typed preview API; only SessionPane/EditorPane/diff paint leaves isolated.'}},
 selectA(){const state=useAppStore.getState();state.setSurveyZoneSelection(selection)},
}
createClientUiRoot(document.getElementById('root')).render(createElement(App))
