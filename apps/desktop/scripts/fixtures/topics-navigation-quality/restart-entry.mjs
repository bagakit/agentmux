import { createElement as h } from 'react'
import { splitWorkbenchRegion } from '@agentmux/layout'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { qualityTopics, seedTopicNavigation, topicCategory, topicConfig, topicWorkspace } from '../../../test/fixtures/topics-navigation-quality'
import '../../../src/renderer/src/styles/index.css'

const request=window.topicsRestartBoundary.request, {phase}=await request('setup'), controls=[]
const content='# Original research workface\n\nThe original file, layout and unsent work survive a real process restart.\n'
api.config.get=async()=>topicConfig
api.providers.list=async options=>options?.observation?{catalog:[],warnings:[]}:[]
api.demands.list=async()=>[]
api.sessions.snapshot=async()=>({sessions:[],timelines:{},recoveryCandidates:[]})
api.spatial.read=()=>request('spatial-read')
api.spatial.commit=input=>request('spatial-commit',input)
api.spatial.retainLabels=values=>request('spatial-labels',values)
api.spatial.onChange=window.topicsRestartBoundary.onSpatialChange
api.ui.requestStorageFlush=()=>request('flush')
api.scratch.listTopics=async()=>qualityTopics
api.scratch.readTopic=async(_workspace,id)=>qualityTopics.find(topic=>topic.id===id)??null
api.scratch.ensureMote=async()=>({id:'launcher:leader',directoryPath:'topic--launcher--leader',topicPath:'topic--launcher--leader/topic.md',title:'Mote',summary:'',collaborators:[],soul:''})
api.spaceObjects.appearance=async()=>({local:true,icon:null})
api.files.readDirectory=async(_workspace,root)=>['research.md','decisions.md'].map(name=>({name,path:root?root+'/'+name:name,isDirectory:false,isSymlink:false}))
api.files.read=async(_workspace,path)=>({status:'read',document:{path,revision:'original-private-revision',content}})
api.files.observe=async()=>{}
api.files.unobserve=async()=>{}
api.topics.call=async method=>{if(method==='topic.category.ls')return {categories:[topicCategory],unavailable:[]};throw Error('Unsupported private Topics request: '+method)}
for(const name of ['launchAgent','launchTerminal','recover','stop','write','resume','interrupt']) api.sessions[name]=async()=>{controls.push(name);throw Error('This layout proof must not invoke Agent lifecycle: '+name)}
window.agentmux={git:{status:async()=>({kind:'not-a-git-repository',hostId:'local',workspacePath:topicWorkspace.path})}}
const initialize=useAppStore.getState().initialize
if(phase==='seed') useAppStore.setState({mainSurface:'board'})
useAppStore.setState({initialize:async()=>{
  const dispose=await initialize()
  if(phase==='seed') {
    seedTopicNavigation({collapsed:true})
    useAppStore.setState(state=>({tabs:Object.fromEntries(Object.entries(state.tabs).map(([id,tab],index)=>[id,{...tab,
      regions:{[tab.layout.activeRegionId]:{kind:'file',regionId:tab.layout.activeRegionId,workspaceId:topicWorkspace.id,path:`topic--view--quality-${index}/research.md`}}}]))}))
    const first=useAppStore.getState().tabs['topic-tab-0'], secondRegion='original-decisions-region'
    const layout=splitWorkbenchRegion(first.layout,first.layout.activeRegionId,'right',secondRegion)
    layout.root.ratio=.62;layout.activeRegionId='topic-region-0'
    const originalPath='topic--view--quality-0/research.md',key=topicWorkspace.id+'\0'+originalPath
    useAppStore.setState(state=>({tabs:{...state.tabs,[first.id]:{...first,layout,regions:{...first.regions,
      [secondRegion]:{kind:'file',regionId:secondRegion,workspaceId:topicWorkspace.id,path:'topic--view--quality-0/decisions.md'}}}},
      documents:{[key]:{path:originalPath,revision:'original-private-revision',content:content+'\nOriginal unsaved file annotation.\n'}},dirtyDocuments:{[key]:true}}))
    for(const [region,path] of [['topic-region-0',originalPath],[secondRegion,'topic--view--quality-0/decisions.md']])
      await useAppStore.getState().setEditorRegionMode(region,topicWorkspace.id,path,'preview')
  }
  window.topicsRestartReady=true
  return dispose
}})
window.topicsRestartFacts=()=>{
  const state=useAppStore.getState(),workbench=projectPersistedWorkbench(state)
  return {phase,controls,seeded:phase==='seed',tabs:workbench.tabs,layouts:workbench.layouts,selection:state.workbenchSpaceSelection,
    drafts:state.agentComposerDrafts,documents:Object.fromEntries(Object.entries(state.documents).filter(([key])=>state.dirtyDocuments[key])),
    dirtyDocuments:Object.fromEntries(Object.entries(state.dirtyDocuments).filter(([,dirty])=>dirty)),collapsed:state.explorerCollapsed,activeWorkspaceId:state.activeWorkspaceId,
    mainSurface:state.mainSurface,focus:state.agentFocus,error:state.error,workbenchSave:state.workbenchSave,
    rows:document.querySelectorAll('.workspace-topic-entry').length,
    regions:[...document.querySelectorAll('[data-workbench-region-id]')].map(node=>node.dataset.workbenchRegionId).sort()}
}
createClientUiRoot(document.getElementById('root')).render(h(App))
