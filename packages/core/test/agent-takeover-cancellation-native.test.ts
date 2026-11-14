import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { join } from 'node:path'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { expect, it, vi } from 'vitest'
import { fixture } from './helpers/prepared-resume-fixture.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { cleanups } from './helpers/prepared-resume-fixture.js'

it('actual Native retains a healthy original process when its Core creation metadata is missing during public Hosted cancellation',async()=>{
  const f=await fixture('positional-argv',false,'file','cancellation-process')
  const authority=new AgentMuxCreationAuthority({stateDirectory:join(f.root,'cancellation-authority'),runtimeId:'native-cancellation-core'})
  f.inner.creationAuthority=authority
  const createOperationId='native-cancellation-original',agentSessionId='native-cancellation-agent'
  const created=await f.client.createAgentWithDelivery({createOperationId,agentSessionId,providerId:f.provider.id,executorId:'cancellation-executor',
    workspacePath:f.root,args:f.request.args!,injectAgentMuxGuide:false})
  await vi.waitFor(async()=>expect((await f.inner.kernel.status(created.session.run.runId)).state.type).toBe('running'))
  const saved=await f.store.readMetadata(agentSessionId)
  await f.store.compareAndSwapMetadata(saved,null)
  expect(await f.store.readMetadata(agentSessionId)).toBeNull();expect(await f.store.loadCreationCorrelation(agentSessionId)).toBeNull()
  await f.client.dispose()
  const store=new AgentMuxFileAgentSessionStore((f.store as AgentMuxFileAgentSessionStore).path),client=new AgentMuxClient({store,providers:[f.provider],creationAuthority:authority}),inner=client as any
  const freshStart=vi.spyOn(inner.kernel,'startPrepared'),freshStop=vi.spyOn(inner.kernel,'stop'),freshInput=vi.spyOn(inner.kernel,'input')
  cleanups.push(async()=>{if(inner.kernel.isConnected())for(const run of await inner.kernel.list())if(run.state.type==='running')await inner.kernel.stop(await inner.kernel.prepareStop(run.runId));await client.dispose()})
  expect(inner.kernel.isConnected()).toBe(false)
  const input={createOperationId,agentSessionId,operationId:'native-cancellation-control'}
  const first=await client.cancelAgentCreation(input)
  expect(first).toMatchObject({outcome:'created',run:created.session.run,initialInput:'unknown'})
  expect(inner.kernel.isConnected()).toBe(true)
  const remote=await hostedTestClient(client);cleanups.push(()=>remote.dispose())
  remote.port.call=async(method,params,options)=>await remote.service.call(method,structuredClone(params),{...options,principal:{kind:'user',id:'native-cancellation-user'}}) as never
  const result=await remote.sdk.cancelAgentCreation(input)
  expect(result).toMatchObject({outcome:'created',run:created.session.run,initialInput:'unknown'})
  expect(await remote.sdk.inspectAgentCreationCancellation(input)).toMatchObject({outcome:'created',run:created.session.run,diskDurability:'unconfirmed'})
  expect((await inner.kernel.status(created.session.run.runId)).state.type).toBe('running')
  expect(freshStart).not.toHaveBeenCalled();expect(freshStop).not.toHaveBeenCalled();expect(freshInput).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled();expect(f.start).toHaveBeenCalledTimes(1);expect(f.inputCount()).toBe(0)
  expect(await store.readMetadata(agentSessionId)).toBeNull()
})
