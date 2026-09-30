import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import type {AgentSessionHistoryPage,AgentTimelineItem} from '@agentmux/core'
import {projectSessionUserMessages} from '@agentmux/core/session-user-messages'
import {ActivityView} from '../../../src/renderer/src/components/ActivityView'
import {createSpeakerResolver} from '../../../src/renderer/src/lib/conversation-speaker'
import {api} from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const page:AgentSessionHistoryPage=await(await fetch('/public-reader-page.json')).json()
const copies:string[]=[],controls:string[]=[]
api.ui.writeClipboardText=async text=>{copies.push(text)}
for(const name of ['submitPrompt','write','resume','recover','stop'] as const)api.sessions[name]=async()=>{controls.push(name);throw Error('Display scene disallows Runtime control')}
const captured:AgentTimelineItem={id:'trusted-peer',agentSessionId:page.agentSessionId,kind:'user_message',source:'user',status:'failed',title:'Declared private capture',authorAgentSessionId:'reviewer',content:page.items[0]!.contentParts[0]!.kind==='text'?page.items[0]!.contentParts[0]!.text:'',createdAt:1000,updatedAt:1000};
const messages=projectSessionUserMessages({agentSessionId:page.agentSessionId,historyPage:page,timeline:{agentSessionId:page.agentSessionId,revision:1,items:[captured]}})
const describeSpeaker=createSpeakerResolver({currentSession:{id:page.agentSessionId,label:'Implementation Agent',providerId:'claude'},lookupAgent:id=>id==='reviewer'?{label:'Review Agent',providerId:'claude'}:undefined})
Object.assign(window,{messageWrapperPreview:{copies,controls,page}})
function Scene(){const[draft,setDraft]=useState('Keep the original reply draft.');return <main className="message-wrapper-preview"><header><strong>Conversation</strong><span>Private public Claude reader · exact records</span></header><div className="message-wrapper-preview__reading"><ActivityView sessionId={page.agentSessionId} capability="complete-events" displayState="done" items={[captured]} nativeHistoryPage={page} userMessages={messages} describeSpeaker={describeSpeaker}/></div><footer><textarea aria-label="Reply draft" value={draft} onChange={e=>setDraft(e.target.value)}/></footer></main>}
createRoot(document.getElementById('root')!).render(<Scene/> )
