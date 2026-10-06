import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { parseRpcHostedBootstrap } from '../src/rpc-native-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})
it('actual CLI and RPC bind execution to one original durable message and Core Provider plan',async()=>{
 const h=await rpcOwnerFixture(),path=join(h.root,'control.sock')
 h.inner.kernel.identity=()=>({daemonInstanceId:'fixture-runtime',protocolVersion:1,buildIdentity:'fixture'})
 const phase=vi.fn(async(_prompt:string,_operationId:string)=>({outcome:'admitted' as const,turnId:'exact-turn'}))
 const provider=(h.client as any).providers.get('codex')
 vi.spyOn(provider,'prepareNativePromptInput').mockResolvedValue({plan:{kind:'native-rpc',protocolId:'fixture-steer',sourceId:'source',actorId:'actor',threadId:'thread',expectedTurnId:'exact-turn'},
  assertCurrent:async()=>{},dispatch:phase,close:async()=>{}})
 const server=new AgentMuxControlServer({socketPath:path,coreClients:h.coreClients})
 await server.start();const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path},credentials:h.credentials})
 try{
  const args=['--endpoint','unix://'+path,'agent','send','--to-session','recipient','--text','exact immediate body','--execution','immediate','--operation-id','public-immediate-op']
  const cli=await runCompiledObjectCli(args,objectCliEnvironment(h.root,{AGENTMUX_AGENT_SESSION_ID:'caller',AGENTMUX_AGENT_CAPABILITY:h.capability}))
  expect(cli.code,cli.stderr).toBe(0);const result=JSON.parse(cli.stdout).result
  expect(phase).toHaveBeenCalledOnce()
  expect((h.client.agentSession('recipient').promptCompletionAdmission?.intent)).toMatchObject({execution:'immediate',plan:{kind:'native-rpc'}})
  expect(phase.mock.calls[0]![0]).toBe('[Message from Agent caller]\nexact immediate body')
  const params={sourceChannel:'cli' as const,target:{kind:'agent-session' as const,agentSessionId:'recipient'},text:'exact immediate body',execution:'immediate' as const,operationId:'public-immediate-op'}
  expect((await rpc.call('agent.send',params)).messageId).toBe(result.messageId);expect(phase).toHaveBeenCalledOnce()
  await expect(rpc.call('agent.send',{...params,execution:'default'})).rejects.toMatchObject({code:'MESSAGE_ID_CONFLICT'})
  await expect(rpc.call('agent.send',{...params,execution:'other' as any,operationId:'bad-mode'})).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
  const durable=await new DurableAgentMuxMessageQueue(join(h.root,'messages.ndjson')).listAfter(0)
  expect(durable).toHaveLength(1);expect(durable[0]!.execution).toBe('immediate');expect(durable[0]!.sourceChannel).toBe('cli')
  await h.client.submitAgentMessage({agentSessionId:'recipient',envelope:durable[0]!.envelope,condition:{expectedRun:{runId:'run-recipient'},afterSubmissionId:null},execution:'immediate',sourceChannel:'cli',caller:h.credentials})
  await expect(h.client.submitAgentMessage({agentSessionId:'recipient',envelope:durable[0]!.envelope,condition:{expectedRun:{runId:'run-recipient'},afterSubmissionId:null},execution:'default',caller:h.credentials})).rejects.toMatchObject({code:'MESSAGE_ID_CONFLICT'})
 }finally{await rpc.dispose();await server.stop();await h.close()}
},20000)

it('Hosted RPC preserves the declared strategy and rejects an unknown wire strategy', async () => {
 const h=await rpcOwnerFixture(),path=join(h.root,'hosted-control.sock')
 h.inner.kernel.identity=()=>({buildIdentity:'private-sdk',protocolVersion:1,daemonInstanceId:'private-sdk-owner'})
 const owner={runtimeId:'private-runtime',ownerInstanceId:'private-owner',protocolVersion:1 as const,processId:process.pid,ctxmux:h.client.runtimeIdentity(),availability:'connected' as const}
 const hosted=new AgentMuxHostedRuntimeService(h.client,join(h.root,'sessions.json'),()=>owner)
 const server=new AgentMuxControlServer({socketPath:path,coreClients:h.coreClients,hostedRuntime:()=>hosted})
 await server.start();const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path}})
 let reader:Awaited<ReturnType<typeof connectHostedAgentMux>>|undefined
 try {
  reader=await connectHostedAgentMux({rpc})
  expect(reader.catalog().find(entry=>entry.id==='codex')!.capabilities.promptExecution).toEqual({immediate:'native-steer'})
  const wire=structuredClone(hosted.bootstrap())
  const native=wire.catalog.find(entry=>entry.id==='codex')!
  native.capabilities.promptExecution={immediate:'unknown' as never}
  expect(()=>parseRpcHostedBootstrap(wire)).toThrow(/malformed/)
 } finally {await reader?.dispose();await rpc.dispose();await server.stop();hosted.dispose();await h.close()}
},15000)
