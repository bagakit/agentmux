import {createRoot} from 'react-dom/client'
import {GoalFiniteStartControl} from '../../../src/renderer/src/components/GoalFiniteStartControl'
import {useAppStore} from '../../../src/renderer/src/store'
import {api} from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
const reference={kind:'space-member' as const,source:{runtimeId:'original-source',spaceId:'original-space',regionId:'original-region',admission:{kind:'association' as const,operationId:'original-association'}},execution:{runtimeId:'original-executor',agentSessionId:'original-agent'}}
const goal={id:'connection-draft',title:'Prepare the service migration',description:'Review the migration task with the original Agent.',status:'todo' as const,priority:'normal' as const,projectId:null,projectName:null,sessionIds:[reference],assigneeSessionIds:[reference],supervisorSessionId:null,createdAt:1,updatedAt:2,source:'default-topic' as const,sessions:[],workspacePath:null,executorId:null,participations:[],tags:[],plannedStartAt:null,targetAt:null,parentDemandId:null,decisions:[],activities:[]}
const calls:string[]=[]
api.ui.requestStorageFlush=async()=>{}
api.demands.inputEpoch=async input=>{calls.push('goal.input.epoch');return{runtimeId:input.agentReference.execution.runtimeId,inputEpoch:'fixture-current-cut'}}
await useAppStore.getState().initialize()
useAppStore.setState({loading:false,config:{version:9,hosts:[{id:'local',kind:'local',label:'This Mac'},{id:'independent',kind:'local',label:'Independent Agent'}],executors:{},workspaces:[],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}},demands:{[goal.id]:goal},sessions:[],agentNames:{},timelines:{},goalFiniteStartIntents:{}})
Object.assign(window,{goalInputBirthGallery:{facts:()=>({calls,input:useAppStore.getState().goalFiniteStartIntents[goal.id]})}})
document.documentElement.dataset.appearance='dark'
function Surface(){const current=useAppStore(s=>s.demands[goal.id]);return <main style={{height:'100vh',padding:36,background:'var(--surface-0)',color:'var(--text)'}}><div className="goals-caption">ONE-TIME TASK</div><h1 style={{fontSize:22,fontWeight:500,marginBottom:8}}>{goal.title}</h1><p className="goals-caption" style={{marginBottom:28}}>{goal.description}</p><div style={{maxWidth:760}}><GoalFiniteStartControl demand={current!} primary/></div></main>}
createRoot(document.getElementById('root')!).render(<Surface/> )
