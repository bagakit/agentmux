import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, hostAgentCreationIntent } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxError } from '../src/errors.js'
import { parseAgentOpenLaunchFields } from '../src/agent-open-contract.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import type { AgentMuxHostAgentCreateInput } from '../src/client-contract.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

test('the actual target public Hosted creation codec carries both notes to the one Core launch outlet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-open-contract-')); cleanups.push(() => rm(root,{recursive:true,force:true}))
  const launches: Array<{ prompt: string | undefined; args: readonly string[] }> = []
  const provider = defineAgentProvider({ catalog: { id:'contract-provider', label:'Contract provider', executable:process.execPath,
    expectedProcess:'node', promptDelivery:'positional-argv', readySignal:{kind:'foreground-process',expectedProcess:'node'},
    hookStrategy:{kind:'none'},resumeStrategy:{kind:'none'},acpStrategy:{kind:'none'},
    capabilities:{terminal:true,timeline:'unavailable',permission:'none',providerResume:false,replyCorrelation:'none'} },
    launchOptions:[{id:'mode',label:'Mode',choices:[{id:'selected',label:'Selected',argv:['--selected-native-choice']}]}],
    buildArgs:(prompt,args) => { launches.push({prompt,args}); throw new AgentMuxError('Captured at the real Provider outlet before Native Start.','FIXTURE_LAUNCH_CAPTURE') },hook:{rules:[]} })
  let core!: AgentMuxClient
  const executors = new AgentMuxHostExecutorOwner({path:join(root,'executors.json'),runtimeId:'target-runtime',catalog:()=>core.catalog()})
  core = new AgentMuxClient({store:new AgentMuxMemoryAgentSessionStore(),providers:[provider],hostExecutorOwner:executors,
    creationAuthority:new AgentMuxCreationAuthority({stateDirectory:root,runtimeId:'target-runtime'})})
  cleanups.push(()=>core.dispose())
  // Controlled Native connection leaf. All creation, Provider, transfer and RPC owners remain original.
  Reflect.set(core,'connected',true)
  vi.spyOn(Reflect.get(core,'kernel'),'isConnected').mockReturnValue(true)
  vi.spyOn(core,'connectRuntime').mockResolvedValue()
  const start = vi.spyOn(Reflect.get(core,'kernel'),'start').mockRejectedValue(Error('No Native Start belongs to this codec proof'))
  const owner = {runtimeId:'target-runtime',ownerInstanceId:'target-instance',protocolVersion:2 as const,processId:process.pid,availability:'connected' as const,ctxmux:null}
  const service = new AgentMuxHostedRuntimeService(core,null,()=>owner); cleanups.push(()=>service.dispose())
  const forward = vi.fn(async () => {throw new AgentMuxError('The original legacy prompt-only creator was reached.','FIXTURE_LEGACY_FORWARD')})
  const server = new AgentMuxControlServer({hostedRuntime:()=>service,forwardControl:forward},join(root,'rpc.sock')); await server.start();cleanups.push(()=>server.stop())
  const rpc = await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
  expect(await rpc.call('agent.open.describe',{expectedRuntimeId:owner.runtimeId})).toEqual({source:{runtimeId:owner.runtimeId,ownerInstanceId:owner.ownerInstanceId},contracts:{ordinaryLaunch:null,externalAssociation:null}})
  await expect(rpc.call('agent.open.describe',{expectedRuntimeId:'another-Source'})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
  const open = {operationId:'unassembled-open',content:{kind:'new-agent' as const,executorId:provider.id,agentMuxNote:'caller note'},destination:{spaceId:'source-space',zoneId:'source-zone',newTab:true as const},focus:false}
  await expect(rpc.call('agent.open',open)).rejects.toMatchObject({code:'AGENT_OPEN_CONTRACT_UNCONFIRMED'})
  expect(forward).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled()
  await expect(rpc.call('agent.open',{...open,content:{kind:'new-agent',executorId:provider.id,prompt:'original legacy prompt'}})).rejects.toMatchObject({code:'FIXTURE_LEGACY_FORWARD'})
  expect(forward).toHaveBeenCalledTimes(1)
  const inventory = await core.listHostExecutors({executorId:provider.id}), selected = inventory.executors[0]!
  expect(selected.creationContract).toEqual({ordinaryLaunch:1});expect(selected.launchOptions).toEqual(provider.catalog.launchOptions)
  const input: AgentMuxHostAgentCreateInput = {agentSessionId:'original-SID',createOperationId:'original-CID',executorId:provider.id,
    executorRevision:selected.configRevision,workspacePath:root,prompt:'  Exact <user> task\n',agentMuxNote:'  Caller note\n',sourceAgentMuxNote:'  Source context\n',
    launchOptions:{mode:'selected'},cols:117,rows:39}
  const digest = hostAgentCreationIntent(input)
  await expect(rpc.call('runtime.invoke',{consumerId:'contract-consumer',fence:{runtimeId:owner.runtimeId,ownerInstanceId:owner.ownerInstanceId},
    invocation:{method:'createHostAgentWithDelivery',args:[input]}})).rejects.toMatchObject({code:'FIXTURE_LAUNCH_CAPTURE'})
  expect(launches).toHaveLength(1);expect(launches[0]!.args).toEqual(['--selected-native-choice'])
  expect(launches[0]!.prompt).toContain('  Source context\n\n\n  Caller note\n')
  expect(launches[0]!.prompt?.endsWith('</amux>\n\n'+input.prompt)).toBe(true)
  expect(hostAgentCreationIntent(input)).toBe(digest);expect(hostAgentCreationIntent({...input,sourceAgentMuxNote:'another source'})).not.toBe(digest)
  expect(start).not.toHaveBeenCalled()
})

test('ordinary launch parsing preserves exact contributions without accepting a Source note from agent.open', () => {
  expect(parseAgentOpenLaunchFields({agentMuxNote:'  note\n',launchOptions:{},cols:1,rows:1})).toEqual({agentMuxNote:'  note\n',launchOptions:{},cols:1,rows:1})
  expect(()=>rpcControlRequest('agent.open',{operationId:'original',content:{kind:'new-agent',executorId:'selected',sourceAgentMuxNote:'not caller-owned'},destination:{spaceId:'source-space',zoneId:'source-zone',newTab:true},focus:false})).toThrow()
  for (const fields of [{cols:0},{rows:1.5},{agentMuxNote:4},{launchOptions:{mode:0}}]) expect(()=>parseAgentOpenLaunchFields(fields)).toThrow()
})
