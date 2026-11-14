import { afterEach, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { createHostSpatialAgentControl } from '../../../apps/host/src/spatial-agent-control.js'
import type { AgentMuxHeadlessRuntime } from '../src/headless-runtime.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import { spatialAgentAssociationRecord, spatialAgentOpenRecord, pendingMoteMainStarts } from '../src/spatial-agent-open.js'
import { readSpaceSnapshot } from '../src/space-authority-stream.js'
import { observeSpaceSessionStates } from '../src/space-session-stream.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import type { SpaceSessionsObservation } from '../src/space-sessions.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup)
  await f.b.put('same-SID'); await f.d.put('same-SID')
  const state = (await f.b.spatial.read())!, folder = state.graph.spaces.find(space => space.spaceId === f.reference.spaceId)!, zone = state.graph.zones[0]!
  const forbidden = vi.fn(async () => { throw Error('A Source association must not resolve an execution carrier, create or send input') })
  const runtime = { client: f.b.core, ownerIdentity: () => f.b.owner, executionHost: forbidden, executionBindings: { create: forbidden, continueOriginal: forbidden } } as unknown as AgentMuxHeadlessRuntime
  const control = createHostSpatialAgentControl({ configurationPath: join(f.b.root,'no-config-required.json'), spatial: f.b.spatial, runtime: () => runtime })
  let loseReply = false
  const originalControl = Object.assign(async (...args: Parameters<typeof control>) => { const result = await control(...args); if (loseReply && args[0].operation === 'agent.open') { loseReply = false; throw new AgentMuxError('The original Source reply was lost after its durable association.', 'FIXTURE_LOST_ACK') }; return result }, { ...(control.describe ? { describe: control.describe } : {}) })
  let server = new AgentMuxControlServer({ socketPath: join(f.b.root,'source.sock'), spatialState: f.b.spatial, coreClients: () => [{ hostId: 'local', client: f.b.core }], hostedRuntime: () => f.b.hosted, spatialAgentControl: originalControl })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const reference = { kind: 'coordinator-agent' as const, runtimeId: 'runtime-A', binding: { bindingId: 'A-original-binding', agentSessionId: 'same-SID', createOperationId: 'A-original-C' } }
  const resource = { runtimeId: f.b.owner.runtimeId, workspaceId: zone.workspaceId, workspacePath: zone.directoryPath! }
  const input = { operationId: 'B-original-L', content: { kind: 'agent-session' as const, reference, expectedResource: resource }, destination: { spaceId: folder.spaceId, zoneId: zone.zoneId, newTab: true as const }, focus: false }
  const restart = async () => { await server.stop(); server = new AgentMuxControlServer({ socketPath: server.path, spatialState: f.b.spatial, coreClients: () => [{ hostId: 'local', client: f.b.core }], hostedRuntime: () => f.b.hosted, spatialAgentControl: originalControl }); await server.start() }
  return { ...f, rpc, input, coordinatorReference: reference, resource, forbidden, loseReply: () => { loseReply = true }, restart, get server() { return server } }
}

test('the actual Source Host/public owner admits only L and a safe placeholder despite a same-SID B Session', async () => {
  const f = await fixture(), lookup = vi.spyOn(f.b.core,'inspectAgentCreation'), input = vi.spyOn(f.b.core,'submitAgentPrompt')
  expect((await f.rpc.call('agent.open.describe',{expectedRuntimeId:f.reference.runtimeId})).contracts.externalAssociation).toBe(1)
  expect(rpcControlRequest('agent.open',f.input)).toBeDefined()
  const ack = await f.rpc.call('agent.open',f.input)
  expect(ack).toMatchObject({operationId:'B-original-L',outcome:'opened',agent:null,association:{operationId:'B-original-L',reference:f.input.content.reference,resource:f.resource},save:{diskDurability:'confirmed'}})
  const before = (await f.b.spatial.read())!, region = before.graph.regions.find(region=>region.regionId===ack.to!.regionId)!
  expect(region).toEqual({tabId:ack.to!.tabId,regionId:ack.to!.regionId,kind:'agent',agentSessionId:null,runId:null,execution:null,association:{operationId:'B-original-L'}})
  const original = spatialAgentAssociationRecord(before.graph,'B-original-L')!
  expect(original.reference.binding.createOperationId).toBe('A-original-C');expect(spatialAgentOpenRecord(before.graph,'B-original-L')).toBeNull()
  expect(JSON.stringify(before.graph.resources['region:'+region.regionId])).not.toContain('same-SID')
  const snapshot = await readSpaceSnapshot(f.rpc,f.reference)
  expect(snapshot.scope.regions.find(value=>value.regionId===region.regionId)).toEqual(region)
  await f.admit('local','runtime-b','same-SID','B-local-existing-C')
  const observations: SpaceSessionsObservation[] = [], reader=await observeSpaceSessionStates(f.rpc,{reference:f.reference},{onObservation:value=>observations.push(value)})
  cleanup.push(()=>reader.dispose())
  await vi.waitFor(()=>expect(observations).toContainEqual(expect.objectContaining({type:'member',member:{hostId:null,runtimeId:'runtime-A',agentSessionId:'same-SID'},state:{status:'unavailable',issue:expect.objectContaining({code:'SPACE_MEMBER_EXTERNAL_COORDINATOR'})}})))
  await vi.waitFor(()=>expect(observations.some(value=>value.type==='member'&&value.member.runtimeId==='runtime-b'&&value.state.status==='observed')).toBe(true))
  expect(observations.some(value=>value.type==='member'&&value.member.runtimeId==='runtime-A'&&value.state.status==='observed')).toBe(false)
  await expect(f.rpc.call('space.member.call',{target:{reference:f.reference,regionId:region.regionId,runtimeId:'runtime-A',agentSessionId:'same-SID',expectedRun:{runId:'A-original-run'}},call:{method:'runtime.invoke',params:{consumerId:'original-member-reader',fence:{runtimeId:'runtime-A',ownerInstanceId:'A-instance'},invocation:{method:'readAgentSession',args:['same-SID']}}}})).rejects.toMatchObject({code:'SPACE_MEMBER_EXTERNAL_COORDINATOR'})
  expect(lookup).not.toHaveBeenCalled();expect(input).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled()
  for(const counter of [f.b.inventory,f.b.runs,f.b.all,f.d.inventory,f.d.runs,f.d.all]) expect(counter).not.toHaveBeenCalled()
  expect((await f.b.core.readAgentSession('same-SID'))!.run.runId).toBe('runtime-b-run-same-SID')
})

test('original Source L read/reentry keeps its immutable C/resource and original layout across owner reconnect and bulk capture', async () => {
  const f=await fixture(),ack=await f.rpc.call('agent.open',f.input),original=(await f.b.spatial.read())!,bytes=await readFile(f.b.spatial.path,'utf8')
  const inputFile=join(f.b.root,'original-association.json');await writeFile(inputFile,JSON.stringify({reference:f.input.content.reference,expectedResource:f.resource}))
  const cli=await runSourceObjectCli(['--endpoint','unix:'+f.server.path,'agent','open','--association',inputFile,'--space',f.reference.spaceId,'--zone',f.input.destination.zoneId,'--new-tab','--operation-id','B-original-L'],objectCliEnvironment(f.b.root))
  expect(cli.code,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result).toMatchObject({operationId:ack.operationId,to:ack.to,association:ack.association,save:{diskDurability:'unconfirmed'}})
  expect(await readFile(f.b.spatial.path,'utf8')).toBe(bytes)
  await f.restart()
  expect((await f.rpc.call('space.inspect',{target:{operationId:'B-original-L'}})).request).toMatchObject({operationId:'B-original-L',known:true,report:{association:ack.association,to:ack.to,save:{diskDurability:'unconfirmed'}}})
  await expect(f.rpc.call('agent.open',{...f.input,content:{...f.input.content,reference:{...f.input.content.reference,binding:{...f.input.content.reference.binding,createOperationId:'changed-C'}}}})).rejects.toMatchObject({code:'SPACE_REQUEST_CONFLICT'})
  const graph=structuredClone(original.graph);delete graph.regions[0]!.association
  await f.b.spatial.commit({expectedRevision:original.revision,graph})
  expect((await f.b.spatial.read())!.graph.regions[0]).toEqual(original.graph.regions[0])
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('Source rejects only the wrong resource/slot or unauthorized association and retains old creator/Mote readers', async () => {
  const f=await fixture(),before=await readFile(f.b.spatial.path,'utf8')
  await expect(f.rpc.call('agent.open',{...f.input,content:{...f.input.content,expectedResource:{...f.resource,runtimeId:'not-B'}}})).rejects.toMatchObject({code:'SPACE_RESOURCE_CHANGED'})
  await expect(f.rpc.call('agent.open',{...f.input,content:{...f.input.content,expectedResource:{...f.resource,workspacePath:'/another/project'}}})).rejects.toMatchObject({code:'SPACE_RESOURCE_CHANGED'})
  await expect(f.rpc.call('agent.open',{...f.input,focus:true})).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
  await expect(f.rpc.call('agent.open',{...f.input,content:{...f.input.content,reference:{...f.input.content.reference,binding:{} as never}}})).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
  expect(await readFile(f.b.spatial.path,'utf8')).toBe(before)
  const a=await rpcOwnerFixture(['same-SID']);cleanup.push(a.close)
  const foreign=await connectAgentMuxRpc({endpoint:{transport:'unix',path:f.server.path},credentials:a.credentials});cleanup.push(()=>foreign.dispose())
  await expect(foreign.call('agent.open',f.input)).rejects.toMatchObject({code:'AGENT_CAPABILITY_INVALID'})
  expect(await readFile(f.b.spatial.path,'utf8')).toBe(before)
  const managed=await connectAgentMuxRpc({endpoint:{transport:'unix',path:f.server.path},credentials:{agentSessionId:'same-SID',capability:'private-original-capability'}});cleanup.push(()=>managed.dispose())
  const settled=await managed.call('agent.open',f.input).then(value=>({value}),error=>({error}))
  expect(settled).toHaveProperty('value');if(!('value' in settled))throw Error('The exact legitimate B metadata writer should succeed')
  const admitted=settled.value,retained=await readFile(f.b.spatial.path,'utf8')
  expect(admitted).toMatchObject({outcome:'opened',agent:null,association:{reference:f.input.content.reference}})
  expect(a.rawInput).not.toHaveBeenCalled();expect(a.inner.kernel.stop).not.toHaveBeenCalled()
  await expect(f.rpc.call('agent.open',{...f.input,operationId:'B-other-L',destination:{spaceId:f.reference.spaceId,zoneId:f.input.destination.zoneId,tabId:admitted.to!.tabId,regionId:admitted.to!.regionId}})).rejects.toMatchObject({code:'SPACE_REGION_OCCUPIED'})
  expect(await readFile(f.b.spatial.path,'utf8')).toBe(retained)
  const creation=await f.admit('local','runtime-b','B-another-SID','B-existing-C'),graph=(await f.b.spatial.read())!.graph
  expect(spatialAgentOpenRecord(graph,creation.requestId)).toEqual(creation)
  expect(()=>pendingMoteMainStarts(graph,{spaceId:f.reference.spaceId,zoneId:f.input.destination.zoneId,expectedResource:{hostId:'local',workspaceId:f.resource.workspaceId,workspacePath:f.resource.workspacePath}})).not.toThrow()
  expect(f.forbidden).not.toHaveBeenCalled()
})


test('a lost Source write reply is reconciled from the original L without minting or replaying A creation', async () => {
  const f=await fixture();f.loseReply()
  await expect(f.rpc.call('agent.open',f.input)).rejects.toMatchObject({code:'FIXTURE_LOST_ACK'})
  const retained=await readFile(f.b.spatial.path,'utf8'),state=(await f.b.spatial.read())!,record=spatialAgentAssociationRecord(state.graph,'B-original-L')!
  const read=await f.rpc.call('space.inspect',{target:{operationId:'B-original-L'}})
  expect(read.request).toMatchObject({operationId:'B-original-L',known:true,report:{agent:null,association:{operationId:'B-original-L',reference:f.input.content.reference},to:record.address}})
  expect(await readFile(f.b.spatial.path,'utf8')).toBe(retained)
  const replay=await f.rpc.call('agent.open',f.input)
  expect(replay.to).toEqual(record.address);expect((await f.b.spatial.read())!.graph.regions).toHaveLength(1)
  expect(await readFile(f.b.spatial.path,'utf8')).toBe(retained);expect(f.forbidden).not.toHaveBeenCalled()
})

test('an unassembled Source refuses only the new reference before legacy forwarding and retains normal Source reads',async()=>{
  const f=await fixture(),forward=vi.fn(async()=>{throw Error('A legacy presentation owner cannot accept an external Coordinator reference')})
  const server=new AgentMuxControlServer({socketPath:join(f.b.root,'old-source.sock'),spatialState:f.b.spatial,coreClients:()=>[],hostedRuntime:()=>f.b.hosted,forwardControl:forward});await server.start();cleanup.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanup.push(()=>rpc.dispose())
  expect((await rpc.call('agent.open.describe',{expectedRuntimeId:f.reference.runtimeId})).contracts.externalAssociation).toBeNull()
  await expect(rpc.call('agent.open',f.input)).rejects.toMatchObject({code:'AGENT_OPEN_CONTRACT_UNCONFIRMED'})
  expect(forward).not.toHaveBeenCalled();expect((await readSpaceSnapshot(rpc,f.reference)).scope.regions).toEqual([])
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('the actual public CLI guide discovers the same association and frozen-witness boundaries',async()=>{
  const f=await fixture(),guide=await runSourceObjectCli(['space','--skill'],objectCliEnvironment(f.b.root))
  expect(guide.code,guide.stderr).toBe(0)
  expect(guide.stdout).toContain('Associate an independent original Coordinator')
  expect(guide.stdout).toContain('view:"association"')
  expect(guide.stdout).toContain('separately authenticated original SDK')
  expect(f.forbidden).not.toHaveBeenCalled()
  expect((await f.b.spatial.read())!.graph.regions).toEqual([])
})


test('unreadable association Regions stay explicit while a same-cut healthy neighbor and its later events remain observable',async()=>{
  const f=await fixture(),created=await f.rpc.call('agent.open',f.input)
  const second=await f.rpc.call('agent.open',{...f.input,operationId:'B-other-L'})
  await f.admit('local','runtime-b','same-SID','B-healthy-C')
  const prior: SpaceSessionsObservation[]=[],priorErrors: Error[]=[]
  const priorReader=await observeSpaceSessionStates(f.rpc,{reference:f.reference},{onObservation:value=>prior.push(value),onError:error=>priorErrors.push(error)});cleanup.push(()=>priorReader.dispose())
  await vi.waitFor(()=>expect(prior.some(value=>value.type==='member'&&value.member.runtimeId==='runtime-A')).toBe(true))
  // Inject faults into this test-owned original file only. Public writers cannot change owned records.
  const document=JSON.parse(await readFile(f.b.spatial.path,'utf8'))
  document.graph.resources['core:agent-open'].requests['B-original-L'].reference.binding={}
  document.graph.resources['core:agent-open'].requests['B-other-L'].placement.workspacePath='/wrong-original-resource'
  document.revision+=1;await writeFile(f.b.spatial.path,JSON.stringify(document))
  // Advance an actual Zone metadata cut; raw Space names may be projected from their label owner.
  const current=(await f.b.spatial.read())!;current.graph.zones[0]!.branch='diagnostic-cut'
  await f.b.spatial.commit({expectedRevision:current.revision,graph:current.graph})
  await vi.waitFor(()=>expect(prior.some(value=>value.type==='association')).toBe(true))
  expect(prior.some(value=>value.type==='removed'&&value.member.runtimeId==='runtime-A')).toBe(false)
  expect(priorErrors).toEqual([])
  const observations: SpaceSessionsObservation[]=[],errors: Error[]=[]
  const reader=await observeSpaceSessionStates(f.rpc,{reference:f.reference},{onObservation:value=>observations.push(value),onError:error=>errors.push(error)});cleanup.push(()=>reader.dispose())
  await vi.waitFor(()=>expect(observations.some(value=>value.type==='member'&&value.member.runtimeId==='runtime-b'&&value.state.status==='observed')).toBe(true))
  const diagnostics=observations.filter(value=>value.type==='association')
  expect(diagnostics).toHaveLength(2)
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({association:{regionId:created.to!.regionId,operationId:'B-original-L'},state:{status:'unavailable',issue:expect.objectContaining({code:'SPACE_SESSION_REFERENCE_UNAVAILABLE'})}}),
    expect.objectContaining({association:{regionId:second.to!.regionId,operationId:'B-other-L'},state:{status:'unavailable',issue:expect.objectContaining({code:'SPACE_SESSION_REFERENCE_UNCONFIRMED'})}})]))
  expect(diagnostics.every(value=>!('member' in value)&&!('runtimeId' in value))).toBe(true)
  await f.b.put('same-SID',99)
  await vi.waitFor(()=>expect(observations.some(value=>value.type==='member'&&value.member.runtimeId==='runtime-b'&&value.state.status==='observed'&&value.state.session.updatedAt===99)).toBe(true))
  expect(errors).toEqual([]);expect(f.forbidden).not.toHaveBeenCalled()
  const snapshot=await readSpaceSnapshot(f.rpc,f.reference)
  expect(snapshot.scope.regions.filter(value=>value.association).map(value=>value.association!.operationId).sort()).toEqual(['B-original-L','B-other-L'])
})
