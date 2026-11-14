import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mobileMemberDraftScope, mobileMemberSelection } from '../src/navigation/mobile-member-target'
import { MobileZoneWorkface } from '../src/navigation/MobileZoneWorkface'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import type { AgentMuxMemoryAgentSessionStore } from '../../../packages/core/src/agent-session-store'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { connectMobileMember } from '../src/conversation/mobile-member'
import { mobileCapability, hasMobileTerminal } from '../src/conversation/mobile-conversation-client'
import { mount, mounted, click, waitForElement } from './conversation-fixture'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
 for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
 for (const close of cleanups.splice(0).reverse()) await close()
 vi.restoreAllMocks()
})
const folder = resolve(process.env.MOBILE_MEMBER_PROOF ?? '.tmp/mobile-member-proof/attempt')
mkdirSync(folder,{recursive:true})
const statePath = resolve(process.env.MOBILE_MEMBER_DEVICE ?? folder + '/device.json')
function diskStorage() {
 let data: Record<string,string> = existsSync(statePath) ? JSON.parse(readFileSync(statePath,'utf8')) : {}
 const save = () => { mkdirSync(dirname(statePath),{recursive:true}); writeFileSync(statePath,JSON.stringify(data)) }
 const storage = { get length(){return Object.keys(data).length}, key:(i:number)=>Object.keys(data)[i] ?? null,
  getItem:(key:string)=>data[key] ?? null, setItem:(key:string,value:string)=>{data[key]=String(value);save()},
  removeItem:(key:string)=>{delete data[key];save()},clear:()=>{data={};save()} }
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage})
 Object.defineProperty(window,'localStorage',{configurable:true,value:storage})
 return storage
}
const platform = () => createBrowserPlatform({clipboard:{writeText:async()=>{}}})
const connection = {state:'connected' as const,message:'private original source'}
async function sourceClient(path:string,id:string) {
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path}});cleanups.push(()=>rpc.dispose())
 const client=await connectHostedAgentMux({rpc,connectOnDemand:true,agentSessionIds:[id],forwardRpc:(method,params,context)=>rpc.call(method,params,{...(context?.signal ? {signal:context.signal}:{}),...(context?.runtimeFence ? {runtimeFence:context.runtimeFence}:{})}),subscribeRpc:rpc.subscribe.bind(rpc)});cleanups.push(()=>client.dispose())
 await client.connect();return client
}
const wait = async (check:()=>void) => vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,10))});check()},{timeout:15000,interval:25})
async function child(env:Record<string,string>) {
 return await new Promise<{code:number|null;stdout:string;stderr:string}>(resolveChild=>{
  const cp=spawn(process.execPath,[resolve(dirname(createRequire(import.meta.url).resolve('vitest/package.json')),'vitest.mjs'),'run','--config',process.env.MOBILE_MEMBER_CONFIG ?? fileURLToPath(new URL('./mobile-member.config.mts',import.meta.url)),'--testNamePattern','second process'],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='';cp.stdout.on('data',v=>stdout+=v);cp.stderr.on('data',v=>stderr+=v);cp.on('exit',code=>resolveChild({code,stdout,stderr}))
 })
}

it.skipIf(process.env.MOBILE_MEMBER_REOPEN === '1')('actual MobileApp opens, reads and submits only to its original same-SID member and persists its source and draft', async()=>{
 diskStorage()
 const f=await createSpaceSessionsFixture(cleanups),sid='mobile-same-sid'
 await f.b.put(sid);const original=await f.d.put(sid),admission=await f.admit('D-in-B',f.d.owner.runtimeId,sid,'mobile-original-C')
 await f.b.spatial.settleAgentOpen(admission.requestId,original,{})
 for (const [owner,content] of [[f.b,'B namesake body must never replace D'],[f.d,'D ORIGINAL MEMBER BODY']] as const) {
  const store=Reflect.get(owner.core,'store') as AgentMuxMemoryAgentSessionStore
  await store.applyTimelineMutation({type:'append',agentSessionId:sid,item:{id:'original-'+owner.owner.runtimeId,agentSessionId:sid,kind:'assistant_message',source:'native-hook',status:'complete',title:'Original answer',content,createdAt:1,updatedAt:1}})
 }
 const source=await sourceClient(f.b.server.path,sid),observerRead=vi.spyOn(f.b.core,'readAgentConversation'),observerInput=vi.spyOn(f.b.core,'submitAgentPrompt')
 const input=vi.spyOn(f.d.core,'submitAgentPrompt').mockResolvedValue(undefined)
 const owner=getDeviceWorkface(),empty=emptyDeviceWorkface();await owner.replaceBackup({...empty,conversation:{...empty.conversation,drafts:[[JSON.stringify(['draft',sid]),'Retained original B draft']]},selectedSessionId:null,presentation:{primary:'space',showSession:false,showGoalWork:false,identity:null,profile:null,spatial:{spaceId:f.reference.spaceId,tabId:null,regionId:null}}})
 const view=await mount(<MobileApp client={source} connection={connection} platform={platform()} restoreWorkface />)
 let row: HTMLButtonElement
 try { row=await waitForElement<HTMLButtonElement>(view.element,'.mobile-agent-row__open') } catch(error) { writeFileSync(folder+'/missing-row.html',view.element.outerHTML); throw error }
 await click(row)
 await wait(()=>expect(view.element.textContent,'Original member body, never the Source namesake').toContain('D ORIGINAL MEMBER BODY'))
 expect(view.element.textContent).not.toContain('B namesake body must never replace D');expect(observerRead).not.toHaveBeenCalled()
 const selected=owner.snapshot().record.presentation!.identity!.member!
 expect(selected.target).toMatchObject({runtimeId:f.d.owner.runtimeId,expectedRun:original.run,expectedAdmission:{operationId:admission.requestId}})
 if(process.env.MOBILE_MEMBER_CAPTURE==='1'){
  const retained=await waitForElement<HTMLElement>(view.element,'[contenteditable="true"]')
  await act(async()=>{retained.textContent='Retained original D draft';retained.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Retained original D draft'}))})
  await wait(()=>expect(owner.snapshot().record.conversation.drafts.some(([,text])=>text==='Retained original D draft')).toBe(true))
  const input=folder+'/capture-input.json';writeFileSync(input,JSON.stringify({socket:f.b.server.path,record:owner.snapshot().record,memberObservationFault:process.env.MOBILE_MEMBER_CAPTURE_FAULT==='1'},null,2)+'\n')
  const capture=await new Promise<{code:number|null;stdout:string;stderr:string}>(done=>{const cp=spawn(process.execPath,[resolve(process.env.MOBILE_MEMBER_CAPTURE_SCRIPT ?? '.tmp/mobile-member-proof/capture/capture.mjs'),'--label',process.env.MOBILE_MEMBER_CAPTURE_LABEL ?? 'original-member','--input',input],{env:process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';cp.stdout.on('data',x=>stdout+=x);cp.stderr.on('data',x=>stderr+=x);cp.on('exit',code=>done({code,stdout,stderr}))})
  writeFileSync(folder+'/capture.stdout.log',capture.stdout);writeFileSync(folder+'/capture.stderr.log',capture.stderr)
  expect(capture.code,capture.stderr).toBe(0);return
 }

 const member=await connectMobileMember(source,selected);cleanups.push(()=>member.client.dispose())
 expect(hasMobileTerminal(member.client)).toBe(true)
 const terminalWrite=vi.spyOn(f.d.core,'writeAgent').mockResolvedValue({runId:original.run.runId,appliedByteRange:{startByte:0,endByte:4},acceptedThroughByte:4}),observerTerminal=vi.spyOn(f.b.core,'writeAgent')
 await mobileCapability(member.client,'writeAgent')({agentSessionId:sid,expectedRun:original.run,data:'ping',source:'user'})
 expect(terminalWrite).toHaveBeenCalledTimes(1);expect(observerTerminal).not.toHaveBeenCalled()
 await expect(mobileCapability(member.client,'writeAgent')({agentSessionId:sid,expectedRun:{runId:'other-run'},data:'wrong',source:'user'})).rejects.toMatchObject({code:'SPACE_MEMBER_TARGET_MISMATCH'})
 expect(terminalWrite).toHaveBeenCalledTimes(1)
 expect(()=>mobileCapability(member.client,'respondAgentInteraction')).toThrow('原目标尚未提供')
 await expect(connectMobileMember(source,{...selected,sourceRuntimeId:'different-source'})).rejects.toThrow('不是原 Source')
 const editor=await waitForElement<HTMLElement>(view.element,'[contenteditable="true"]')
 expect(editor.textContent).not.toContain('Retained original B draft')
 await act(async()=>{editor.textContent='Exact private member request';editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Exact private member request'}))})
 const send=await waitForElement<HTMLButtonElement>(view.element,'button[aria-label="Send"]');await click(send)
 await wait(()=>expect(input).toHaveBeenCalledTimes(1))
 expect(input.mock.calls[0]![0]).toMatchObject({agentSessionId:sid,expectedRun:original.run,prompt:'Exact private member request'})
 expect(observerInput).not.toHaveBeenCalled()
 await act(async()=>{editor.textContent='Retained original D draft';editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Retained original D draft'}))})
 await wait(()=>expect(JSON.stringify(JSON.parse(readFileSync(statePath,'utf8')))).toContain('Retained original D draft'))
 const before=readFileSync(statePath),hash=createHash('sha256').update(before).digest('hex')
 writeFileSync(folder+'/reopen-input.json',JSON.stringify({endpoint:f.b.server.path,sid,source:f.b.owner.runtimeId,execution:f.d.owner.runtimeId,sha256:hash,writerPid:process.pid}))
 const result=await child({MOBILE_MEMBER_REOPEN:'1',MOBILE_MEMBER_DEVICE:statePath,MOBILE_MEMBER_PROOF:folder})
 writeFileSync(folder+'/child.stdout.log',result.stdout);writeFileSync(folder+'/child.stderr.log',result.stderr)
 expect(result.code,result.stderr+'\n'+result.stdout).toBe(0)
 const reopened=JSON.parse(readFileSync(folder+'/reopen-result.json','utf8'))
 expect(reopened.pid).not.toBe(process.pid);expect(reopened.inputSHA256).toBe(hash);expect(reopened.seeded).toBe(false)
 expect(input).toHaveBeenCalledTimes(1);expect(observerInput).not.toHaveBeenCalled();expect(observerRead).not.toHaveBeenCalled()
 expect(owner.snapshot().record.conversation.drafts).toContainEqual([JSON.stringify(['draft',sid]),'Retained original B draft'])
 writeFileSync(folder+'/consumer.json',JSON.stringify({passed:true,writerPid:process.pid,reopened,originalInputCount:input.mock.calls.length,originalTerminalWriteCount:terminalWrite.mock.calls.length,observerTerminalWriteCount:observerTerminal.mock.calls.length,observerInputCount:observerInput.mock.calls.length,observerReadCount:observerRead.mock.calls.length,target:selected},null,2))
})

it.skipIf(process.env.MOBILE_MEMBER_REOPEN !== '1')('second process reopens the same saved device record and original running private Core without reseeding',async()=>{
 const bytes=readFileSync(statePath),inputSHA256=createHash('sha256').update(bytes).digest('hex'),original=JSON.parse(readFileSync(folder+'/reopen-input.json','utf8'))
 expect(inputSHA256).toBe(original.sha256);diskStorage()
 const source=await sourceClient(original.endpoint,original.sid),record=getDeviceWorkface().snapshot().record
 expect(record.presentation!.identity!.member!.target!.runtimeId).toBe(original.execution)
 expect(record.conversation.drafts).toContainEqual([JSON.stringify(['draft',original.sid]),'Retained original B draft'])
 const view=await mount(<MobileApp client={source} connection={connection} platform={platform()} restoreWorkface />)
 await wait(()=>expect(view.element.textContent).toContain('D ORIGINAL MEMBER BODY'))
 const editor=await waitForElement<HTMLElement>(view.element,'[contenteditable="true"]')
 expect(editor.textContent).toBe('Retained original D draft')
 writeFileSync(folder+'/reopen-result.json',JSON.stringify({pid:process.pid,inputSHA256,seeded:false,target:record.presentation!.identity!.member,draft:editor.textContent,body:'D ORIGINAL MEMBER BODY'}))
})

it.skipIf(process.env.MOBILE_MEMBER_REOPEN === '1')('the durable member reading and old receipt survive an obsolete Run without adopting a replacement Run or observer resources',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),sid='durable-mobile-member'
 await f.b.put(sid);const original=await f.d.put(sid),admission=await f.admit('D-in-B',f.d.owner.runtimeId,sid,'durable-mobile-C')
 await f.b.spatial.settleAgentOpen(admission.requestId,original,{})
 const store=Reflect.get(f.d.core,'store') as AgentMuxMemoryAgentSessionStore
 await store.applyTimelineMutation({type:'append',agentSessionId:sid,item:{id:'durable-record',agentSessionId:sid,kind:'assistant_message',source:'native-hook',status:'complete',title:'Original',content:'Retained D body after original Run change',createdAt:1,updatedAt:1}})
 const source=await sourceClient(f.b.server.path,sid),catalog=(await source.forwardRpc!('space.ls',{target:{spaceId:f.reference.spaceId}})).catalog
 const selection=mobileMemberSelection(source,catalog,sid)!
 expect(selection.target).toMatchObject({expectedRun:original.run})
 const localCatalog={...catalog,regions:catalog.regions.map(region=>({...region,execution:region.execution?{hostId:'local',cwd:region.execution.cwd}:null}))}
 expect(mobileMemberSelection(source,localCatalog,sid),'explicit Source-local machine namespace keeps its existing capability without a redundant runtime field').toBeUndefined()
 expect(mobileMemberSelection({...source,runtimeOwnerIdentity:()=>null},localCatalog,sid)).toHaveProperty('issue')
 const foreignUnknown={...localCatalog,regions:localCatalog.regions.map(region=>({...region,execution:region.execution?{...region.execution,hostId:'unconfirmed-foreign'}:null}))}
 expect(mobileMemberSelection(source,foreignUnknown,sid)).toHaveProperty('issue')
 expect(mobileMemberSelection(source,{...catalog,regions:[]},sid,undefined,'local'),'a confirmed unplaced Source inventory row remains local').toBeUndefined()
 expect(mobileMemberSelection(source,{...catalog,regions:[]},sid)).toHaveProperty('issue')
 expect(mobileMemberDraftScope({sourceRuntimeId:f.b.owner.runtimeId,issue:'unknown'},sid,{spaceId:'one',tabId:'t',regionId:'r'})).not.toBe(mobileMemberDraftScope({sourceRuntimeId:f.b.owner.runtimeId,issue:'unknown'},sid,{spaceId:'two',tabId:'t',regionId:'r'}))
 expect(mobileMemberSelection(source,{...catalog,regions:[]},sid,{spaceId:f.reference.spaceId,tabId:'missing-tab',regionId:'missing-region'},'local')).toHaveProperty('issue')
 await f.d.put(sid,2,'replacement-D-run')
 const optionalObservation=vi.fn().mockRejectedValue(Error('The auxiliary identity observation is unavailable'))
 const member=await connectMobileMember({...source,runtimeOwnerIdentity:()=>null,readRuntimeOwnerIdentity:optionalObservation},selection);cleanups.push(()=>member.client.dispose())
 expect(optionalObservation).not.toHaveBeenCalled()
 expect(hasMobileTerminal(member.client)).toBe(true)
 // The method retains the old target; its presence is not a grant to the new Run.
 await expect(mobileCapability(member.client,'readAgentSession')(sid)).rejects.toMatchObject({code:'STALE_AGENT_SESSION_BINDING'})
 const kernelInput=vi.spyOn(Reflect.get(f.d.core,'kernel'),'input')
 const oldInput=await mobileCapability(member.client,'submitAgentPrompt')({agentSessionId:sid,expectedRun:original.run,operationId:'old-run-private-attempt',prompt:'Never apply to the replacement Run',authorHuman:true}).then(value=>({value}),error=>({code:error.code,message:error.message}))
 expect(oldInput).toMatchObject({code:'CTXMUX_DISCONNECTED'})
 // This fixture has no Native service. The old attempt remains unknown, while
 // the public fixed target rejects adoption of the replacement Run before input.
 await expect(mobileCapability(member.client,'submitAgentPrompt')({agentSessionId:sid,expectedRun:{runId:'replacement-D-run'},operationId:'no-new-run',prompt:'not authorized for the replacement',authorHuman:true})).rejects.toMatchObject({code:'SPACE_MEMBER_TARGET_MISMATCH'})
 expect(kernelInput).not.toHaveBeenCalled()
 const receipt=vi.spyOn(f.d.core,'inspectAgentInput'),observerReceipt=vi.spyOn(f.b.core,'inspectAgentInput')
 await expect(mobileCapability(member.client,'inspectAgentInput')({key:{kind:'prompt',agentSessionId:sid,expectedRun:original.run,submissionId:'old-original-unknown'}})).resolves.toBeNull()
 expect(receipt).toHaveBeenCalledTimes(1);expect(observerReceipt).not.toHaveBeenCalled()
 const {expectedRun:_old,...durableIdentity}=selection.target as import('../../../packages/core/src/space-member').SpaceMemberTarget
 await expect(source.forwardRpc!('space.member.call',{target:{...durableIdentity,kind:'session',expectedAdmission:durableIdentity.expectedAdmission!},call:{method:'runtime.invoke',params:{consumerId:'session-purpose-check',fence:{runtimeId:f.d.owner.runtimeId,ownerInstanceId:f.d.owner.ownerInstanceId},invocation:{method:'readAgentSession',args:[sid]}}}})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})

 const observerRead=vi.spyOn(f.b.core,'readAgentConversation'),observerResource=vi.spyOn(f.b.core,'sessionHistoryResource'),resource=vi.spyOn(f.d.core,'sessionHistoryResource')
 const page=await member.client.readAgentConversation({hostId:'local',agentSessionId:sid,maxBytes:65536})
 expect(JSON.stringify(page)).toContain('Retained D body after original Run change')
 const reference={source:{providerId:'codex',nativeSessionId:'original-D-native'},recordId:'original-resource-record',partIndex:0,expectedReference:'original-D-resource-reference'}
 const resourceOutcome=await member.client.sessionHistoryResource(sid,reference).then(value=>({status:'returned',value}),error=>({status:'unavailable',code:error.code,message:error.message}))
 writeFileSync(folder+'/durable-resource.json',JSON.stringify({oldInput,resourceOutcome,qualification:'Original resource RPC and owner reached; resource availability is not claimed.',target:selection},null,2))
 expect(resource).toHaveBeenCalledTimes(1);expect(resource.mock.calls[0]![0]).toBe(sid);expect(resource.mock.calls[0]![1]).toMatchObject(reference)
 expect(observerResource).not.toHaveBeenCalled();expect(observerRead).not.toHaveBeenCalled()
 const wrongSource=await sourceClient(f.d.server.path,sid)
 const wrong=await connectMobileMember({...wrongSource,runtimeOwnerIdentity:()=>null},selection);cleanups.push(()=>wrong.client.dispose())
 await expect(wrong.client.readAgentConversation({hostId:'local',agentSessionId:sid})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
 if(page.window.view) await member.client.releaseConversationView({hostId:'local',agentSessionId:sid,view:page.window.view})
})

it.skipIf(process.env.MOBILE_MEMBER_REOPEN === '1')('an actual external association preserves L and rejects reverse transport without opening the local namesake',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),sid='external-mobile-sid';await f.b.put(sid)
 const {rpcControlRequest}=await import('../../../packages/core/src/rpc-business-codec'),{isSpatialAgentAssociation}=await import('../../../packages/core/src/spatial-agent-open-contract')
 const zone=(await f.b.spatial.read())!.graph.zones[0]!
 const request=rpcControlRequest('agent.open',{operationId:'external-mobile-L',content:{kind:'agent-session',reference:{kind:'coordinator-agent',runtimeId:'independent-A',binding:{bindingId:'original-A-binding',agentSessionId:sid,createOperationId:'A-original-C'}},expectedResource:{runtimeId:f.b.owner.runtimeId,workspaceId:zone.workspaceId,workspacePath:zone.directoryPath}},destination:{spaceId:f.reference.spaceId,zoneId:zone.zoneId,newTab:true},focus:false})
 if(!isSpatialAgentAssociation(request))throw Error('Original association required')
 const associated=await f.b.spatial.associateAgentOpen(request,f.b.owner.runtimeId,async()=>{})
 const source=await sourceClient(f.b.server.path,sid),catalog=(await source.forwardRpc!('space.ls',{target:{spaceId:f.reference.spaceId}})).catalog
 writeFileSync(folder+'/external-catalog.json',JSON.stringify({catalog,state:await f.b.spatial.read()},null,2))
 const open=vi.fn(),view=await mount(<MobileZoneWorkface client={source} zoneId={zone.zoneId} name="Original external source" visible openSession={open} />)
 await wait(()=>expect(view.element.querySelectorAll('h2')).toHaveLength(1))
 expect(catalog.regions).toMatchObject([{agentSessionId:null,execution:null,association:{operationId:'external-mobile-L'}}])
 expect(view.element.querySelector('.mobile-agent-row__open')).toBeNull();expect(open).not.toHaveBeenCalled()
 // The public L receipt, not a fabricated catalog SID, identifies this independently owned member.
 const selection={sourceRuntimeId:f.b.owner.runtimeId,target:{kind:'conversation' as const,reference:f.reference,regionId:associated.record.address.regionId,runtimeId:'independent-A',agentSessionId:sid,expectedAdmission:{kind:'association' as const,operationId:'external-mobile-L'}}},local=vi.spyOn(f.b.core,'readAgentConversation'),input=vi.spyOn(f.b.core,'submitAgentPrompt')
 const member=await connectMobileMember(source,selection);cleanups.push(()=>member.client.dispose())
 await expect(member.client.readAgentConversation({hostId:'local',agentSessionId:sid})).rejects.toMatchObject({code:'SPACE_MEMBER_EXTERNAL_COORDINATOR'})
 expect(member.client.submitAgentPrompt).toBeUndefined();expect(local).not.toHaveBeenCalled();expect(input).not.toHaveBeenCalled()
})
