import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { PROMPT_REACTION_STARTERS, type ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { injectedContextCore } from './helpers/injected-context-core'
import { composerDOM } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useConversationReactions } from '../src/renderer/src/lib/conversation-reactions'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { unwrapSessionInputOperationResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
const dom=composerDOM()
const source:ConversationReplySource={kind:'captured',agentSessionId:control.agentSessionId,recordId:'original-assistant'}
function Reply(){const actions=useConversationReactions(control.agentSessionId,true);return <ConversationMessage messageId={source.recordId} conversationSessionId={control.agentSessionId} speaker={{role:'agent',id:control.agentSessionId}} name="Builder" content="The original answer" messageActions={actions(source)} />}
it('actual card, original Queue, preload, trusted registered IPC and Main submit to the public Core durable owner',async()=>{
 const root=await mkdtemp(join(tmpdir(),'amux-reaction-ipc-'))
 const f=await injectedContextCore(root,{kind:'agent',agentSessionId:control.agentSessionId,providerId:'traex',executorId:'private',hostId:'local',workspacePath:root,run:control.run,retiredRuns:[],createdAt:1,updatedAt:1,hookBindingId:'private-binding',hookToken:'private-token'})
 const config={...structuredClone(DEFAULT_CONFIG),composerShortcuts:[...PROMPT_REACTION_STARTERS],executors:{private:{providerId:'traex',label:'Private',command:'traex',args:[],env:{},injectAgentMuxGuide:false}}}
 const b=await owningBridge({client:f.core,store:f.store,config})
 try{
  vi.spyOn(api.config,'get').mockResolvedValue(config);vi.spyOn(api.sessions,'refresh').mockImplementation((...args)=>bridge.api!.sessions.refresh(...args));vi.spyOn(api.sessions,'submitPrompt').mockImplementation((...args)=>bridge.api!.sessions.submitPrompt(...args).then(unwrapSessionInputWriteResult));vi.spyOn(api.continuousProgress,'pauseForInput').mockResolvedValue()
  vi.spyOn(api.sessions,'inspectInput').mockImplementation((...args)=>bridge.api!.sessions.inspectInput(...args).then(unwrapSessionInputOperationResult))
  const recipient=await bridge.api!.sessions.refresh(control)
  useAppStore.setState({config,sessions:[recipient],agentSteerQueues:{},agentComposerDrafts:{[control.agentSessionId]:'Keep the exact draft'}})
  await dom.render(<Reply />);await dom.click('[aria-label="回复：认可"]');await act(async()=>useAppStore.getState().flushAgentSteerQueue(control.agentSessionId))
  await vi.waitFor(async()=>{
   const recorded=(await new AgentMuxFileAgentSessionStore(f.store.path).loadTimeline(control.agentSessionId)).items
   expect(recorded.filter(item=>item.kind==='user_message'),JSON.stringify(useAppStore.getState().agentSteerQueues[control.agentSessionId])).toHaveLength(1)
   expect(f.requests).toHaveLength(1);expect(f.writes).toHaveLength(1)
  })
  const user=(await new AgentMuxFileAgentSessionStore(f.store.path).loadTimeline(control.agentSessionId)).items.filter(item=>item.kind==='user_message')
  expect(user).toHaveLength(1);expect(user[0]).toMatchObject({authorHuman:true,content:PROMPT_REACTION_STARTERS[0]!.body,sourceChannel:'reaction'})
  expect(f.requests).toHaveLength(1);expect(f.writes[0]).toContain('&lt;amux:reaction ok /&gt;');expect(f.writes[0]).toContain(source.recordId)
  expect(bridge.invoke.mock.calls.filter(call=>call[0]==='sessions:submitPrompt')).toHaveLength(1)
  expect(dom.draft(control.agentSessionId)).toBe('Keep the exact draft');expect(f.start).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()
  const writes=[...f.writes],pauseCalls=b.pauseTarget.mock.calls.length
  const handler=bridge.handlers.get('sessions:submitPrompt')!;expect(handler).toBeTypeOf('function')
  await expect(handler({sender:{}},control,'forged reaction','forged-operation',{expectedRun:control.run,afterSubmissionId:null},undefined,true,'forged source','reaction')).resolves.toMatchObject({ok:false,error:{code:'SESSION_INPUT_FAILED',message:'Untrusted manual prompt sender'}})
  expect(f.writes).toEqual(writes);expect(b.pauseTarget.mock.calls).toHaveLength(pauseCalls)
 }finally{await b.dispose();await f.dispose();await rm(root,{recursive:true})}
})
