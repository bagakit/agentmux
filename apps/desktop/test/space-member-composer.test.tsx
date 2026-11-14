// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()}}))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { handoffOriginalMemberComposerInput, useAppStore } from '../src/renderer/src/store'
import { spaceMountKey, type SpaceMountMemberTarget } from '../src/shared/space-mount'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { RuntimeController } from '../src/main/runtime-controller'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'
import { SourceComposerRecovery } from '../src/renderer/src/components/SourceComposerRecovery'
import { WORKBENCH_USER_STATE_KEY } from '../src/renderer/src/lib/workbench-user-storage'

const dom=composerDOM(),cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(){
 const f=await createSpaceSessionsFixture(cleanup),sid='original-composer'
 f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
 const session=await f.d.put(sid),admitted=await f.admit('D-in-B',f.d.owner.runtimeId,sid,'original-composer-create')
 const main=spaceMountTransport(cleanup,[{id:'original-b-route',carrier:{forwardRpc:f.b.rpc.call.bind(f.b.rpc),subscribeRpc:f.b.rpc.subscribe.bind(f.b.rpc)}}],structuredClone(DEFAULT_CONFIG))
 const target:SpaceMountMemberTarget={hostId:'original-b-route',target:{reference:f.reference,regionId:admitted.address.regionId,runtimeId:f.d.owner.runtimeId,agentSessionId:sid,expectedRun:session.run}}
 vi.spyOn(api.spaceMounts,'member').mockImplementation(main.api.member)
 const surface=await main.api.member(target,()=>{});cleanup.push(()=>surface.dispose())
 const key=spaceMountKey(f.reference),tabId=admitted.address.tabId,zoneId=admitted.address.zoneId
 if(!zoneId)throw Error('Expected the admitted original Zone')
 if(!tabId)throw Error('Expected the admitted original Tab')
 useAppStore.getState().mountSpace({hostId:target.hostId,reference:f.reference,zoneId,workspaceId:'original-b-project'})
 return{...f,main,zoneId,session,target,surface,key,tabId}
}
it('the shared document checkpoints the canonical copy before pruning old input, and a failed save can reenter without dispatch', async()=>{
 cleanup.push(await useAppStore.getState().initialize())
 const f=await fixture(),member={...f.target,target:{...f.target.target,expectedAdmission:{kind:'creation' as const,operationId:'original-composer-create'}}}
 const owner=originalSourceInputOwnerKey(member.target.runtimeId,member.target.agentSessionId),operationId='retained-source-operation'
 const original={target:member,request:{operationId,prompt:'Original unsent bytes 中',binding:{expectedRun:member.target.expectedRun,admissionIntent:{kind:'manual-actor' as const}}},
   submitted:true,response:promptCarrierWaiting(member.target.agentSessionId,member.target.expectedRun.runId,operationId)}
 const bucket=JSON.stringify([member.hostId,member.target.reference.runtimeId,member.target.reference.spaceId,member.target.regionId,member.target.runtimeId,member.target.agentSessionId])
 useAppStore.setState(state=>({mountedSpaceInputs:{...state.mountedSpaceInputs as Record<string,unknown>,[f.key]:{target:{hostId:member.hostId,reference:member.target.reference,zoneId:f.zoneId,workspaceId:'original-b-project'},drafts:{},memberInputs:{[bucket]:{[operationId]:original}}}}}))
 const submit=vi.spyOn(api.sessions,'submitPrompt'),nativeSet=window.localStorage.setItem.bind(window.localStorage)
 const save=vi.spyOn(window.localStorage,'setItem').mockImplementationOnce(()=>{throw Error('Original document write failed')})
 await expect(handoffOriginalMemberComposerInput(member,f.tabId)).rejects.toThrow('Original document write failed')
 expect((useAppStore.getState().mountedSpaceInputs as any)[f.key]?.memberInputs?.[bucket]?.[operationId]).toEqual(original)
 expect(useAppStore.getState().agentSteerQueues[owner]).toHaveLength(1)
 const copies:Array<any>=[]
 save.mockImplementation((name,value)=>{if(name===WORKBENCH_USER_STATE_KEY)copies.push(JSON.parse(value).state);nativeSet(name,value)})
 await handoffOriginalMemberComposerInput(member,f.tabId)
 expect(copies.some(state=>state.agentSteerQueues?.[owner]?.[0]?.operationId===operationId&&state.mountedSpaceInputs?.[f.key]?.memberInputs?.[bucket]?.[operationId])).toBe(true)
 expect(copies.at(-1).mountedSpaceInputs[f.key]).not.toHaveProperty('memberInputs')
 expect(useAppStore.getState().agentSteerQueues[owner]).toHaveLength(1)
 expect(useAppStore.getState().agentSteerQueues[owner]![0]).toMatchObject({awaitingExplicitSend:true,inputReceipt:original.response,recoveredSourceInput:original})
 const hosts=new Map([['original-b-route',{client:{forwardRpc:f.b.rpc.call.bind(f.b.rpc),subscribeRpc:f.b.rpc.subscribe.bind(f.b.rpc)}}]])
 const runtime=Object.assign(Object.create(RuntimeController.prototype),{hosts,hostOperations:new Map(),hostReconfigurationReservations:new Set()}) as RuntimeController
 vi.spyOn(api.sessions,'inspectInput').mockImplementation((route,key)=>runtime.inspectInput(route,key))
 const inspected=vi.spyOn(f.d.core,'inspectAgentInput').mockResolvedValue(null)
 await expect(useAppStore.getState().sendQueuedAgentSteer(owner,operationId)).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
 expect(inspected).toHaveBeenCalledWith({key:original.response.key})
 expect(submit).not.toHaveBeenCalled()
 // A failed read must not turn an original known-unsent request into unknown dispatch.
 const unsent={target:member,request:{...original.request,operationId:'known-unsent-operation'},submitted:false}
 useAppStore.setState(state=>({mountedSpaceInputs:{...state.mountedSpaceInputs as Record<string,unknown>,[f.key]:{
   ...(state.mountedSpaceInputs as any)[f.key],memberInputs:{[bucket]:{[unsent.request.operationId]:unsent}}}}}))
 await handoffOriginalMemberComposerInput(member,f.tabId)
 vi.mocked(api.sessions.inspectInput).mockRejectedValueOnce(Error('Original observer unavailable'))
 await expect(useAppStore.getState().sendQueuedAgentSteer(owner,unsent.request.operationId)).rejects.toThrow('Original observer unavailable')
 expect(useAppStore.getState().agentSteerQueues[owner]!.find(entry=>entry.operationId===unsent.request.operationId)!.inputIntakeStarted).toBeUndefined()
 inspected.mockRestore()
 submit.mockImplementation((route,prompt,operationId,condition,choice,human,note,channel,_continuation,_pmo,_dispatch,capture,images)=>runtime.submitPrompt(route,prompt,operationId,condition,undefined,choice,human,note,channel,capture,images))
 await useAppStore.getState().sendQueuedAgentSteer(owner,unsent.request.operationId)
 expect(submit).toHaveBeenCalledOnce()
 // Retained history is not a capacity condition for an independent new message.
 const historical=Object.fromEntries(Array.from({length:100},(_,index)=>{
   const operationId=`historical-original-${index}`
   return[operationId,{target:member,request:{...original.request,operationId},submitted:true}]
 }))
 useAppStore.setState(state=>({mountedSpaceInputs:{...state.mountedSpaceInputs as Record<string,unknown>,[f.key]:{
   ...(state.mountedSpaceInputs as any)[f.key],memberInputs:{[bucket]:historical}}}}))
 await handoffOriginalMemberComposerInput(member,f.tabId)
 expect(useAppStore.getState().agentSteerQueues[owner]!.filter(entry=>entry.recoveredSourceInput!==undefined)).toHaveLength(102)
 const session=await f.surface.call('read',{})
 expect(useAppStore.getState().send(owner,'Independent new message',undefined,'manual',undefined,{execution:'immediate',originalMember:member,originalSession:session})).toBe(true)
 await vi.waitFor(()=>expect(submit).toHaveBeenCalledTimes(2))
 await vi.waitFor(()=>expect(useAppStore.getState().agentSteerInFlight[owner]).toBeUndefined())
 expect(submit.mock.calls.map(call=>call[1])).toEqual([unsent.request.prompt,'Independent new message'])
 const historyEntry=useAppStore.getState().agentSteerQueues[owner]!.find(entry=>entry.operationId==='historical-original-0')!
 const {recoveredSourceInput:_raw,inputIntakeStarted:_intake,...ordinary}=historyEntry
 const ordinaryRestore={...ordinary,operationId:'ordinary-source-restore',archived:true as const}
 useAppStore.setState(state=>({agentSteerQueues:{...state.agentSteerQueues,[owner]:[...state.agentSteerQueues[owner]!,ordinaryRestore]}}))
 const ordinaryResult=await useAppStore.getState().archiveAgentSteer(owner,ordinaryRestore.operationId,ordinaryRestore.text,false)
   .then(value=>({value}),error=>({error}))
 expect(ordinaryResult).toMatchObject({value:{changed:true,entry:{operationId:ordinaryRestore.operationId,awaitingExplicitSend:true}}})
 useAppStore.setState(state=>({agentSteerQueues:{...state.agentSteerQueues,[owner]:[
   ...Array.from({length:100},(_,index)=>({...ordinary,operationId:'independent-active-'+index})),{...historyEntry,archived:true as const}]}}))
 const recoveredResult=await useAppStore.getState().archiveAgentSteer(owner,historyEntry.operationId,historyEntry.text,false)
   .then(value=>({value}),error=>({error}))
 expect(recoveredResult).toMatchObject({value:{changed:true,entry:{operationId:historyEntry.operationId,awaitingExplicitSend:true}}})
 expect(submit).toHaveBeenCalledTimes(2)
})

it('position-only saved drafts remain visible and fill the current draft only after an explicit edit', async()=>{
 const f=await fixture(),owner=originalSourceInputOwnerKey(f.target.target.runtimeId,f.target.target.agentSessionId),text='Position-only original draft'
 const draftKey=JSON.stringify([f.target.target.reference.runtimeId,f.target.target.reference.spaceId,f.tabId,f.target.target.regionId])
 useAppStore.setState(state=>({agentComposerDrafts:{[owner]:'', [f.target.target.agentSessionId]:'Unrelated local draft'},mountedSpaceInputs:{...state.mountedSpaceInputs as Record<string,unknown>,
   [f.key]:{target:{hostId:f.target.hostId,reference:f.target.target.reference,zoneId:f.zoneId,workspaceId:'original-b-project'},drafts:{[draftKey]:text}}}}))
 const before=useAppStore.getState().mountedSpaceInputs,submit=vi.spyOn(api.sessions,'submitPrompt')
 await dom.render(<SourceComposerRecovery target={f.target} tabId={f.tabId}/>)
 expect(dom.container.textContent).toContain(text)
 expect(useAppStore.getState().agentComposerDrafts[owner]).toBe('')
 const append=Array.from(dom.container.querySelectorAll('button')).find(button=>button.textContent==='Append to current draft')!
 await act(async()=>append.click())
 expect(useAppStore.getState().agentComposerDrafts[owner]).toBe(text)
 expect(useAppStore.getState().agentComposerDrafts[f.target.target.agentSessionId]).toBe('Unrelated local draft')
 expect(useAppStore.getState().mountedSpaceInputs).toBe(before)
 expect(submit).not.toHaveBeenCalled()
})

it('an unconfirmed original Session keeps shared drafting, reference tools and outbox without allowing submission',async()=>{
 const f=await fixture(),owner=originalSourceInputOwnerKey(f.target.target.runtimeId,f.target.target.agentSessionId),text='Keep original unknown draft'
 useAppStore.setState({config:{...DEFAULT_CONFIG,messageToolInitialLayout:'two-line'},agentComposerDrafts:{[owner]:text},agentSteerQueues:{[owner]:[{operationId:'unknown-original-queue',promptCondition:null,enqueuedAt:1,runId:f.session.run.runId,text:'Original queued message',status:'deferred',awaitingExplicitSend:true,origin:'manual',freshComposerIntent:true}]}})
 await dom.render(<AgentSessionComposer sessionId={owner} source={{target:f.target}} visible pendingLayout={{boundaryRef:{current:null},readOverlapTop:()=>undefined,subscribe:()=>()=>{}}}/>)
 const editor=dom.container.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
 expect(editor.getAttribute('contenteditable')).toBe('true')
 expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Reference files for the Agent to read"]')?.disabled).toBe(false)
 expect(dom.container.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(true)
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Original queued message'))
})

it('the shared Composer submits through the frozen member route to the original Core without a second input ledger',async()=>{
 cleanup.push(await useAppStore.getState().initialize())
 const f=await fixture(),owner=originalSourceInputOwnerKey(f.target.target.runtimeId,f.target.target.agentSessionId),member={...f.target,target:{...f.target.target,
   expectedAdmission:{kind:'creation' as const,operationId:'original-composer-create'}}},session=await f.surface.call('read',{})
 const hosts=new Map([['original-b-route',{client:{forwardRpc:f.b.rpc.call.bind(f.b.rpc),subscribeRpc:f.b.rpc.subscribe.bind(f.b.rpc)}}]])
 const runtime=Object.assign(Object.create(RuntimeController.prototype),{hosts,hostOperations:new Map(),hostReconfigurationReservations:new Set()}) as RuntimeController
 // The production IPC inserts its internal automation argument before choice.
 vi.spyOn(api.sessions,'submitPrompt').mockImplementation((route,prompt,operationId,condition,choice,human,note,channel,_continuation,_pmo,_dispatch,capture,images)=>
   runtime.submitPrompt(route,prompt,operationId,condition,undefined,choice,human,note,channel,capture,images))
 vi.spyOn(api.sessions,'inspectInput').mockImplementation((route,key)=>runtime.inspectInput(route,key))
 vi.spyOn(api.sessions,'rejoinInputWaiting').mockImplementation((route,ref)=>runtime.rejoinInputWaiting(route,ref))
 vi.spyOn(api.sessions,'stopInputWaiting').mockImplementation((route,ref,operationId)=>runtime.stopInputWaiting(route,ref,operationId))
 const observer=vi.spyOn(f.b.core,'submitAgentPrompt').mockRejectedValue(Error('Observer-local same SID must not receive this input'))
 const original=vi.spyOn(f.d.core,'submitAgentPrompt')
 const mountedBefore=useAppStore.getState().mountedSpaceInputs
 useAppStore.setState({config:{...DEFAULT_CONFIG,messageToolInitialLayout:'two-line'},agentComposerDrafts:{[owner]:'Shared Source message through real Core'}})
 await dom.render(<AgentSessionComposer sessionId={owner} source={{target:member,session}} visible pendingLayout={{boundaryRef:{current:null},readOverlapTop:()=>undefined,subscribe:()=>()=>{}}}/>)
 await vi.waitFor(()=>expect(dom.container.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(false))
 await dom.click('.composer-send')
 await vi.waitFor(()=>expect(original).toHaveBeenCalledOnce())
 expect(original.mock.calls[0]![0]).toMatchObject({agentSessionId:f.target.target.agentSessionId,expectedRun:f.session.run,prompt:'Shared Source message through real Core',operationId:expect.any(String)})
 expect(observer).not.toHaveBeenCalled()
 expect(useAppStore.getState().mountedSpaceInputs).toEqual(mountedBefore)
 expect(useAppStore.getState().agentComposerDrafts[owner]??'').toBe('')
 await vi.waitFor(()=>expect(useAppStore.getState().agentSteerQueues[owner]![0]!.inputReceipt?.key)
   .toMatchObject({agentSessionId:f.target.target.agentSessionId,expectedRun:f.session.run}))
 const entry=useAppStore.getState().agentSteerQueues[owner]![0]!
 expect(entry.originalMember).toEqual(member)
 await vi.waitFor(()=>expect(useAppStore.getState().agentSteerInFlight[owner]).toBeUndefined())
 const inspect=vi.spyOn(f.d.core,'inspectAgentInput')
 await act(async()=>{await expect(useAppStore.getState().archiveAgentSteer(owner,entry.operationId,entry.text,true))
   .resolves.toMatchObject({entry:{archived:true}})})
 expect(inspect).toHaveBeenCalledWith({key:entry.inputReceipt!.key})
 expect(useAppStore.getState().agentSteerQueues[owner]![0]).toMatchObject({archived:true,originalMember:member})
 expect(observer).not.toHaveBeenCalled()
})
