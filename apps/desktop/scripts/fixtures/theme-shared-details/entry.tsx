import { fixturePath as _reshape_fixturePath } from "../../../../../test/fixture-values.mjs"
import {createRoot} from 'react-dom/client'
import {ConversationSpeakerAvatar} from '../../../src/renderer/src/components/ConversationSpeakerAvatar'
import {ConversationAnnotationDelivery} from '../../../src/renderer/src/components/ConversationAnnotationDelivery'
import {DesktopClientUiProvider} from '../../../src/renderer/src/components/DesktopClientUiProvider'
import {useAppStore} from '../../../src/renderer/src/store'
import {api} from '../../../src/renderer/src/lib/api'
import {createWorkbenchTab} from '../../../src/renderer/src/lib/workbench-tabs'
import {createWorkspaceLayout} from '@agentmux/layout'
import {mountThemeRuntime,updateThemeSelection} from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'
const config=await api.config.get(),snapshot=await api.sessions.snapshot(),source=snapshot.sessions.find(s=>s.kind==='agent')!
source.workspacePath=_reshape_fixturePath("private/tmp/theme-shared-detail");config.workspaces[0]!.path=source.workspacePath;
const origin={workspaceId:config.workspaces[0]!.id,tabGroupId:'detail-group',tabId:'detail-tab',regionId:'detail-region'}
const tab=createWorkbenchTab(origin.tabId,{regionId:origin.regionId,kind:'agent',phase:'attached',workspaceId:config.workspaces[0]!.id,sessionId:source.id})
const calls:unknown[]=[]
useAppStore.setState({config,sessions:[source],tabs:{[tab.id]:tab},layouts:{[origin.workspaceId]:createWorkspaceLayout(origin.tabGroupId,[tab.id])},restoredWorkbench:null,scratchTopicSnapshots:{},spaceZoneBindings:{},timelines:{},executorDetections:{},hostExecutorInventories:{},agentNames:{[source.id]:'Private original source'},executeControl:async input=>{calls.push(input);return new Promise(()=>{})},detectExecutors:async()=>{}} as never)
mountThemeRuntime(window);updateThemeSelection({appAppearance:'light'})
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><main style={{padding:32,fontSize:14,maxWidth:880}}><h1>Private original shared details</h1><p>Original identity hue and original annotation UI. Held private request; no Main, Provider launch or user Run.</p><section style={{display:'flex',gap:24,padding:16,background:'var(--surface-1)'}}>{['avatar-1','avatar-2','avatar-3','avatar-4','avatar-5','avatar-6'].map(id=><div key={id}><ConversationSpeakerAvatar speaker={{role:'agent',id}} name={id} size={16}/><ConversationSpeakerAvatar speaker={{role:'agent',id}} name={id} size={20}/><span>{id}</span></div>)}</section><h2>Original annotation delivery</h2><ConversationAnnotationDelivery sessionId={source.id} origin={origin} annotation={{messageId:'private-original-message',quote:'Original retained quote',note:'Original retained annotation'}} onAccepted={()=>{}} onError={message=>{document.getElementById('detail-feedback')!.textContent=message}}/><p id="detail-feedback"/><button onClick={()=>updateThemeSelection({appAppearance:'light'})}>Light</button><button onClick={()=>updateThemeSelection({appAppearance:'dark'})}>Dark</button></main></DesktopClientUiProvider>)
Object.assign(window,{sharedDetailProof:{facts(){const loading=document.querySelector('.conversation-annotation-delivery__send [data-semantic-icon="status.loading"]');return{calls,loading:loading&&{animation:getComputedStyle(loading).animationName,disabled:loading.parentElement instanceof HTMLButtonElement&&loading.parentElement.disabled},avatars:[...document.querySelectorAll('.conversation-avatar--agent')].map(n=>({id:n.getAttribute('data-speaker-id'),color:getComputedStyle(n).color,background:getComputedStyle(n).backgroundColor,hue:(n as HTMLElement).style.getPropertyValue('--speaker-hue'),rect:n.getBoundingClientRect().toJSON()})),mode:document.documentElement.dataset.appearance}},state(){return{source,config}}}})
