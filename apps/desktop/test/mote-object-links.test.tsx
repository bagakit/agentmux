// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseAmuxObjectLink } from '../../../packages/core/src/sharing'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteTopics, defaultAgent, defaultTab, neighborAgent, scratchWorkspace } from './fixtures/mote-workface'
import { SpaceObjectContextMenu } from '../src/renderer/src/components/SpaceObjectContextMenu'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import { originalMoteLinkBridge } from './fixtures/mote-link-bridge'
import { copyMoteAddress } from '../src/renderer/src/lib/mote-address-copy'
let app:MoteAppFixture|undefined
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{await app?.dispose();app=undefined;for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
const button=(root:ParentNode,label:string)=>[...root.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(node=>node.textContent?.trim()===label||node.getAttribute('aria-label')===label)!
async function fixture(){
 app=createMoteApp();const root=await mkdtemp(join(tmpdir(),'mote-copy-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
 const store=new AgentMuxSpatialStateStore(join(root,'spatial.json')),graph=desktopSpatialGraph(useAppStore.getState(),moteTopics);await store.commit({expectedRevision:0,graph})
 const spaceId=graph.spaces.find(space=>space.kind==='mote'&&space.topicId===moteTopics[0]!.id)!.spaceId,runtimeId='OriginalRuntime'
 const source={runtimeId,ownerInstanceId:'OriginalOwner'}
 const service=new AgentMuxRpcService({spatialState:store,hostedRuntime:()=>({call:async()=>({owner:source}),assertFence:(fence:any)=>{if(fence.runtimeId!==source.runtimeId||fence.ownerInstanceId!==source.ownerInstanceId)throw new AgentMuxError('Original Runtime changed','RUNTIME_OWNER_MISMATCH')}}) as never,execute:request=>useAppStore.getState().executeControl(request)});cleanup.push(()=>service.dispose())
 const context={principal:{kind:'user' as const,id:'original-person'},transport:'unix' as const}
 const bridge=originalMoteLinkBridge(async(method,input)=>method==='runtime.owner.identity'?{owner:source}:await service.call(method as any,input,context))
 const publish=vi.spyOn(api.spatial,'ensureLink').mockImplementation(bridge.ensureLink)
 const clipboard=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined)
 return{store,spaceId,runtimeId,source,service,context,publish,clipboard}
}
it('both original mounted Copy controls publish exact root/thread tuples through the real spatial owner before clipboard',async()=>{
 const f=await fixture(),main={hostId:'local',sessionId:defaultAgent.id,displayWorkspaceId:scratchWorkspace.id,groupId:'mote-group',tabId:defaultTab.id,regionId:defaultTab.layout.activeRegionId}
 const topics=moteTopics.map((topic,i)=>i?topic:{...topic,quickMode:{status:'saved' as const,version:'original',defaults:{conversation:main}}})
 useAppStore.setState({scratchTopicSnapshots:{[scratchWorkspace.id]:{scope:scratchTopicsScope(scratchWorkspace),topics,revision:0,error:null,reading:false}}})
 vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
 const eventId='/private/original/event'
 vi.spyOn(api.moteDialogue,'read').mockImplementation(async(input:any)=>({main:{target:input.target,identity:{hostId:'local',moteId:moteTopics[0]!.id},status:'ready',resource:null,documentRevision:'original',roleRevision:'original-role',current:main,issue:null},links:[{kind:'work',sequence:1,eventId,identity:{hostId:'local',moteId:moteTopics[0]!.id},operationId:'original-link',associatedAt:1,mainRoleRevision:'original-role',main:{hostId:'local',agentSessionId:defaultAgent.id},origin:{hostId:'local',messageId:'original-message',threadId:'original-thread',senderSessionId:defaultAgent.id,recipientSessionId:neighborAgent.id,createdAt:1}}],incarnation:'original',throughSequence:1,next:null,coverage:'linked-sources-only',sourceStatus:'read',sourceIssue:null}))
 vi.spyOn(api.sessions,'dispatch').mockResolvedValue({hostId:'local',source:{envelope:{body:'Original retained work',messageId:'original-message',threadId:'original-thread',senderSessionId:defaultAgent.id,recipientSessionId:neighborAgent.id}},dispatch:{sourceMessageId:'original-message',events:[]},replies:[],identityDiagnostics:[]} as any)
 vi.spyOn(api.motePreferences,'read').mockResolvedValue({status:'unconfirmed',issue:'Read-only original preferences',source:null,choices:{executors:[],conversations:[],destinations:[]},defaults:{},maintenance:{status:'unconfirmed',schedule:null,issue:null}} as any)
 vi.spyOn(api.moteDialogue,'inspectRecovery').mockResolvedValue({operation:null} as any)
 vi.spyOn(api.files,'readDirectory').mockResolvedValue([])
 const before=structuredClone(useAppStore.getState().agentComposerDrafts)
 await app!.mount(createElement(SpaceObjectContextMenu,{target:{kind:'mote',key:f.spaceId,name:'Original Mote'},children:createElement('button',{'data-public-copy-trigger':true},'Original object menu')}))
 const trigger=document.querySelector<HTMLElement>('[data-public-copy-trigger]')!
 await act(async()=>{trigger.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:20,clientY:20}))});await settleMoteApp()
 await moteClick(button(document,'Copy Mote link'));await vi.waitFor(()=>expect(f.clipboard).toHaveBeenCalledTimes(1))
 await act(async()=>requestPmoTeamsTopicFloatingOpen({targetTopicId:moteTopics[0]!.id}));await settleMoteApp()
 await moteClick(button(app!.panel(),'工作'))
 const card=app!.panel().querySelector<HTMLElement>('[data-mote-work-event]')!;expect(card).not.toBeNull()
 const expand=card.querySelector<HTMLButtonElement>('button')!;await moteClick(expand)
 await vi.waitFor(()=>expect(button(app!.panel(),'复制 thread 链接')).toBeDefined())
 await moteClick(button(app!.panel(),'复制 thread 链接'));await vi.waitFor(()=>expect(f.clipboard).toHaveBeenCalledTimes(2))
 expect(f.publish.mock.calls.map(([input])=>({spaceId:input.spaceId,eventId:input.eventId}))).toEqual([{spaceId:f.spaceId,eventId:undefined},{spaceId:f.spaceId,eventId}])
 const urls=f.clipboard.mock.calls.map(([url])=>url)
 for(let i=0;i<urls.length;i++){const parsed=parseAmuxObjectLink(urls[i]!)!;expect(parsed).toMatchObject({kind:'mote',address:{runtimeId:f.runtimeId}});expect(urls[i]).not.toContain('%2F');const target=await f.store.resolveSpaceLink((parsed as any).address);expect(target).toEqual({runtimeId:f.runtimeId,spaceId:f.spaceId,...(i?{eventId}:{})})}
 expect(urls[0]).not.toBe(urls[1]);expect(useAppStore.getState().agentComposerDrafts).toEqual(before)
 expect(app!.launch).not.toHaveBeenCalled();expect(app!.send).not.toHaveBeenCalled();expect(app!.stop).not.toHaveBeenCalled()
})
it('unknown publication or misbound acknowledgement cannot Copy a path fallback or stale address',async()=>{
 const f=await fixture(),report=vi.fn();f.publish.mockRejectedValueOnce(Error('Original write ACK unavailable'))
 expect(await copyMoteAddress({spaceId:f.spaceId},report)).toBe(false);expect(f.clipboard).not.toHaveBeenCalled();expect(report).toHaveBeenCalledTimes(1)
 const issued=await f.service.call('space.link.ensure',{target:{runtimeId:f.runtimeId,spaceId:f.spaceId},operationId:'original'},f.context)
 f.publish.mockResolvedValueOnce({...issued,operationId:'another-original'})
 expect(await copyMoteAddress({spaceId:f.spaceId},report)).toBe(false);expect(f.clipboard).not.toHaveBeenCalled();expect(report).toHaveBeenCalledTimes(2)
 expect(f.publish.mock.calls[1]![0].operationId).toBe(f.publish.mock.calls[0]![0].operationId)
})
it('original public Core app.focus and native URI ingress resolve the exact same retained Mote, preserving workface and input',async()=>{
 const f=await fixture();await app!.mount();const issued=await f.service.call('space.link.ensure',{target:{runtimeId:f.runtimeId,spaceId:f.spaceId},operationId:'original-focus'},f.context)
 const original=useAppStore.getState(),drafts=structuredClone(original.agentComposerDrafts),sessions=original.sessions
 const target=parseAmuxObjectLink(issued.url) as any,result=await f.service.call('app.focus',{target,inputPolicy:'preserve'},f.context)
 expect(result.navigation.moteLink?.target).toEqual(issued.target);expect(result.navigation.requested).toEqual(target)
 expect(result.navigation.selection.space?.spaceId).toBe(f.spaceId)
 expect(()=>parseRpcControlResult('app.focus',{...result,navigation:{...result.navigation,state:'unconfirmed',moteLink:{...result.navigation.moteLink!,address:{...issued.address,runtimeId:'WrongRuntime'}}}},{target,inputPolicy:'preserve'})).toThrow()
 expect(()=>parseRpcControlResult('app.focus',{...result,navigation:{...result.navigation,state:'applied',moteLink:{...result.navigation.moteLink!,target:{...issued.target,spaceId:'wrong-original'}}}},{target,inputPolicy:'preserve'})).toThrow()
 const ingress=new SpatialLinkIngress(),seen:any[]=[],focusMote=vi.fn(async(request:any,signal:any)=>({operation:'focus' as const,...await f.service.call('app.focus',{target:request.target,inputPolicy:request.inputPolicy,operationId:request.requestId},{...f.context,signal})}));ingress.ready(async request=>{seen.push(request);return await useAppStore.getState().executeControl(request)},vi.fn(),undefined,{focusMote,locate:async()=>{throw Error('No route creation')},openCapsule:async()=>{throw Error('No Capsule')}})
 await ingress.receive(issued.url)
 expect(seen).toHaveLength(0);expect(focusMote).toHaveBeenCalledTimes(1);expect(focusMote.mock.calls[0]![0].target).toEqual({kind:'mote',address:issued.address})
 expect(useAppStore.getState().workbenchSpaceSelection?.spaceId).toBe(f.spaceId);expect(useAppStore.getState().sessions).toEqual(sessions);expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts)
 expect(app!.launch).not.toHaveBeenCalled();expect(app!.send).not.toHaveBeenCalled();expect(app!.stop).not.toHaveBeenCalled()
})
it('opaque URI opening keeps the typed address at its original Core and unavailable authority never navigates',async()=>{
 const f=await fixture(),issued=await f.service.call('space.link.ensure',{target:{runtimeId:f.runtimeId,spaceId:f.spaceId},operationId:'original'},f.context),execute=vi.fn(),report=vi.fn(),ingress=new SpatialLinkIngress()
 ingress.ready(execute,report)
 expect(await ingress.receive(issued.url)).toContain('original Mote address authority is unavailable');expect(execute).not.toHaveBeenCalled()
 const focusMote=vi.fn(async(_request:any,_signal:any)=>{throw Error('Original address read unavailable')})
 ingress.ready(execute,report,undefined,{focusMote,locate:async()=>{throw Error('No route')},openCapsule:async()=>{throw Error('No Capsule')}})
 expect(await ingress.receive(issued.url)).toContain('Original address read unavailable');expect(execute).not.toHaveBeenCalled()
 expect(focusMote.mock.calls[0]?.[0]).toMatchObject({target:{kind:'mote',address:issued.address}})
})
it('a Runtime change after the original resolve cannot reach the focus consumer or take a later workface',async()=>{
 const f=await fixture(),issued=await f.service.call('space.link.ensure',{target:{runtimeId:f.runtimeId,spaceId:f.spaceId},operationId:'original'},f.context),original=f.service.call.bind(f.service),consume=vi.spyOn(useAppStore.getState(),'executeControl')
 vi.spyOn(f.service,'call').mockImplementation(async(method:any,input:any,context:any)=>{const result=await original(method,input,context);if(method==='space.link.resolve')f.source.runtimeId='LaterRuntime';return result as any})
 const before=useAppStore.getState().workbenchSpaceSelection
 await expect(original('app.focus',{target:{kind:'mote',address:issued.address},inputPolicy:'preserve'},f.context)).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
 expect(consume).not.toHaveBeenCalled();expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before)
})

it('the original Main publication keeps its frozen Runtime and operation through an unknown ACK and explicit retry',async()=>{
 const f=await fixture(),calls:any[]=[];let runtimeId=f.runtimeId,loseAck=true
 const bridge=originalMoteLinkBridge(async(method,input)=>{
  if(method==='runtime.owner.identity')return{owner:{runtimeId,ownerInstanceId:'original-owner'}}
  calls.push(structuredClone(input))
  if(loseAck){loseAck=false;throw Error('Original write ACK unavailable')}
  return f.service.call(method as any,input,f.context)
 })
 const request={spaceId:f.spaceId,operationId:'original-retry'}
 await expect(bridge.ensureLink(request)).rejects.toThrow('Original write ACK unavailable')
 runtimeId='OtherRuntime';f.source.runtimeId=runtimeId
 await expect(bridge.ensureLink(request)).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
 f.source.runtimeId=f.runtimeId
 const retried=await bridge.ensureLink(request);expect(retried.target.runtimeId).toBe(f.runtimeId)
 expect(calls).toHaveLength(3);expect(calls[1]).toEqual(calls[0]);expect(calls[2]).toEqual(calls[0]);expect(calls[0].operationId).toBe(request.operationId)
})
