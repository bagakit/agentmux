import { afterEach, expect, expectTypeOf, test, vi } from 'vitest'
import { connectSpaceMember, type SpaceMemberClient } from '../src/space-member-client.js'
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import { isSpatialAgentAssociation } from '../src/spatial-agent-open-contract.js'
import { encodeHostedValue } from '../src/hosted-value.js'
const cleanups: Array<() => unknown | Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks()})
test.each(['local','D-in-B'])('the public original %s member checks exact C before same-SID/same-Run controls while no-pin IO stays available',async(hostId)=>{
 const f=await createSpaceSessionsFixture(cleanups),owner=hostId==='local'?f.b:f.d,session=await owner.put('same-SID')
 const one=await f.admit(hostId,owner.owner.runtimeId,session.agentSessionId,'original-C'),two=await f.admit(hostId,owner.owner.runtimeId,session.agentSessionId,'different-C')
 const write=vi.spyOn(owner.core,'writeAgent').mockResolvedValue({runId:session.run.runId,appliedByteRange:null,acceptedThroughByte:1})
 const target={reference:f.reference,regionId:one.address.regionId,runtimeId:owner.owner.runtimeId,agentSessionId:session.agentSessionId,expectedRun:session.run}
 const pinned=await connectSpaceMember(f.b.rpc,{...target,expectedAdmission:{kind:'creation' as const,operationId:one.requestId}});cleanups.push(()=>pinned.dispose())
 const positive=await pinned.writeAgent({agentSessionId:session.agentSessionId,expectedRun:session.run,data:'one',source:'user'}).then(value=>({value}),error=>({error}))
 expect(positive).toHaveProperty('value')
 const ref={key:{kind:'prompt' as const,agentSessionId:session.agentSessionId,expectedRun:session.run,submissionId:'original-input-OP'},waitGeneration:1}
 const receipt={key:ref.key,ref,control:{ref,state:'enabled' as const,at:1},persistence:'confirmed' as const,status:'waiting' as const,admission:null,observation:'owned' as const}
 const rejoin=vi.spyOn(owner.core,'rejoinAgentInputWaiting').mockResolvedValue(receipt)
 expect(await pinned.rejoinAgentInputWaiting({ref})).toEqual(receipt);expect(rejoin.mock.calls[0]?.[0]).toEqual({ref})
 expect(await pinned.inspectAgentInput({key:ref.key})).toBeNull()
 const wrong=await connectSpaceMember(f.b.rpc,{...target,expectedAdmission:{kind:'creation' as const,operationId:two.requestId}});cleanups.push(()=>wrong.dispose())
 const refused=await wrong.writeAgent({agentSessionId:session.agentSessionId,expectedRun:session.run,data:'wrong-C',source:'user'}).then(value=>({value}),error=>({code:error.code}))
 expect(refused).toEqual({code:'SPACE_MEMBER_ADMISSION_UNCONFIRMED'})
 expect(write).toHaveBeenCalledTimes(1)
 const legacy=await connectSpaceMember(f.b.rpc,target);cleanups.push(()=>legacy.dispose());await legacy.writeAgent({agentSessionId:session.agentSessionId,expectedRun:session.run,data:'legacy',source:'user'})
 expect(write).toHaveBeenCalledTimes(2);expect(await owner.core.readAgentSession(session.agentSessionId)).toMatchObject({run:session.run})
})
test('member rejoin accepts only one original prompt ref with its own SID/Run and generation',()=>{
 expectTypeOf<Parameters<SpaceMemberClient['rejoinAgentInputWaiting']>>().toEqualTypeOf<[{ref:import('../src/agent-input-wait.js').AgentInputWaitRef}]>()
 const target={reference:{runtimeId:'B',spaceId:'project'},regionId:'region',runtimeId:'D',agentSessionId:'SID',expectedRun:{runId:'Run'},expectedAdmission:{kind:'creation' as const,operationId:'C'}}
 const ref={key:{kind:'prompt' as const,agentSessionId:'SID',expectedRun:{runId:'Run'},submissionId:'original-OP'},waitGeneration:1}
 const envelope=(args:unknown[])=>({target,call:{method:'runtime.invoke',params:{consumerId:'reader',fence:{runtimeId:'D',ownerInstanceId:'D-instance'},invocation:encodeHostedValue({method:'rejoinAgentInputWaiting',args})}}})
 const parsed=()=>parseSpaceMemberParams('space.member.call',envelope([{ref}]))
 expect(parsed).not.toThrow();expect(parsed().target.expectedAdmission).toEqual(target.expectedAdmission)
 for(const args of [[{ref},{}],[{ref,caller:{agentSessionId:'SID',capability:'forged'}}],[{ref,scope:'wake-only'}],[{ref:{...ref,waitGeneration:0}}],[{ref:{...ref,key:{...ref.key,agentSessionId:'other-SID'}}}],[{ref:{...ref,key:{...ref.key,expectedRun:{runId:'other-Run'}}}}]])expect(()=>parseSpaceMemberParams('space.member.call',envelope(args))).toThrow()
})

test('association L pin is checked without opening reverse input or borrowing a B namesake',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),same=await f.b.put('same-SID'),{rpcControlRequest}=await import('../src/rpc-business-codec.js')
 const zone=(await f.b.spatial.read())!.graph.zones[0]!,admit=async(operationId:string)=>{
  const request=rpcControlRequest('agent.open',{operationId,content:{kind:'agent-session',reference:{kind:'coordinator-agent',runtimeId:'A',binding:{bindingId:'binding-A',agentSessionId:same.agentSessionId,createOperationId:'C-A'}},expectedResource:{runtimeId:f.b.owner.runtimeId,workspaceId:zone.workspaceId,workspacePath:zone.directoryPath}},destination:{spaceId:f.reference.spaceId,zoneId:zone.zoneId,newTab:true},focus:false})
  if(!isSpatialAgentAssociation(request))throw Error('Original association required')
  return await f.b.spatial.associateAgentOpen(request,f.b.owner.runtimeId,async()=>{})
 }
 const one=await admit('L-one');await admit('L-two')
 const target={reference:f.reference,regionId:one.record.address.regionId,runtimeId:'A',agentSessionId:same.agentSessionId,expectedRun:same.run,expectedAdmission:{kind:'association' as const,operationId:'L-one'}}
 const call={method:'runtime.owner.identity' as const,params:{expectedRuntimeId:'A'}}
 await expect(f.b.rpc.call('space.member.call',{target,call})).rejects.toMatchObject({code:'SPACE_MEMBER_EXTERNAL_COORDINATOR'})
 await expect(f.b.rpc.call('space.member.call',{target:{...target,expectedAdmission:{kind:'association',operationId:'L-two'}},call})).rejects.toMatchObject({code:'SPACE_MEMBER_ADMISSION_UNCONFIRMED'})
 expect(await f.b.core.readAgentSession(same.agentSessionId)).toMatchObject({run:same.run})
})

test('the existing public member CLI preserves its pin/ref and discovers the same explicit rejoin guide',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),session=await f.b.put('cli-SID'),admission=await f.admit('local',f.b.owner.runtimeId,session.agentSessionId,'cli-C')
 const ref={key:{kind:'prompt' as const,agentSessionId:session.agentSessionId,expectedRun:session.run,submissionId:'cli-original-OP'},waitGeneration:1}
 const receipt={key:ref.key,ref,control:{ref,state:'enabled' as const,at:1},persistence:'confirmed' as const,status:'waiting' as const,admission:null,observation:'owned' as const},rejoin=vi.spyOn(f.b.core,'rejoinAgentInputWaiting').mockResolvedValue(receipt)
 const {writeFile}=await import('node:fs/promises'),{join}=await import('node:path'),{runSourceObjectCli}=await import('./helpers/source-object-cli.js'),{objectCliEnvironment}=await import('./helpers/object-cli-rpc.js')
 const target={reference:f.reference,regionId:admission.address.regionId,runtimeId:f.b.owner.runtimeId,agentSessionId:session.agentSessionId,expectedRun:session.run,expectedAdmission:{kind:'creation',operationId:'cli-C'}},file=join(f.b.root,'original-member-input.json')
 await writeFile(file,JSON.stringify({target,call:{method:'runtime.invoke',params:{consumerId:'CLI-reader',fence:{runtimeId:f.b.owner.runtimeId,ownerInstanceId:f.b.owner.ownerInstanceId},invocation:{method:'rejoinAgentInputWaiting',args:[{ref}]}}}}))
 const result=await runSourceObjectCli(['--endpoint','unix:'+f.b.server.path,'space','member','call','--input',file],objectCliEnvironment(f.b.root),'',15000,process.env.T012_CLI_LOADER?new URL(process.env.T012_CLI_LOADER):undefined)
 expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout).result.value).toEqual(receipt);expect(rejoin.mock.calls[0]?.[0]).toEqual({ref});expect(rejoin).toHaveBeenCalledTimes(1)
 for(const command of ['space','route']){const guide=await runSourceObjectCli([command,'--skill'],objectCliEnvironment(f.b.root),'',15000,process.env.T012_CLI_LOADER?new URL(process.env.T012_CLI_LOADER):undefined);expect(guide.code,guide.stderr).toBe(0);expect(guide.stdout).toContain('expectedAdmission');expect(guide.stdout).toContain('rejoinAgentInputWaiting')}
})
