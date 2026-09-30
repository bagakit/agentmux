import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const recorded:AgentSessionHistoryPage=await (await fetch('./public-reader-page.json')).json()
const mode=new URLSearchParams(location.search).get('mode')??'recorded'
const page:AgentSessionHistoryPage=mode==='redacted'?{...recorded,items:[
 {id:'declared-empty',kind:'activity',contentParts:[{kind:'reasoning',text:'',signature:'Never display this signature'}]},
 {id:'declared-redacted',kind:'activity',contentParts:[{kind:'reasoning',text:'Never display this hidden thought',redacted:true,signature:'Never display this signature'}]}
]}:mode==='empty'?{...recorded,items:[]}:recorded
const messages=projectSessionUserMessages({agentSessionId:page.agentSessionId,historyPage:page})
const answer:AgentTimelineItem={id:'declared-hook-answer',agentSessionId:page.agentSessionId,kind:'assistant_message',source:'native-hook',status:'complete',title:'Assistant response',content:'### A clear answer\n\nThe answer stays in the main conversation. Recorded thinking and tool details can be opened separately.',createdAt:1,updatedAt:1}
const controls:string[]=[],copies:string[]=[]
api.ui.writeClipboardText=async text=>{copies.push(text)}
for(const key of ['submitPrompt','write','resume','recover','stop'] as const)api.sessions[key]=async()=>{controls.push(key);throw new Error('Private reading scene forbids Run control')}
Object.assign(window,{reasoningPreview:{page,originalPage:recorded,messages,copies,controls,mode}})
function Scene(){const[draft,setDraft]=useState('Keep the original unsent reply draft.');return <main className="reasoning-preview" style={{width:new URLSearchParams(location.search).get('width')==='332'?332:1000,maxWidth:'100%'}}>
 <header className="reasoning-preview__header"><strong>Conversation</strong><span>Private actual Activity · {mode==='recorded'?'public Claude / FileStore records':'declared empty or redacted transport'}</span></header>
 <div className="reasoning-preview__reading"><ActivityView sessionId={page.agentSessionId} items={[answer]} nativeHistoryPage={page} userMessages={messages} capability="complete-events" displayState="done" workspaceRoot="/private" /></div>
 <label className="reasoning-preview__draft"><textarea aria-label="Reply draft" value={draft} onChange={e=>setDraft(e.target.value)} /></label>
 </main>}
createRoot(document.getElementById('root')!).render(<Scene />)
