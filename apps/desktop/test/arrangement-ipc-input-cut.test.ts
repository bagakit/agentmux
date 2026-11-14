// @vitest-environment happy-dom
import { afterEach,expect,it,vi } from 'vitest'
import { join } from 'node:path'
import { bridge,owningBridge } from './helpers/first-execution-ipc-bridge'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { ContinuousProgressLoopStore } from '../../host/src/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../../host/src/continuous-progress-loop-manager.js'
import { createGoalRuntime } from '../../host/src/goal-runtime.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();bridge.invoke.mockClear();vi.restoreAllMocks();vi.unstubAllEnvs()})
async function fixture(){
 const h=await rpcOwnerFixture(['recipient']);cleanup.push(h.close)
 const cut=await h.store.admitRecoveryInputCut({operationId:'original-ipc-recovery',sourceSHA256:'a'.repeat(64)})
 if(cut.state!=='admitted')throw Error('Expected qualified cut')
 await Reflect.get(h.client,'registry').refresh('recipient',{runId:'run-recipient'})
 const target={hostId:'local',agentSessionId:'recipient',providerId:'codex',workspacePath:h.root}
 const store=new ContinuousProgressLoopStore(join(h.root,'loops.json')),runtime=createGoalRuntime({clients:h.coreClients,inputOccupied:async()=>false,checkIn:async()=>{throw Error('No check-in fixture')}})
 const manager=new ContinuousProgressLoopManager(store,async()=>{throw Error('No automatic Native fixture')},()=>100,(loop,tick,now,signal)=>runtime.observeContinuousProgress(loop,tick,now,signal),runtime);await manager.start();cleanup.push(()=>manager.stop())
 const server=new AgentMuxControlServer({socketPath:join(h.root,'actual-ipc.sock'),coreClients:h.coreClients,schedules:manager,progress:{call:(m,p,c)=>manager.callProgress(m,p,c)}});await server.start();cleanup.push(()=>server.stop())
 const ipc=await owningBridge({client:h.client,store:h.store,publicCoreEndpointPath:server.path,config:{...structuredClone(DEFAULT_CONFIG),workspaces:[{id:'fixture-workspace',hostId:'local',path:h.root,name:'Fixture',kind:'folder'}]}});cleanup.push(ipc.dispose)
 return{...h,target,cut,manager,store}
}
it('fresh restored-cut progress gesture crosses actual preload registered IPC Main Unix RPC Core and Host with the original epoch',async()=>{
 const f=await fixture()
 const inputEpoch=await bridge.api!.sessions.readInputEpoch('local')
 expect(inputEpoch).toBe(f.cut.inputEpoch)
 const result=await bridge.api!.continuousProgress.create(f.target,60_000,'new explicit original progress',undefined,inputEpoch!)
 expect(result.inputEpoch).toBe(f.cut.inputEpoch)
 expect(f.manager.list()[0]).toEqual(result);expect(await f.store.load()).toEqual([result])
 const call=bridge.invoke.mock.calls.find(([channel])=>channel==='continuousProgress:create')!
 expect(call[5]).toBe(f.cut.inputEpoch);expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('actual preload IPC never upgrades a legacy schedule request, while a new exact arrangement reaches the original Core future ledger',async()=>{
 const f=await fixture(),old={target:f.target,everyMs:60_000,prompt:'original retained text',operationId:'old-request'}
 await expect(bridge.api!.schedule.create(old)).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
 expect(f.manager.list()[0]).toMatchObject({creationOperationId:old.operationId,lastOutcome:'unknown',status:'paused'})
 expect(f.manager.list()[0]?.inputEpoch).toBeUndefined()
 const inputEpoch=(await bridge.api!.sessions.readInputEpoch('local'))!
 const fresh=await bridge.api!.schedule.create({...old,operationId:'new-explicit-request',inputEpoch})
 expect(fresh.schedule.inputEpoch).toBe(f.cut.inputEpoch)
 expect(await f.client.readAgentFuturePromptIntent('recipient',fresh.schedule.futureIntentId!)).toMatchObject({active:true,inputEpoch,operationId:'new-explicit-request'})
 expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
