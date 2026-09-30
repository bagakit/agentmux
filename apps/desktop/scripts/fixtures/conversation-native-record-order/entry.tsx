import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const page:AgentSessionHistoryPage=await (await fetch('./public-reader-page.json')).json()
const step=(id:string,time:number):AgentTimelineItem=>({id,agentSessionId:page.agentSessionId,kind:'tool_call',source:'native-hook',status:'complete',createdAt:time,updatedAt:time,title:'Read '+id,toolName:'Read',toolInput:'src/'+id+'.ts',toolOutput:'Recorded file contents: '+id})
const items:AgentTimelineItem[]=[step('first-observation',1),step('second-observation',2),{id:'submitted-peer',agentSessionId:page.agentSessionId,kind:'user_message',source:'user',status:'complete',createdAt:3,updatedAt:3,title:'Input',content:'Please review the next file.',authorAgentSessionId:'trusted-peer'},step('third-observation',4),step('fourth-observation',5)]
const messages=projectSessionUserMessages({agentSessionId:page.agentSessionId,historyPage:page,timeline:{agentSessionId:page.agentSessionId,revision:1,items}})
const controls:string[]=[],copies:string[]=[],links:string[]=[]
api.ui.writeClipboardText=async text=>{copies.push(text)}
for(const key of ['submitPrompt','write','resume','recover','stop'] as const)api.sessions[key]=async()=>{controls.push(key);throw new Error('Private reading scene forbids Run control')}
Object.assign(window,{nativeOrderPreview:{page,messages,copies,controls,links}})
function Scene(){const[draft,setDraft]=useState('Keep the original unsent reply draft.');return <main className="native-order-preview" style={{width:new URLSearchParams(location.search).get('width')==='332'?332:1000,maxWidth:'100%'}}>
 <header className="native-order-preview__header"><strong>Conversation</strong><span>Private source-order scene · public Claude / FileStore page</span></header>
 <div className="native-order-preview__reading"><ActivityView sessionId={page.agentSessionId} items={items} nativeHistoryPage={page} userMessages={messages} capability="complete-events" displayState="done" workspaceRoot="/private" openHttpLink={url=>{links.push(url)}} describeSpeaker={speaker=>({name:speaker.id==='trusted-peer'?'Review Agent':speaker.role==='agent'?'Execution Agent':'You'})} /></div>
 <label className="native-order-preview__draft"><textarea aria-label="Reply draft" value={draft} onChange={e=>setDraft(e.target.value)} /></label>
 </main>}
createRoot(document.getElementById('root')!).render(<Scene />)
