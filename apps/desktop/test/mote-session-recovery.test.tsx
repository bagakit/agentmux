// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { createMoteApp, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { neighborAgent, neighborTab, customAgent, customTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { beginMoteStartupRecovery, deferScratchConversationRecovery, recoverMoteConversationAtStartup, recoverScratchConversationsAtStartup, moteSessionStartupMode } from '../src/renderer/src/lib/mote-session-recovery'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import type { MoteQuickDefaults } from '../src/shared/mote-quick-mode'

let app:MoteAppFixture,release:()=>void,host:HTMLDivElement,root:ReturnType<typeof createClientUiRoot>
const originalRecover=useAppStore.getState().recoverSession
const ref={hostId:'local',sessionId:neighborAgent.control.agentSessionId,displayWorkspaceId:SCRATCH_WORKSPACE_ID,groupId:'mote-group',tabId:neighborTab.id,regionId:'neighbor-region'}
const ended={...neighborAgent,processState:'exited' as const}
function topics(values:MoteQuickDefaults| 'unknown') {
  const result=moteTopics.map(topic=>({...topic,quickMode:topic.id===PMO_TEAMS_TOPIC_ID ? values==='unknown' ? {status:'unconfirmed' as const,message:'Original MOTE read unavailable'} : {status:'saved' as const,defaults:values,version:'original-file'} : {status:'missing' as const}}))
  vi.mocked(api.scratch.listTopics).mockResolvedValue(result)
  vi.mocked(api.scratch.readTopic).mockImplementation(async(_workspace,id)=>result.find(value=>value.id===id)??null)
  useAppStore.setState({scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(scratchWorkspace),revision:1,topics:result,error:null,reading:false}}})
  return result
}
beforeEach(()=>{
 app=createMoteApp();release=beginMoteStartupRecovery()
 useAppStore.setState({recoverSession:originalRecover,sessions:useAppStore.getState().sessions.map(s=>s.id===ended.id?ended:s)})
 vi.spyOn(api.sessions,'recover').mockResolvedValue({kind:'resumed',session:{...neighborAgent,control:{...neighborAgent.control,run:{runId:'unwanted-renderer-resume'}}}})
 host=document.createElement('div');document.body.append(host);root=createClientUiRoot(host)
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();release();await app.dispose()})
describe('Host-owned Mote main continuity',()=>{
 it.each([
  ['legacy main',{conversation:ref,recovery:'startup'}],
  ['disabled',{conversation:ref,presence:{enabled:false,intervalMs:1800000}}],
  ['original paused arrangement',{conversation:ref,presence:{enabled:true,intervalMs:1800000}}],
  ['saved original occurrence unavailable',{conversation:{...ref,groupId:'missing-original-group'}}],
  ['unconfirmed source','unknown']
 ] as const)('actual startup and mounted open retain %s without Renderer recovery',async(_label,defaults)=>{
   topics(defaults)
   const before=useAppStore.getState(),drafts=structuredClone(before.agentComposerDrafts),bindings=JSON.stringify(before.tabs)
   expect(deferScratchConversationRecovery(before.tabs,before.config,ended.id,before.sessions)).toBe(true)
   await recoverScratchConversationsAtStartup();await recoverMoteConversationAtStartup(ended)
   await act(async()=>root.render(createElement(MoteWorkface,{workspaceId:SCRATCH_WORKSPACE_ID,topicId:PMO_TEAMS_TOPIC_ID,visible:true,children:createElement('p',null,'Retained original content')})))
   await settleMoteApp()
   expect(host.textContent).toContain('Retained original content')
   expect(api.sessions.recover).not.toHaveBeenCalled();expect(app.launch).not.toHaveBeenCalled();expect(app.send).not.toHaveBeenCalled()
   expect(useAppStore.getState().sessions.find(s=>s.id===ended.id)?.control).toEqual(ended.control)
   expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts);expect(JSON.stringify(useAppStore.getState().tabs)).toBe(bindings)
 })
 it('settling the original unknown MOTE read and reopening never creates another lifecycle owner',async()=>{
   topics('unknown');await recoverScratchConversationsAtStartup();topics({conversation:ref,recovery:'startup'})
   await recoverMoteConversationAtStartup(ended)
   expect(moteSessionStartupMode(useAppStore.getState(),ended)).toBe('host-managed')
   expect(api.sessions.recover).not.toHaveBeenCalled()
 })
 it('Mote members remain on demand while ordinary non-Mote recovery keeps its original public path',async()=>{
   topics({conversation:ref})
   const member={...customAgent,processState:'exited' as const}
   useAppStore.setState({sessions:useAppStore.getState().sessions.map(s=>s.id===member.id?member:s)})
   await recoverMoteConversationAtStartup(member);expect(api.sessions.recover).not.toHaveBeenCalled()
   const ordinary={...moteTopics[1]!,id:'view:ordinary-topic',kind:'topic' as const,quickMode:{status:'missing' as const}}
   useAppStore.setState({tabs:{...useAppStore.getState().tabs,[customTab.id]:{...customTab,topicId:ordinary.id}},scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(scratchWorkspace),revision:2,topics:[ordinary],error:null,reading:false}}})
   vi.mocked(api.sessions.recover).mockResolvedValue({kind:'resumed',session:{...customAgent,control:{...customAgent.control,run:{runId:'ordinary-original-restored'}}}})
   await recoverMoteConversationAtStartup(member)
   expect(api.sessions.recover).toHaveBeenCalledOnce();expect(api.sessions.recover).toHaveBeenCalledWith(member.control,member.workspacePath,expect.any(String),expect.objectContaining({trigger:'startup'}))
 })
})
