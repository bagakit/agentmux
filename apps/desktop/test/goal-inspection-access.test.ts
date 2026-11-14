// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {createGoalQualifiedPublicFixture} from './helpers/goal-qualified-public-fixture'
import {runSourceObjectCli} from '../../../packages/core/test/helpers/source-object-cli'
import {objectCliEnvironment} from '../../../packages/core/test/helpers/object-cli-rpc'
import {parseAgentMuxControlRequest} from '../../../packages/core/src/control-codec'

const cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();vi.unstubAllEnvs()})

async function originalInput(prompt='Frozen original Goal input'){
 const f=await createGoalQualifiedPublicFixture(cleanup),operationId='original-independent-Check'
 const frozen={operationId,target:f.reference,runId:f.session.run.runId,execution:'finite' as const,prompt:'Frozen original Goal input',agentMuxNote:'Original independent note'}
 await f.goals.demands.prepareDispatch(f.goal.id,frozen)
 await f.goals.demands.recordDispatchPhase(f.goal.id,operationId,{stage:'submitted'})
 await f.goals.demands.recordDispatchPhase(f.goal.id,operationId,{stage:'unknown',issue:'Original acknowledgement unconfirmed'})
 const key={kind:'prompt' as const,agentSessionId:f.session.agentSessionId,expectedRun:f.session.run,submissionId:operationId}
 await f.d.core.submitAgentPrompt({agentSessionId:key.agentSessionId,expectedRun:key.expectedRun,operationId,prompt,agentMuxNote:frozen.agentMuxNote,execution:'immediate',admissionIntent:{kind:'session-conversation'},authorHuman:false,sourceChannel:'api'})
 await expect.poll(async()=>(await f.d.core.inspectAgentInput({key}))?.status).toBe('admitted')
 return{...f,operationId,frozen,key}
}

it('public Goal inspection and actual CLI read the original canonical input with only independent Coordinator access while Source is unavailable, without resending',async()=>{
 const f=await originalInput(),source=vi.spyOn(f.goalServer,'callRpc').mockRejectedValue(Object.assign(Error('The original Source is unavailable'),{code:'SPACE_SESSION_SOURCE_UNAVAILABLE'}))
 const access={coordinator:{hostId:'D-current'}}
 let failure:unknown
 const observed=await f.rpc.call('goal.inspect',{goalId:f.goal.id,dispatchOperationId:f.operationId,access}).catch(error=>{failure=error;return null})
 expect(failure).toBeUndefined();expect(observed).not.toBeNull()
 expect(observed?.goal?.dispatches?.find(row=>row.operationId===f.operationId)).toMatchObject({...f.frozen,stage:'confirmed',receipt:{kind:'core-input',inputKey:f.key,outcome:'admitted'}})
 const cli=await runSourceObjectCli(['--endpoint','unix:'+f.goalServer.path,'goal','inspect','--goal',f.goal.id,'--dispatch-operation',f.operationId,'--access',JSON.stringify(access)],objectCliEnvironment(f.sourceRoot),'',15000,new URL('../../host/test/helpers/goal-relations-source-loader.mjs',import.meta.url))
 expect(cli.code,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result.goal.dispatches).toMatchObject([{operationId:f.operationId,target:f.reference,runId:f.session.run.runId,stage:'confirmed'}])
 const help=await runSourceObjectCli(['goal','inspect','--help'],objectCliEnvironment(f.sourceRoot),'',15000,new URL('../../host/test/helpers/goal-relations-source-loader.mjs',import.meta.url))
 expect(help.code,help.stderr).toBe(0);expect(help.stdout).toContain('current Source or independent Coordinator access')
 const guide=await runSourceObjectCli(['goal','--skill'],objectCliEnvironment(f.sourceRoot),'',15000,new URL('../../host/test/helpers/goal-relations-source-loader.mjs',import.meta.url))
 expect(guide.code,guide.stderr).toBe(0);expect(guide.stdout).toContain('{"coordinator":{"hostId":"ORIGINAL_COORDINATOR"}}');expect(guide.stdout).toContain('relationship Save do not accept Coordinator-only access')
 expect(source).not.toHaveBeenCalled();expect(f.send).toHaveBeenCalledTimes(1);expect(f.raw).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()
 expect((await f.d.core.readAgentSession(f.session.agentSessionId))?.run).toEqual(f.session.run)
})

it('coordinator-only access is rejected for Start/Resume and relationship Save before the original writer, while source-bearing inspection keeps its original shape',async()=>{
 const f=await createGoalQualifiedPublicFixture(cleanup),access={coordinator:{hostId:'D-current'}},update=vi.spyOn(f.goals.demands,'update'),before=await f.goals.demands.get(f.goal.id)
 await expect(f.rpc.call('goal.start',{goalId:f.goal.id,operationId:'not-an-input',agentReference:f.reference,access} as never)).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
 await expect(f.rpc.call('goal.start',{goalId:f.goal.id,operationId:'not-a-resume',agentReference:f.reference,access,resumeOriginal:true} as never)).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
 let failure:unknown
 await f.rpc.call('goal.update',{goalId:f.goal.id,patch:{description:'This must not be written',assigneeSessionIds:[f.reference]},relationAccess:[{reference:f.reference,access}]} as never).catch(error=>{failure=error})
 expect(update).not.toHaveBeenCalled();expect(failure).toMatchObject({code:'INVALID_CONTROL_REQUEST'})
 expect(await f.goals.demands.get(f.goal.id)).toEqual(before)
 expect(f.send).not.toHaveBeenCalled();expect(f.raw).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()
 const raw={schemaVersion:5,requestId:'original-read',operation:'demand.show',demandId:f.goal.id,dispatchOperationId:'original-OP',access:{source:{hostId:'local'},coordinator:{hostId:'D-current'}}}
 expect(parseAgentMuxControlRequest(raw)).toEqual(raw)
})

it('an independent read still refuses another canonical body and never falls back after the selected Coordinator denies access',async()=>{
 const f=await originalInput('Another producer body'),source=vi.spyOn(f.goalServer,'callRpc').mockRejectedValue(Error('No Source fallback'))
 await expect(f.rpc.call('goal.inspect',{goalId:f.goal.id,dispatchOperationId:f.operationId,access:{coordinator:{hostId:'D-current'}}} as never)).rejects.toMatchObject({code:'CONTROL_REQUEST_CONFLICT'})
 expect((await f.goals.demands.inspectDispatch(f.goal.id,f.operationId))?.receipt).toBeUndefined()
 const original=f.configuredD.forwardRpc,coordinator=vi.fn(async()=>{throw Object.assign(Error('Current Coordinator read denied'),{code:'CONTROL_PERMISSION_DENIED'})})
 f.configuredD.forwardRpc=coordinator;cleanup.push(()=>{if(original)f.configuredD.forwardRpc=original;else delete f.configuredD.forwardRpc})
 await expect(f.rpc.call('goal.inspect',{goalId:f.goal.id,dispatchOperationId:f.operationId,access:{coordinator:{hostId:'D-current'}}} as never)).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
 expect(coordinator).toHaveBeenCalledTimes(1);expect(source).not.toHaveBeenCalled();expect(f.send).toHaveBeenCalledTimes(1)
})
