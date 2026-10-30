import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
const closes:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close()})
it('actual schedule update CLI retains the original paused Host arrangement and exposes its exact operation receipt',async()=>{
  const f=await rpcOwnerFixture(['main'],core);closes.push(f.close)
  const manager=new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(f.root,'loops.json')),async()=>{throw Error('No automatic input was authorized')},()=>100000,async()=>{throw Error('No due observation was requested')},{saveFutureIntent:async(loop,active)=>{await f.client.saveAgentFuturePromptIntent({agentSessionId:loop.agentSessionId,expectedRun:f.client.agentSession(loop.agentSessionId).run,intentId:loop.futureIntentId!,operationId:loop.creationOperationId!,prompt:loop.prompt,active})}})
  closes.push(()=>manager.stop())
  const server=new core.AgentMuxControlServer({socketPath:join(f.root,'schedule.sock'),schedules:manager});await server.start();closes.push(()=>server.stop())
  async function call(action:string,input:unknown){return await new Promise<any>((yes,no)=>{
    const child=spawn(process.execPath,['--experimental-transform-types','--import',resolve(import.meta.dirname,'mote-presence-node-loader.mjs'),resolve(import.meta.dirname,'../../../packages/core/src/agentmux.ts'),'--endpoint','unix:'+server.path,'schedule',action,'--data','-'],{env:objectCliEnvironment(f.root),stdio:['pipe','pipe','pipe']})
    let out='',err='';child.stdout.on('data',value=>out+=value);child.stderr.on('data',value=>err+=value);child.once('error',no);child.once('close',code=>code===0?yes(JSON.parse(out).result):no(Error(err)));child.stdin.end(JSON.stringify(input))
  })}
  const created=await call('create',{target:{hostId:'local',agentSessionId:'main',providerId:'codex',workspacePath:f.root},everyMs:60000,prompt:'Retained original private work',operationId:'cli-original-create'})
  const id=created.schedule.loopId,deadline=created.schedule.nextCheckAt
  const paused=await call('pause',{scheduleId:id,expectedRevision:created.schedule.revision,operationId:'cli-original-pause'})
  const updated=await call('update',{scheduleId:id,expectedRevision:paused.schedule.revision,operationId:'cli-original-update',everyMs:120000})
  expect(updated).toMatchObject({executionScope:'connected-host',diskDurability:'confirmed',schedule:{loopId:id,status:'paused',everyMs:120000,nextCheckAt:deadline}})
  expect(await call('inspect',{operationId:'cli-original-update'})).toMatchObject({schedule:{loopId:id,revision:updated.schedule.revision,lastMutation:{operationId:'cli-original-update'}}})
  expect(f.rawInput).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
