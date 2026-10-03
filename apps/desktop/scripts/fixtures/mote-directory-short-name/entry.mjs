import { createElement } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { moteWorkbenchProjection } from '../../../src/renderer/src/lib/mote-workbench-projection'
import { readMoteMaterial } from '../../../src/renderer/src/lib/mote-cooperation'
import { workbenchObjectLayout } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import '../../../src/renderer/src/styles/index.css'
const phase=new URLSearchParams(location.search).get('phase'), config=await api.config.get()
window.shortSetup.phase='controlled-public-ports'
// Controlled unrelated public ports use local objects; the actual bridge stays immutable.
for(const key of ['spatial','config','providers','demands','files','workspaces','browser','ui','continuousProgress','schedule'])api[key]={...api[key]}
const actualScratch={...api.scratch}, calls=[];let actionScope='bootstrap'
let held=null, job=null, firstTabId=localStorage.getItem('private-born-tab'), born=null
api.spatial.onChange=()=>()=>{}
api.config.onChange=()=>()=>{}
api.providers.list=async()=>[];api.demands.list=async()=>[]
api.sessions.snapshot=async()=>({sessions:[],timelines:{},recoveryCandidates:[]})
api.sessions.historySources=async()=>[];api.sessions.onEvent=()=>()=>{}
for(const method of ['launchAgent','launchTerminal','write','submitPrompt','stop','recover'])api.sessions[method]=async()=>{calls.push({method,denied:true,scope:actionScope});throw Error('Private proof cannot '+method)}
api.files.onInvalidated=()=>()=>{};api.files.observe=async()=>{};api.files.unobserve=async()=>{}
api.files.readDirectory=async()=>[];api.files.read=async()=>({content:'',version:'private-unavailable-file'})
api.workspaces.listBranches=async()=>[];api.workspaces.appearance=async()=>({icon:null})
api.browser.onEvent=()=>()=>{};api.browser.onPresentationEvent=()=>()=>{};api.browser.updatePresentations=async()=>{}
api.ui.publishNativeOverlays=async()=>({projected:0,capturedPixels:0});api.ui.setAgentAttentionCount=async()=>false;api.ui.onWindowResize=()=>()=>{};api.ui.nativeOverlayRegions=async()=>{};api.ui.requestStorageFlush=async()=>{}
api.continuousProgress.list=async()=>[];api.schedule.list=async()=>[]
api.scratch.ensureMote=async(workspace,id)=>{
 if(id==='launcher:leader')return actualScratch.ensureMote(workspace,id)
 calls.push({method:'ensureMote',id});if(phase==='seed')return new Promise((resolve,reject)=>{held={workspace,id,resolve,reject}})
 return actualScratch.ensureMote(workspace,id)
}
const dispose=await useAppStore.getState().initialize()
const root=createClientUiRoot(document.getElementById('root'));root.render(createElement(App))
const state=()=>useAppStore.getState()
function facts(){const s=state(),tab=s.tabs[firstTabId],choice=s.workbenchSpaceSelection,topics=Object.values(s.scratchTopicSnapshots).flatMap(x=>x.topics??[])
 const catalog=spatialCatalog(s,topics),float=tab?moteWorkbenchProjection(catalog,tab,{...readPmoTeamsTopicFloatingState(),targetTabId:tab.id,targetTopicId:tab.topicId},()=>{},s.layouts):null
 return{ready:!!s.config,phase,tabId:firstTabId,topicId:tab?.topicId,regionId:tab?.layout.activeRegionId,space:tab?.space??null,preparation:tab?.topicPreparation??null,
 draft:tab?s.agentComposerDrafts[tab.layout.activeRegionId]:null,regionKeys:tab?Object.keys(tab.regions):[],selection:choice,spaceProjection:workbenchObjectLayout(s,SCRATCH_WORKSPACE_ID).confirmed,floatEntity:float?.projection?.entity??null,
 snapshots:topics.map(x=>({id:x.id,readError:x.readError??null,physical:x.physicalDirectoryPath??null})),directoryWarning:s.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.error??null,
 error:s.error,notice:s.errorNoticeContext??null,sessions:s.sessions.length,calls}}
window.shortProof={facts,beginAction(){actionScope='mote-action';return{bootstrapCalls:[...calls]}},async bridge(){const raw=await window.agentmux.scratch.listTopics(SCRATCH_WORKSPACE_ID),normalized=await actualScratch.listTopics(SCRATCH_WORKSPACE_ID);await state().refreshScratchTopics(SCRATCH_WORKSPACE_ID,true);return{raw,normalized:Array.isArray(normalized),normalizedIssues:normalized.issues??[],state:facts()}},
 start(){job=state().createScratchTopic('mote',{prompt:'Original unsent request'}).then(value=>({ok:true,id:value.id}),error=>({ok:false,message:error.message}));const choice=state().workbenchSpaceSelection;firstTabId=choice.tabId;born={tabId:firstTabId,regionId:choice.regionId,topicId:choice.topicId};localStorage.setItem('private-born-tab',firstTabId);return facts()},
 async fail(){held.reject(Error('Private first metadata reply unavailable'));return await job},
 async confirm(){const before=facts(),snapshot=await actualScratch.ensureMote(SCRATCH_WORKSPACE_ID,before.topicId);await state().openScratchTopic(before.topicId);return{before,snapshot,after:facts()}},
 async fileCheck(){await prepareRendererUpdate();const s=state(),tab=s.tabs[firstTabId],topic=s.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID].topics.find(t=>t.id===tab.topicId),workspace=s.config.workspaces.find(w=>w.id===SCRATCH_WORKSPACE_ID);return readMoteMaterial({workspace,topic,rootPath:topic.directoryPath},topic.directoryPath+'/SOUL.md')},
 float(){const tab=state().tabs[firstTabId];requestPmoTeamsTopicFloatingOpen({targetTabId:firstTabId,targetTopicId:tab.topicId});return facts()},
 closeFloat(){requestPmoTeamsTopicFloatingClose();return facts()},
 async save(){await prepareRendererUpdate();return facts()},
 dispose(){dispose();root.unmount()}}
window.shortSetup.phase='ready'
