import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const sample:{snapshot:AgentTimelineSnapshot,boundary:string}=await (await fetch('./public-timeline.json')).json()
const controls:string[]=[],copies:string[]=[]
api.ui.writeClipboardText=async text=>{copies.push(text)}
for(const key of ['submitPrompt','write','resume','recover','stop'] as const)api.sessions[key]=async()=>{controls.push(key);throw new Error('Private reading scene forbids Run control')}
Object.assign(window,{workflowPreview:{sample,copies,controls}})
function Scene(){const[draft,setDraft]=useState('Keep the original unsent reply draft.');return <main className="workflow-preview" style={{width:new URLSearchParams(location.search).get('width')==='332'?332:1000,maxWidth:'100%'}}>
 <header className="workflow-preview__header"><strong>Conversation</strong><span>Recorded activity · Private public Timeline / FileStore</span></header>
 <div className="workflow-preview__reading"><ActivityView sessionId={sample.snapshot.agentSessionId} items={sample.snapshot.items} capability="complete-events" displayState="working" workspaceRoot="/fixture" /></div>
 <label className="workflow-preview__draft"><textarea aria-label="Reply draft" value={draft} onChange={e=>setDraft(e.target.value)} /></label>
 </main>}
createRoot(document.getElementById('root')!).render(<Scene />)
