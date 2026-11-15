// @vitest-environment happy-dom
import{act}from'react'
import{afterEach,beforeEach,expect,it,vi}from'vitest'
import{appendFile}from'node:fs/promises'
import{webcrypto}from'node:crypto'
vi.hoisted(()=>vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__',true))
import{DEFAULT_AGENT_CONTINUITY_POLICY}from'@agentmux/core/agent-session-recovery'
import type{AgentSessionRecoveryCandidate,DesktopAgentSessionDisplay,DesktopContinuityOperation,SessionRecoveryResult}from'../src/shared/contracts'
import{useAppStore,recoveryCandidateSession}from'../src/renderer/src/store'
import{reduceAgentMembershipSnapshot,type SessionProjectionState}from'../src/renderer/src/lib/session-state'
import{originalSessionRestart}from'../src/renderer/src/lib/session-original-recovery'
import{ContinuitySupervisionNotice}from'../src/renderer/src/components/ContinuitySupervisionNotice'
import{SessionRunEndedActions}from'../src/renderer/src/components/SessionRunEndedActions'
import{api}from'../src/renderer/src/lib/api'
import{createWorkbenchTab}from'../src/renderer/src/lib/workbench-tabs'
import{createWorkspaceLayout}from'@agentmux/layout'
import{composerDOM,composerSession,composerConfig}from'./helpers/composer-dom-fixture'
const dom=composerDOM(),clone=structuredClone
const generated='Task013 generated projection payload 0123456789\n'.repeat(42000).slice(0,1_855_168)
function fixture(){
 const session=composerSession('projection-original'),nativeTarget={kind:'provider' as const,providerId:'codex',sessionId:'original-native'}
 const operation:DesktopContinuityOperation={operationId:'original-continuity',agentSessionId:session.id,trigger:'startup',policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},previousRun:session.control.run,nativeTarget,admittedAt:1,observedAt:2,rechecks:0,kind:'pending',reason:'operation-unconfirmed',evidence:{kind:'run-running',observedAt:2},
  resumedInputBoundary:{initialInputByte:0,protocolInput:{operationId:'original-protocol-ACK',startByte:0,endByte:2}},
  supervision:{phase:'paused',activeAttemptOperationId:'original-continuity',attemptCount:1,attemptLimit:1,observedAt:2,reason:'retry-budget-exhausted'},
  previousInput:{scope:'typed-prompt',outcome:'unknown',key:{kind:'prompt',agentSessionId:session.id,expectedRun:session.control.run,submissionId:'unknown-original-input'}},
  launchInput:{input:{submissionId:'original-submission',prompt:'Original draft',authorHuman:true},prompt:'Frozen original composed input',
    message:{userContent:generated,authorHuman:true},digest:'original-digest',delivery:'post-launch',lifecycleOperationId:'original-lifecycle',state:'not-applied'}}
 const core:DesktopAgentSessionDisplay={kind:'agent',agentSessionId:session.id,providerId:session.providerId,executorId:session.executorId,hostId:session.hostId,workspacePath:session.workspacePath,run:session.control.run,retiredRuns:[],nativeHandle:nativeTarget,createdAt:session.createdAt,updatedAt:2,continuity:clone(operation),continuityOperations:{[operation.operationId]:clone(operation)}}
 return{session:{...session,nativeHandle:nativeTarget},operation,core}
}
let f:ReturnType<typeof fixture>
beforeEach(()=>{
 vi.stubGlobal('crypto',webcrypto)
 f=fixture();const tab=createWorkbenchTab('projection-tab',{kind:'agent',phase:'attached',regionId:'projection-region',workspaceId:'workspace',sessionId:f.session.id})
 useAppStore.setState({config:composerConfig,sessions:[f.session,composerSession('unrelated-original')],loading:false,timelines:{},tabs:{[tab.id]:tab},layouts:{workspace:createWorkspaceLayout('projection-group',[tab.id])},pendingAgentLaunches:{},recoveryCandidates:[],continuityControlIntents:{},agentComposerDrafts:{[f.session.id]:'Original unsent draft'},agentSteerQueues:{},error:null})
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue(undefined)
 vi.spyOn(api.sessions,'recover').mockRejectedValue(new Error('No recovery action was authorized by a projection'))
 vi.spyOn(api.sessions,'launchAgent').mockRejectedValue(new Error('No creation was authorized by a projection'))
 vi.spyOn(api.sessions,'write').mockResolvedValue(undefined)
})
afterEach(()=>vi.restoreAllMocks())
function current(){const session=useAppStore.getState().sessions.find(session=>session.id===f.session.id)!;if(session.kind!=='agent')throw Error('Original Agent projection lost');return session}
function apply(core:DesktopAgentSessionDisplay,hostId='local'){useAppStore.getState().applyEvent({type:'core',hostId,event:{type:'agent-session',session:core}})}
function Surface(){const session=useAppStore(state=>state.sessions.find(session=>session.id==='projection-original'))!;return session.kind==='agent'?<><ContinuitySupervisionNotice session={session}/><SessionRunEndedActions session={session}/></>:null}
function retainedHandler(text:string){const button=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.trim()===text)!;expect(button,text).toBeDefined();const key=Object.keys(button).find(key=>key.startsWith('__reactProps$'))!;const handler=Reflect.get(button,key).onClick as()=>void;expect(handler).toBeTypeOf('function');return handler}
function bodyBytes(value:unknown,seen=new Set<object>()):number{
 if(!value||typeof value!=='object'||seen.has(value))return 0
 seen.add(value);let bytes=0
 for(const[key,item]of Object.entries(value))bytes+=key==='userContent'&&typeof item==='string'?Buffer.byteLength(item):bodyBytes(item,seen)
 return bytes
}
it('actual AppStore events and mounted retained callbacks keep one isolated complete graph across unrelated observations without copying its large body',async()=>{
 const copies:Array<{bytes:number}>=[]
 vi.spyOn(globalThis,'structuredClone').mockImplementation((value,options)=>{const bytes=bodyBytes(value);if(bytes)copies.push({bytes});return clone(value,options)})
 apply(f.core);const original=current()
 expect(original.continuity).not.toBe(f.core.continuity)
 expect(original.continuityOperations).not.toBe(f.core.continuityOperations);expect(original.continuity).not.toBe(f.core.continuityOperations?.[f.operation.operationId])
 expect(JSON.stringify({continuity:original.continuity,continuityOperations:original.continuityOperations})).toBe(JSON.stringify({continuity:f.core.continuity,continuityOperations:f.core.continuityOperations}))
 await dom.render(<Surface/>);const callbacks=[retainedHandler('Re-read original')],snapshots=[original],before=copies.reduce((sum,row)=>sum+row.bytes,0),started=performance.now()
 for(let index=0;index<6;index++){
  const incoming=clone(f.core);incoming.updatedAt=3+index
  await act(async()=>apply(incoming));snapshots.push(current());callbacks.push(retainedHandler('Re-read original'))
 }
 const elapsedMs=performance.now()-started,after=copies.reduce((sum,row)=>sum+row.bytes,0)
 if(process.env.CONTINUITY_PROJECTION_FACTS)await appendFile(process.env.CONTINUITY_PROJECTION_FACTS,JSON.stringify({testName:'actual AppStore events and mounted retained callbacks',payloadBytes:Buffer.byteLength(generated),observations:6,projectionBodyCloneBytesAfterWarmup:after-before,initialCloneBodyBytes:before,retainedCallbacks:callbacks.length,retainedOperationGraphs:new Set(snapshots.flatMap(session=>[session.continuity,session.continuityOperations?.[f.operation.operationId]])).size,elapsedMs,boundary:'Actual AppStore projector and mounted production ContinuitySupervisionNotice callbacks. Input transport clones are generated outside projection instrumentation; no user RSS/GC/reclaim claim.'})+'\n')
 expect(after-before,'Unrelated actual product observations must copy zero large continuity body bytes').toBe(0)
 expect(new Set(snapshots.map(session=>session.continuity)).size).toBe(1)
 expect(snapshots.every(session=>session.continuity===session.continuityOperations?.[f.operation.operationId])).toBe(true)
 f.core.continuity!.launchInput!.message.userContent='Caller changed its original source after intake'
 f.core.continuityOperations![f.operation.operationId]!.launchInput!.message.userContent='Caller changed its original map after intake'
 expect(original.continuity?.launchInput?.message.userContent===generated).toBe(true)
 vi.spyOn(api.sessions,'refresh').mockImplementation(async()=>current())
 await act(async()=>callbacks[0]!())
 expect(api.sessions.refresh).toHaveBeenCalledWith(f.session.control)
 expect(api.sessions.recover).not.toHaveBeenCalled();expect(api.sessions.launchAgent).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled()
 expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
})
it('same-ID and same-timestamp full body or protocol ACK changes produce isolated new facts while optional clearing removes their old projection',()=>{
 apply(f.core);const original=current(),first=clone(f.core)
 first.continuity!.launchInput!.message.userContent='Changed full body at the same timestamps';first.continuityOperations![f.operation.operationId]!.launchInput!.message.userContent='Changed full body at the same timestamps'
 apply(first);const body=current()
 expect(body.continuity?.launchInput?.message.userContent==='Changed full body at the same timestamps').toBe(true);expect(body.continuity).not.toBe(original.continuity)
 expect(original.continuity?.launchInput?.message.userContent===generated).toBe(true)
 const ack=clone(first);ack.continuity!.resumedInputBoundary!.protocolInput!.endByte=4;ack.continuityOperations![f.operation.operationId]!.resumedInputBoundary!.protocolInput!.endByte=4
 apply(ack);expect(current().continuity?.resumedInputBoundary?.protocolInput?.endByte).toBe(4);expect(body.continuity?.resumedInputBoundary?.protocolInput?.endByte).toBe(2)
 ack.continuity!.resumedInputBoundary!.protocolInput!.endByte=99;expect(current().continuity?.resumedInputBoundary?.protocolInput?.endByte).toBe(4)
 const{continuity,continuityOperations,...cleared}=f.core;apply(cleared)
 expect(current()).not.toHaveProperty('continuity');expect(current()).not.toHaveProperty('continuityOperations');expect(api.sessions.write).not.toHaveBeenCalled()
})
it('changed operation observations retain one shared frozen input body across every retained version without aliasing the source or rewriting older versions',()=>{
 apply(f.core);const snapshots=[current()]
 for(let index=0;index<4;index++){
  const incoming=clone(f.core),observedAt=10+index
  for(const operation of[incoming.continuity!,incoming.continuityOperations![f.operation.operationId]!]){operation.observedAt=observedAt;operation.supervision={...operation.supervision!,observedAt}}
  apply(incoming);snapshots.push(current())
 }
 expect(new Set(snapshots.map(session=>session.continuity)).size).toBe(5)
 expect(snapshots.map(session=>session.continuity?.supervision?.observedAt)).toEqual([2,10,11,12,13])
 expect(new Set(snapshots.map(session=>session.continuity?.launchInput)).size,'Every retained version must share one frozen input body').toBe(1)
 expect(new Set(snapshots.map(session=>session.continuityOperations?.[f.operation.operationId]?.launchInput)).size).toBe(1)
 expect(snapshots.at(-1)!.continuity?.launchInput).not.toBe(f.core.continuity?.launchInput)
 f.core.continuity!.launchInput!.message.userContent='Caller changed its original source after intake'
 expect(snapshots.every(session=>session.continuity?.launchInput?.message.userContent===generated)).toBe(true)
 const changed=clone(f.core);changed.continuity!.launchInput!.message.userContent='Changed frozen body';changed.continuityOperations![f.operation.operationId]!.launchInput!.message.userContent='Changed frozen body'
 apply(changed);expect(current().continuity?.launchInput?.message.userContent).toBe('Changed frozen body');expect(current().continuity?.launchInput?.input).toBe(snapshots.at(-1)!.continuity?.launchInput?.input)
 expect(snapshots.at(-1)!.continuity?.launchInput?.message.userContent===generated).toBe(true)
 expect(api.sessions.recover).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled()
})
it('a pointer that becomes equal to its map operation again shares that one operation after distinct same-ID facts',()=>{
 apply(f.core);const distinct=clone(f.core)
 distinct.continuityOperations![f.operation.operationId]={...distinct.continuityOperations![f.operation.operationId]!,action:'restart',kind:'starting'}
 apply(distinct);expect(current().continuity).not.toBe(current().continuityOperations?.[f.operation.operationId])
 apply({...clone(f.core),updatedAt:3})
 expect(current().continuity,'An equal pointer and map operation must remain one projected operation').toBe(current().continuityOperations?.[f.operation.operationId])
 expect(current().continuity).toEqual(f.operation)
})
it('existing exact Host, Session and stale Run/receipt guards precede graph reuse and same-ID differing pointer/map facts remain distinct',()=>{
 apply(f.core);const accepted=current()
 apply({...clone(f.core),updatedAt:100},'unrelated-host');expect(current()).toBe(accepted)
 const decoy=useAppStore.getState().sessions.find(session=>session.id==='unrelated-original')!
 apply({...clone(f.core),agentSessionId:decoy.id,updatedAt:100});expect(current()).toBe(accepted);expect(useAppStore.getState().sessions.find(session=>session.id===decoy.id)).toBe(decoy)
 apply({...clone(f.core),run:{runId:'stale-unaccepted-run'},updatedAt:1});expect(current()).toBe(accepted)
 const different=clone(f.core);different.continuityOperations![f.operation.operationId]={...different.continuityOperations![f.operation.operationId]!,action:'restart',kind:'starting'}
 apply(different);expect(current().continuity).not.toBe(current().continuityOperations?.[f.operation.operationId]);expect(originalSessionRestart(current())).toEqual(different.continuityOperations![f.operation.operationId])
 expect(api.sessions.recover).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled()
})
it('normal membership reuses only the same original subject and clones changed or foreign-owner incoming facts without aliasing the source',()=>{
 apply(f.core);const original=current(),state=useAppStore.getState(),incoming=clone(original)
 const snapshot={sessions:[{...incoming,updatedAt:100}],timelines:{[incoming.id]:{agentSessionId:incoming.id,revision:0,items:[]}},recoveryCandidates:[]}
 const next=reduceAgentMembershipSnapshot(state,snapshot),retained=next.sessions.find(session=>session.id===incoming.id)!
 if(retained.kind!=='agent')throw Error('Membership lost the original Agent subject')
 expect(retained.continuity).toBe(original.continuity);expect(retained.continuityOperations).toBe(original.continuityOperations)
 const foreign=clone(incoming);foreign.hostId='other-owner';foreign.control.hostId='other-owner'
 const changed=reduceAgentMembershipSnapshot(next,{...snapshot,sessions:[foreign]}),projected=changed.sessions.find(session=>session.id===incoming.id)!
 if(projected.kind!=='agent')throw Error('Membership source was not projected as its original Agent')
 expect(projected.continuity).not.toBe(original.continuity);expect(projected.continuity).not.toBe(foreign.continuity)
 foreign.continuity!.launchInput!.message.userContent='Foreign source mutated';expect(projected.continuity?.launchInput?.message.userContent===generated).toBe(true)
})
it.each(['pending','unavailable']as const)('actual %s recovery result installs one isolated full operation graph with original controls and no input replay',async kind=>{
 const operation=clone(f.operation),result:SessionRecoveryResult=kind==='pending'?{kind,agentSessionId:f.session.id,previousRun:f.session.control.run,reason:'operation-unconfirmed',evidence:{kind:'run-running',observedAt:2},continuity:operation}:{kind,agentSessionId:f.session.id,previousRun:f.session.control.run,reason:'provider-unavailable',evidence:{kind:'run-ended',state:'interrupted',observedAt:2},continuity:operation}
 vi.mocked(api.sessions.recover).mockResolvedValue(result)
 await useAppStore.getState().recoverSession(f.session.id,'original-recovery',{inputControl:f.session.control})
 const projected=current();expect(projected.continuity).toBe(projected.continuityOperations?.[operation.operationId]);expect(projected.continuity).not.toBe(operation);expect(projected.continuity).toEqual(operation)
 operation.launchInput!.message.userContent='Returned receipt source mutated';expect(projected.continuity?.launchInput?.message.userContent===generated).toBe(true)
 expect(api.sessions.recover).toHaveBeenCalledOnce();expect(vi.mocked(api.sessions.recover).mock.calls[0]!.slice(0,3)).toEqual([f.session.control,f.session.workspacePath,'original-recovery'])
 expect(projected.control).toEqual(f.session.control);expect(api.sessions.launchAgent).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
})
it('original recovery candidate explicitly installs its returned current operation once without rewriting ordinary conflicting same-ID facts',()=>{
 const candidate:AgentSessionRecoveryCandidate={agentSessionId:f.session.id,hostId:f.session.hostId,providerId:f.session.providerId,executorId:f.session.executorId,workspacePath:f.session.workspacePath,label:'Original',capabilities:f.session.capabilities,createdAt:1,updatedAt:2,run:f.session.control.run,continuity:clone(f.operation),continuityOperations:{[f.operation.operationId]:{...clone(f.operation),kind:'starting'}}}
 const projected=recoveryCandidateSession(candidate,{kind:'pending',detail:'Original recovery is unconfirmed'})
 if(projected.kind!=='agent')throw Error('Original recovery candidate lost its Agent identity')
 expect(projected.continuity).toBe(projected.continuityOperations?.[f.operation.operationId]);expect(projected.continuity).toEqual(candidate.continuity);expect(projected.continuity).not.toBe(candidate.continuity)
 candidate.continuity!.launchInput!.message.userContent='Candidate changed';expect(projected.continuity?.launchInput?.message.userContent===generated).toBe(true)
})
it('an actual successful recovery result retains its complete new-Run operation once without borrowing the returned graph or replaying input',async()=>{
 const operation={...clone(f.operation),kind:'resumed' as const,newRun:{runId:'original-session-resumed-run'}},session={...f.session,control:{...f.session.control,run:operation.newRun},continuity:clone(operation),continuityOperations:{[operation.operationId]:clone(operation)}}
 vi.mocked(api.sessions.recover).mockResolvedValue({kind:'resumed',session})
 await useAppStore.getState().recoverSession(f.session.id,'original-success',{inputControl:f.session.control})
 const projected=current();expect(projected.control).toEqual(session.control);expect(projected.continuity).toBe(projected.continuityOperations?.[operation.operationId]);expect(projected.continuity).not.toBe(session.continuity)
 expect(projected.continuity).toEqual(operation);session.continuity.launchInput!.message.userContent='Returned successful source changed';expect(projected.continuity?.launchInput?.message.userContent===generated).toBe(true)
 expect(api.sessions.recover).toHaveBeenCalledOnce();expect(api.sessions.launchAgent).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled()
})
it('a mounted retained Resume callback keeps its original control and cannot replace a newer accepted Run when Core returns that exact conflict',async()=>{
 apply(f.core);await dom.render(<Surface/>);const retained=retainedHandler('Resume'),newRun={runId:'newer-already-accepted-run'}
 await act(async()=>apply({...clone(f.core),run:newRun,retiredRuns:[f.session.control.run],updatedAt:3}))
 vi.mocked(api.sessions.recover).mockResolvedValue({kind:'conflict',agentSessionId:f.session.id,previousRun:f.session.control.run,currentRun:newRun,reason:'session-run-changed',evidence:{kind:'agent-session-store'}})
 await act(async()=>retained())
 expect(api.sessions.recover).toHaveBeenCalledOnce();expect(vi.mocked(api.sessions.recover).mock.calls[0]![0]).toEqual(f.session.control)
 expect(current().control.run).toEqual(newRun);expect(current().status).toMatchObject({continuity:'conflict',continuityConflict:'session-run-changed'})
 expect(api.sessions.launchAgent).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
})
it('changed metadata reaches mounted recovery consumers without re-cloning the unchanged large input body',async()=>{
 const copies:number[]=[]
 vi.spyOn(globalThis,'structuredClone').mockImplementation((value,options)=>{copies.push(bodyBytes(value));return clone(value,options)})
 apply(f.core);await dom.render(<Surface/>);const original=current(),before=copies.reduce((a,b)=>a+b,0),callbacks=[retainedHandler('Re-read original')]
 for(let index=0;index<6;index++){
  const incoming=clone(f.core)
  for(const operation of[incoming.continuity!,incoming.continuityOperations![f.operation.operationId]!]){
   operation.observedAt=10+index;operation.policy={...operation.policy,retryMaxAttempts:2+index}
   operation.supervision={...operation.supervision!,observedAt:10+index}
  }
  await act(async()=>apply(incoming));callbacks.push(retainedHandler('Re-read original'))
  expect(current().continuity?.policy.retryMaxAttempts).toBe(2+index)
  expect(current().continuity?.supervision?.observedAt).toBe(10+index)
  expect(current().continuity?.launchInput).toBe(original.continuity?.launchInput)
 }
 const bytes=copies.reduce((a,b)=>a+b,0)-before
 if(process.env.CONTINUITY_PROJECTION_FACTS)await appendFile(process.env.CONTINUITY_PROJECTION_FACTS,JSON.stringify({testName:'changed metadata with mounted recovery consumers',payloadBytes:Buffer.byteLength(generated),observations:6,projectionBodyCloneBytesAfterWarmup:bytes,boundary:'Logical payload bytes entering the production structuredClone boundary, not V8 allocated or user RSS bytes. Transport input clones excluded; same body across changed metadata.'})+'\n')
 expect(bytes,'Changed metadata must clone zero unchanged large input body bytes').toBe(0)
 expect(current().continuity?.launchInput?.message.userContent).toBe(generated)
 expect(original.continuity?.policy.retryMaxAttempts).toBe(DEFAULT_AGENT_CONTINUITY_POLICY.retryMaxAttempts)
 vi.spyOn(api.sessions,'refresh').mockImplementation(async()=>current())
 await act(async()=>callbacks[0]!());expect(api.sessions.refresh).toHaveBeenCalledWith(f.session.control)
 expect(api.sessions.recover).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled()
 expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
})
it('changed Browser input facts preserve arrays, nulls, own keys and source isolation through actual Session events',()=>{
 const context={kind:'browser' as const,version:1 as const,capturedAt:2,browser:{hostId:'local',browserId:'original-browser',navigationId:'original-nav'},page:{url:'https://fixture.invalid/',title:'Original page'},selection:{kind:'element' as const,capturedAt:2,source:{hostId:'local',browserId:'original-browser',navigationId:null,association:'unknown' as const},viewport:{width:100,height:80,deviceScaleFactor:null},element:{tagName:'div',role:'region',accessibleName:'Original',selector:'#original',text:'Original',nearbyText:['first','second'],attributes:JSON.parse('{"__proto__":"recorded value","constructor":"recorded constructor","data-id":"first"}') as Record<string,string>,html:'<div />'}}}
 for(const operation of[f.core.continuity!,f.core.continuityOperations![f.operation.operationId]!])operation.launchInput!.message.inputContext=clone(context)
 apply(f.core);const original=current()
 const incoming=clone(f.core)
 for(const operation of[incoming.continuity!,incoming.continuityOperations![f.operation.operationId]!]){
  operation.observedAt=3
  const input=operation.launchInput!.message.inputContext!
  delete input.page.title;input.browser.navigationId=null
  input.selection!.element!.nearbyText=['second','first','third']
  input.selection!.element!.attributes=Object.fromEntries([['__proto__','changed own value'],['constructor','changed constructor'],['data-id','second']])
 }
 apply(incoming);const projected=current().continuity!.launchInput!.message.inputContext!
 expect(projected.selection!.element!.nearbyText,'Changed arrays retain their full order and length').toEqual(['second','first','third'])
 expect(projected.page,'Optional clearing must remove the old own property').not.toHaveProperty('title')
 expect(projected.browser.navigationId,'A changed null is a complete recorded fact').toBeNull()
 const attrs=projected.selection!.element!.attributes
 expect(Object.keys(attrs),'Arbitrary own JSON keys must survive projection').toEqual(['__proto__','constructor','data-id'])
 expect(Object.hasOwn(attrs,'__proto__'),'__proto__ must remain an own data property').toBe(true)
 expect(attrs['__proto__']).toBe('changed own value');expect(attrs.constructor).toBe('changed constructor')
 expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype)
 incoming.continuity!.launchInput!.message.inputContext!.selection!.element!.nearbyText.push('caller mutation')
 incoming.continuityOperations![f.operation.operationId]!.launchInput!.message.inputContext!.selection!.element!.attributes['data-id']='caller mutation'
 expect(projected.selection!.element!.nearbyText,'Source arrays must stay isolated').toEqual(['second','first','third'])
 expect(attrs['data-id'],'Source own data must stay isolated').toBe('second')
 expect(original.continuity!.launchInput!.message.inputContext).toEqual(context)
 const cleared=clone(incoming)
 for(const operation of[cleared.continuity!,cleared.continuityOperations![f.operation.operationId]!])operation.launchInput!.message.inputContext!.selection!.element!.nearbyText=[]
 apply(cleared);expect(current().continuity!.launchInput!.message.inputContext!.selection!.element!.nearbyText,'Empty arrays clear all old entries').toEqual([])
 expect(api.sessions.recover).not.toHaveBeenCalled();expect(api.sessions.write).not.toHaveBeenCalled()
})
