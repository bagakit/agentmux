import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { createSpeakerResolver } from '../../../src/renderer/src/lib/conversation-speaker'
import { currentConversationSenderDetails, currentConversationSpeakerMetadata } from '../../../src/renderer/src/lib/conversation-sender-details'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AppConfig, AgentTimelineSnapshot, SessionSnapshot } from '../../../src/shared/contracts'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const scene: { config: AppConfig; sessions: SessionSnapshot[]; demands: Record<string, DemandRecord>; page: AgentSessionHistoryPage; timeline: AgentTimelineSnapshot; agentNames: Record<string,string>; draft: string } = await (await fetch('/public-scene.json')).json()
const copies: string[] = [], controls: string[] = [], detailReads: string[] = [], appearances: string[] = []
const copyFailure = { enabled: false }
api.ui.writeClipboardText = async text => { if (copyFailure.enabled) throw Error('Controlled clipboard unavailable'); copies.push(text) }
for (const name of ['submitPrompt','write','resume','recover','stop'] as const) api.sessions[name] = async () => { controls.push(name); throw Error('Private reading scene prohibits Run control') }
const projectImage = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2d3f50"/><path d="M7 23 16 7l9 16h-5l-4-7-4 7Z" fill="#b9d8f1"/></svg>')
api.workspaces.appearance = async workspaceId => { appearances.push(workspaceId); return {kind:'repository',icon:workspaceId==='sender-project'?projectImage:null} }
useAppStore.setState({ config: scene.config, sessions: scene.sessions, agentNames: scene.agentNames, demands: scene.demands, timelines:{[scene.page.agentSessionId]:scene.timeline} })
const messages = projectSessionUserMessages({ agentSessionId:scene.page.agentSessionId, historyPage:scene.page, timeline:scene.timeline })
const describeSpeaker = createSpeakerResolver({ lookupAgent:id => {
  const state=useAppStore.getState(), sender=currentConversationSpeakerMetadata(id,{sessions:state.sessions,workspaces:state.config?.workspaces??[],agentNames:state.agentNames,timelines:state.timelines})
  return sender ? {label:sender.label,providerId:sender.providerId,...(sender.project?{project:sender.project}:{}),readDetails:()=>{detailReads.push(id);const current=useAppStore.getState();return currentConversationSenderDetails(id,{sessions:current.sessions,workspaces:current.config?.workspaces??[],agentNames:current.agentNames,timelines:current.timelines,demands:current.demands})}} : undefined
} })
Object.assign(window,{compactIdentityPreview:{copies,controls,detailReads,appearances,scene,copyFailure}})
function Scene(){const[draft,setDraft]=useState(scene.draft);return <main className="compact-identity-preview"><header><strong>Conversation</strong><span>Actual public native reader · Private Source preview</span></header><div className="compact-identity-preview__reading"><ActivityView sessionId={scene.page.agentSessionId} capability="complete-events" displayState="done" items={scene.timeline.items} nativeHistoryPage={scene.page} userMessages={messages} describeSpeaker={describeSpeaker}/></div><footer><textarea aria-label="Reply draft" value={draft} onChange={e=>setDraft(e.target.value)}/></footer></main>}
createRoot(document.getElementById('root')!).render(<Scene/> )
