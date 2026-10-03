import { fixturePath as _hygiene_fixturePath, fixtureTime as _hygiene_fixtureTime } from "../../../scripts/lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { PROMPT_REACTION_STARTERS } from '@agentmux/core/prompt-reaction'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationNativeThread } from '@agentmux/client-ui/components/ConversationNativeThread'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { ShortcutSettingsPane } from '../../../src/renderer/src/components/settings/ShortcutSettingsPane'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { useConversationReactions } from '../../../src/renderer/src/lib/conversation-reactions'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'

const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'This Mac'}],executors:{codex:{label:'Codex',providerId:'codex',command:'codex',args:[],env:{},injectAgentMuxGuide:true}},
 workspaces:[{id:'reaction-project',name:'AgentMux',hostId:'local',path:_hygiene_fixturePath("repo/agentmux"),kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},composerShortcuts:[...PROMPT_REACTION_STARTERS]}
const session:SessionSnapshot={id:'reaction-agent',kind:'agent',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:_hygiene_fixturePath("repo/agentmux"),label:'Interface',createdAt:1,updatedAt:1,agentSessionUpdatedAt:1,processState:'running',latestOutputBytes:0,promptSubmissionPredecessor:null,status:{state:'waiting',source:'run-process',observedAt:1},capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:{kind:'agent',hostId:'local',agentSessionId:'reaction-agent',run:{runId:'scene-run'}},pendingInteraction:{kind:'permission',requestId:'scene-permission',agentSessionId:'reaction-agent',run:{runId:'scene-run'},title:'Confirmation remains explicit',source:'hook',options:[]} as never}
useAppStore.setState({config,sessions:[session],agentSteerQueues:{},agentComposerDrafts:{'reaction-agent':'我的草稿不会被快捷回复改掉'},agentNames:{'reaction-agent':'Interface'}})
api.config.get=async()=>useAppStore.getState().config!
function Scene(){
 const [view,setView]=useState('conversation')
 const current=useAppStore(state=>state.config!)
 const renderMessageActions=useConversationReactions('reaction-agent',view==='conversation')
 return <DesktopClientUiProvider><main className="reaction-scene">
 <header className="reaction-scene__header"><strong>Interface</strong><span>AgentMux · Conversation</span><nav>
 <button onClick={()=>setView('conversation')}>Conversation</button><button onClick={()=>setView('settings')}>Prompts</button>
 <button onClick={()=>{const entry=useAppStore.getState().agentSteerQueues['reaction-agent']?.[0];if(entry)useAppStore.setState({agentSteerQueues:{'reaction-agent':[{...entry,status:'failed',error:'投递结果尚未确认。请在发件箱检查这次原操作。'}]}})}}>Inspect failure</button>
 </nav></header>
 {view==='settings'?<section className="reaction-scene__settings"><ShortcutSettingsPane config={current} active onSave={async(prompts)=>{useAppStore.setState({config:{...current,composerShortcuts:prompts}})}} /></section>:
 <section className="reaction-scene__conversation">
 <ConversationMessage messageId="question" conversationSessionId="reaction-agent" speaker={{role:'human',id:'human'}} name="You" content="回复卡片能直接给 Agent 一点反馈吗？保持紧凑，我不想丢掉原来的草稿。" createdAt={_hygiene_fixtureTime(24100980000)} />
 <ConversationNativeThread sessionId="reaction-agent" page={{agentSessionId:'reaction-agent',source:{providerId:'codex',nativeSessionId:'recorded-scene'},nextCursor:null,items:[{id:'answer',kind:'assistant-message',startedAt:_hygiene_fixtureTime(24101000000),contentParts:[{kind:'text',text:'可以。这里的三个 SVG 对应认可、继续和解释。\n\n悬停会显示完整含义；点击会作为新消息加入原发件箱，权限请求仍然需要明确确认。'}]}]}} describeSpeaker={()=>({name:'Interface',providerId:'codex'})} renderMessageActions={renderMessageActions} />
 <footer className="reaction-scene__draft">{useAppStore.getState().agentComposerDrafts['reaction-agent']}</footer>
 </section>}
 </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
