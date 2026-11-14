import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { loadOrCreateRelayKeyPair } from '../../../packages/core/src/rpc-relay-keypair.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'
import type { MeshNetworkConfiguration, MeshNetworkSettings } from '../../../packages/core/src/mesh-network.js'
const cleanup: Array<() => void | Promise<void>> = [], roots: string[] = [], pids: number[] = []
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
afterEach(async () => {
 const errors: unknown[]=[];for(const close of cleanup.splice(0).reverse())try{await close()}catch(error){errors.push(error)}
 const rootFacts=await Promise.all(roots.splice(0).map(async path=>({path,absent:await access(path).then(()=>false,()=>true)})))
 await until(()=>pids.every(pid=>!alive(pid)),Boolean,'owned joined Mesh child cleanup',5000).catch(e=>errors.push(e))
 const processFacts=pids.splice(0).map(pid=>({pid,exited:!alive(pid)}));const passed=!errors.length&&rootFacts.every(r=>r.absent)&&processFacts.every(p=>p.exited)
 await writeFile(resolve('.local/state/mesh-network-access/join-cleanup.json'),JSON.stringify({passed,roots:rootFacts,processes:processFacts,errors:errors.map(String)},null,2))
 if(!passed)throw new AggregateError(errors,'Joined Mesh cleanup is unconfirmed')
})
async function port(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('Private listener port absent');await new Promise<void>(r=>server.close(()=>r()));return address.port}
it('actual multihop original input, stable circuits, alternate path, lost applied reply and owner/gateway restart retain original Native work and a healthy second publisher',async()=>{
 const root=await mkdtemp('/tmp/amux-mesh-join-');roots.push(root);cleanup.push(()=>rm(root,{recursive:true,force:true}))
 const home=join(root,'client');await mkdir(home);const key=await loadOrCreateRelayKeyPair(join(home,'.agentmux','relay-client-keypair.json')), publicKey=exportPublicKey(key.publicKey)
 const a=await headlessFixture({cli:true});cleanup.push(()=>a.cleanup());const b=await headlessFixture({cli:true});cleanup.push(()=>b.cleanup())
 const unknownOperation='mesh-joined-original-unknown'
 const c=await mobileWebFixture({nativeRecord:true,meshHoldOperationId:unknownOperation});cleanup.push(()=>c.close())
 const d=await mobileWebFixture({nativeRecord:true});cleanup.push(()=>d.close())
 const owners=[a,b,c.native,d.native];roots.push(...owners.map(o=>o.root));pids.push(...owners.flatMap(o=>[o.ownerProcess.pid!,o.nativeProcessId!]))
 let localC=await connectAgentMuxRpc({endpoint:{transport:'unix',path:c.native.socketPath}}),localB=await connectAgentMuxRpc({endpoint:{transport:'unix',path:b.socketPath}})
 const localA=await connectAgentMuxRpc({endpoint:{transport:'unix',path:a.socketPath}}),localD=await connectAgentMuxRpc({endpoint:{transport:'unix',path:d.native.socketPath}})
 for(const rpc of [localA,localB,localC,localD])cleanup.push(()=>rpc.dispose())
 const initial=await Promise.all([localA,localB,localC,localD].map(rpc=>until(()=>rpc.call('settings.mesh.inspect',{}),v=>v.identity!==null,'original network public identity')))
 const members=initial.map(s=>({peerId:s.identity!.peerId,publicKey:s.identity!.publicKey})),[pa,pb]=await Promise.all([port(),port()])
 const endpointA={endpoint:`127.0.0.1:${pa}`,useTls:false},endpointB={endpoint:`127.0.0.1:${pb}`,useTls:false}
 const configuration=(index:number,extra:Partial<MeshNetworkConfiguration>):MeshNetworkConfiguration=>({...initial[index]!.configuration,role:'participant',networkId:'private-joined-mesh',members,...extra})
 const configs=[configuration(0,{role:'gateway',listen:{host:'127.0.0.1',port:pa},advertisedIngress:[endpointA],peers:[{peerId:members[1]!.peerId,endpoints:[endpointB]}]}),configuration(1,{role:'gateway',listen:{host:'127.0.0.1',port:pb},advertisedIngress:[endpointB],peers:[0,2,3].map(index=>({peerId:members[index]!.peerId,endpoints:[]}))}),configuration(2,{peers:[{peerId:members[1]!.peerId,endpoints:[endpointB]}],endpointAccess:{allowedClientKeys:[publicKey]}}),configuration(3,{peers:[{peerId:members[1]!.peerId,endpoints:[endpointB]}],endpointAccess:{allowedClientKeys:[publicKey]}})]
 const cliEnv=objectCliEnvironment(root,{HOME:home}),cli=(url:string,args:string[])=>runCompiledObjectCli(['--endpoint',url,...args],cliEnv,'',30000)
 for(const [index,config] of configs.entries()){const path=join(root,`config-${index}.json`);await writeFile(path,JSON.stringify({expectedRevision:initial[index]!.revision,operationId:`mesh-join-initial-${index}`,configuration:config}));const configured=await cli('unix:'+owners[index]!.socketPath,['settings','mesh','configure','--input',path]);expect(configured.code,configured.stdout+configured.stderr).toBe(0)}
 const endpoint=async(rpc:typeof localA)=>{const value=await until(()=>rpc.call('mesh.inspect',{}),v=>v.endpoint.state==='available','original Host automatic publisher');if(value.endpoint.state!=='available')throw Error('Original offer missing');return value.endpoint.offer}
 const offerC=await endpoint(localC),offerD=await endpoint(localD)
 await until(()=>localA.call('mesh.inspect',{}),v=>v.network?.routes.some(r=>r.serverId===offerC.serverId&&r.hops===2)===true&&v.network.routes.some(r=>r.serverId===offerD.serverId&&r.hops===2),'two original publishers require A-B-C/A-B-D physical hops')
 const linkedC=await localA.call('mesh.link',{offer:offerC}),linkedD=await localA.call('mesh.link',{offer:offerD})
 expect(linkedC.observation.route.path).toEqual([0,1,2].map(i=>members[i]!.peerId));expect(linkedD.observation.route.hops).toBe(2)
 const connect=async(offer:typeof offerC)=>{const rpc=await connectAgentMuxRpc({endpoint:{transport:'relay',offer},relayKeyPair:key});cleanup.push(()=>rpc.dispose());return rpc}
 let remoteC=await connect(linkedC.offer);const remoteD=await connect(linkedD.offer)
 const beforeOwnerC=c.native.owner,beforeRunC=(await c.client.statusAgent(c.session.agentSessionId)).run!,beforeRunD=(await d.client.statusAgent(d.session.agentSessionId)).run!
 pids.push(beforeRunC.pid!,beforeRunD.pid!)
 const stream:string[]=[],ends:unknown[]=[];const subscription=await remoteC.subscribe('agent.output',{agentSessionId:c.session.agentSessionId,afterByte:0,follow:true},{onInitial:v=>expect(v.run.runId).toBe(c.session.run.runId),onEvent:e=>{if(e.type==='output')stream.push(Buffer.from(e.data.dataBase64,'base64').toString('utf8'))},onEnd:e=>ends.push(e)});cleanup.push(()=>subscription.dispose())
 const nativePath=(fixture:typeof c)=>join(fixture.native.env.HOME!,'.codex','sessions','rollout-'+fixture.session.agentSessionId+'.jsonl')
 const messages=async(fixture:typeof c)=>(await readFile(nativePath(fixture),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(v=>v.type==='response_item'&&v.payload?.type==='message'&&v.payload.role==='user').map(v=>v.payload.content.map((p:{text?:string})=>p.text??'').join('')) as string[]
 const submit=async(fixture:typeof c,url:string,operationId:string,prompt:string,predecessor:string|null)=>{const path=join(root,operationId+'.json');await writeFile(path,JSON.stringify({prompt,expectedRun:fixture.session.run,afterSubmissionId:predecessor,execution:'immediate'}));return await cli(url,['agent','input','submit','--session',fixture.session.agentSessionId,'--operation-id',operationId,'--input',path])}
 await until(()=>c.client.statusAgent(c.session.agentSessionId),v=>v.observation.semantic==='idle','original C semantic idle')
 const firstId='mesh-joined-first',firstPrompt='actual-multihop-before-alternate';const first=await submit(c,linkedC.url,firstId,firstPrompt,null);expect(first.code,first.stdout+first.stderr).toBe(0)
 const firstAccepted=await until(()=>messages(c),v=>v.filter(text=>text.includes(firstPrompt)).length===1,'original Native accepted first prompt once'),firstBody=firstAccepted.find(text=>text.includes(firstPrompt))!
 await until(()=>stream.join('').replaceAll('\r\n','\n'),v=>v.includes(`codex-submit:${firstBody}:accepted`.replaceAll('\r\n','\n')),'exact full Native body delivered by original 2-hop live SDK stream')
 const proveOriginalReader=async(operationId:string,prompt:string,predecessor:string)=>{await until(()=>c.client.statusAgent(c.session.agentSessionId),v=>v.observation.semantic==='idle','original semantic idle before live-reader proof');const result=await submit(c,linkedC.url,operationId,prompt,predecessor);expect(result.code,result.stderr).toBe(0);const accepted=await until(()=>messages(c),v=>v.filter(text=>text.includes(prompt)).length===1,'new exact Native body for the original old-path reader'),body=accepted.find(text=>text.includes(prompt))!;await until(()=>stream.join('').replaceAll('\r\n','\n'),v=>v.includes(`codex-submit:${body}:accepted`.replaceAll('\r\n','\n')),'the same original 2-hop subscription delivered new bytes after topology changed');expect(ends).toHaveLength(0)}
 const save=async(rpc:typeof localA,operationId:string,configuration:MeshNetworkConfiguration)=>{const current=await rpc.call('settings.mesh.inspect',{});const result=await rpc.call('settings.mesh.configure',{expectedRevision:current.revision,operationId,configuration});expect(result.diskDurability).toBe('confirmed');await until(()=>rpc.call('mesh.inspect',{}),v=>v.activeRevision===result.settings.revision,'hot original configuration applied')}
 const alternateA={...configs[0]!,peers:[...configs[0]!.peers,{peerId:members[2]!.peerId,endpoints:[]}]},alternateC={...configs[2]!,peers:[...configs[2]!.peers,{peerId:members[0]!.peerId,endpoints:[endpointA]}]}
 await save(localA,'mesh-join-add-direct-admission',alternateA);await save(localC,'mesh-join-add-shorter-path',alternateC)
 await until(()=>localA.call('mesh.inspect',{}),v=>v.network?.routes.some(r=>r.serverId===offerC.serverId&&r.hops===1)===true,'new circuits use authenticated shorter physical route')
 const shorter=await localA.call('mesh.link',{offer:offerC});expect(shorter.offer.daemonPublicKeyB64).toBe(offerC.daemonPublicKeyB64);expect(shorter.observation.route.path).toEqual([members[0]!.peerId,members[2]!.peerId])
 const shortReader=await connect(shorter.offer);expect((await shortReader.call('runtime.owner.identity',{})).owner.runtimeId).toBe(beforeOwnerC.runtimeId)
 await proveOriginalReader('mesh-joined-after-shorter','original-two-hop-reader-after-shorter-path',firstId)
 const both=await localA.call('mesh.inspect',{});expect(both.network!.circuits.some(circuit=>circuit.serverId===offerC.serverId&&circuit.path.length===3)).toBe(true);expect(both.network!.circuits.some(circuit=>circuit.serverId===offerC.serverId&&circuit.path.length===2)).toBe(true)
 await save(localA,'mesh-join-remove-shorter-path',configs[0]!);await save(localC,'mesh-join-remove-outgoing-shorter',configs[2]!)
 await until(()=>localA.call('mesh.inspect',{}),v=>v.network?.routes.some(r=>r.serverId===offerC.serverId&&r.hops===2)===true,'withdrawn direct edge returns new circuits to A-B-C')
 await proveOriginalReader('mesh-joined-after-withdrawal','original-two-hop-reader-after-path-withdrawal','mesh-joined-after-shorter')
 expect((await remoteD.call('runtime.owner.identity',{})).owner.runtimeId).toBe(d.native.owner.runtimeId);expect((await d.client.statusAgent(d.session.agentSessionId)).run).toMatchObject({runId:d.session.run.runId,pid:beforeRunD.pid,state:'running'})
 await until(()=>c.client.statusAgent(c.session.agentSessionId),v=>v.observation.semantic==='idle','C idle before selected response loss')
 const unknown=submit(c,linkedC.url,unknownOperation,'actual-mesh-applied-reply-lost','mesh-joined-after-withdrawal')
 const held=await until(async()=>JSON.parse(await readFile(join(dirname(c.native.env.AGENTMUX_AGENT_SESSION_STORE!),'mesh-held-response.json'),'utf8').catch(()=>'{}')),v=>v.operationId===unknownOperation&&v.result?.key?.submissionId===unknownOperation,'original Core completed real input before reply was withheld')
 await until(()=>messages(c),v=>v.filter(text=>text.includes('actual-mesh-applied-reply-lost')).length===1,'real original CLI accepted unknown prompt exactly once')
 const peerBeforeRestart=(await localC.call('settings.mesh.inspect',{})).identity!,nativePid=c.native.nativeProcessId
 await c.native.stopOwner();const lost=await unknown;expect(lost.code).not.toBe(0);expect(JSON.parse(lost.stderr)).toMatchObject({ok:false,operation:'agent.input.submit',operationId:unknownOperation,error:{code:'CONTROL_UNAVAILABLE'}})
 await until(()=>ends.length,v=>v>0,'original reader ends independently after owner loss')
 expect((await remoteD.call('runtime.owner.identity',{})).owner.runtimeId).toBe(d.native.owner.runtimeId)
 await until(()=>d.client.statusAgent(d.session.agentSessionId),v=>v.observation.semantic==='idle','healthy second publisher idle');const peerWrite=await submit(d,linkedD.url,'mesh-join-independent-peer','healthy-publisher-during-c-restart',null);expect(peerWrite.code,peerWrite.stderr).toBe(0)
 await c.native.restart();pids.push(c.native.ownerProcess.pid!);localC=await connectAgentMuxRpc({endpoint:{transport:'unix',path:c.native.socketPath}});cleanup.push(()=>localC.dispose())
 const restored=await c.native.client();expect(c.native.nativeProcessId).toBe(nativePid);expect(c.native.owner.runtimeId).toBe(beforeOwnerC.runtimeId);expect(c.native.owner.ownerInstanceId).not.toBe(beforeOwnerC.ownerInstanceId)
 expect((await restored.readAgentSession(c.session.agentSessionId))?.run).toEqual(c.session.run);expect((await restored.statusAgent(c.session.agentSessionId)).run).toMatchObject({runId:c.session.run.runId,pid:beforeRunC.pid,state:'running'})
 const afterEndpoint=await endpoint(localC);expect(afterEndpoint).toMatchObject({v:offerC.v,serverId:offerC.serverId,daemonPublicKeyB64:offerC.daemonPublicKeyB64})
 const peerAfterRestart=(await localC.call('settings.mesh.inspect',{})).identity!;await until(()=>localC.call('mesh.inspect',{}),v=>v.apply.state==='active','restarted original C participation active');const activePeer=(await localC.call('settings.mesh.inspect',{})).identity!
 expect(activePeer.peerId).toBe(peerBeforeRestart.peerId);expect(activePeer.publicKey).toBe(peerBeforeRestart.publicKey);expect(activePeer.epoch).toBeGreaterThan(peerBeforeRestart.epoch)
 await until(()=>localA.call('mesh.inspect',{}),v=>v.network?.routes.some(r=>r.serverId===offerC.serverId&&r.hops===2)===true,'original same publisher route after C owner restart')
 const afterLink=await localA.call('mesh.link',{offer:afterEndpoint});expect(afterLink.url).toBe(linkedC.url)
 remoteC=await connect(linkedC.offer);const inspected=await remoteC.call('agent.input.inspect',{key:held.result.key});expect(inspected.input?.key??inspected.record?.admission?.inputKey).toEqual(held.result.key)
 expect((await messages(c)).filter(text=>text.includes('actual-mesh-applied-reply-lost'))).toHaveLength(1)
 const dispatch=join(dirname(c.native.env.AGENTMUX_AGENT_SESSION_STORE!),'mesh-input-dispatch.jsonl');expect((await readFile(dispatch,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(v=>v.operationId===unknownOperation)).toHaveLength(1)
 const oldGateway=(await localB.call('settings.mesh.inspect',{})).identity!,oldBowner=b.owner,oldBnative=b.nativeProcessId
 await b.restart();pids.push(b.ownerProcess.pid!);localB=await connectAgentMuxRpc({endpoint:{transport:'unix',path:b.socketPath}});cleanup.push(()=>localB.dispose())
 await until(()=>localA.call('mesh.inspect',{}),v=>v.network?.routes.some(r=>r.serverId===offerC.serverId&&r.hops===2)===true&&v.network.routes.some(r=>r.serverId===offerD.serverId&&r.hops===2),'same original routes after intermediate gateway Core restart')
 const newGateway=(await localB.call('settings.mesh.inspect',{})).identity!;expect(newGateway.peerId).toBe(oldGateway.peerId);expect(newGateway.epoch).toBeGreaterThan(oldGateway.epoch);expect(b.nativeProcessId).toBe(oldBnative);expect(b.owner.runtimeId).toBe(oldBowner.runtimeId)
 const finalRead=await cli(linkedC.url,['agent','inspect','--session',c.session.agentSessionId]);expect(finalRead.code,finalRead.stderr).toBe(0);expect(JSON.parse(finalRead.stdout).result.session.run).toEqual(c.session.run)
 const finalRemote=await connect(linkedC.offer);const finalInput=await finalRemote.call('agent.input.inspect',{key:held.result.key});expect(finalInput.input?.key??finalInput.record?.admission?.inputKey).toEqual(held.result.key)
 expect((await messages(c)).filter(text=>text.includes('actual-mesh-applied-reply-lost'))).toHaveLength(1);expect((await restored.statusAgent(c.session.agentSessionId)).run).toMatchObject({pid:beforeRunC.pid,runId:c.session.run.runId,state:'running'})
 await writeFile(resolve('.local/state/mesh-network-access/join-behavior.json'),JSON.stringify({passed:true,scope:'Four actual original Core/Host processes and official private ctxmux daemons; controlled native Provider PTYs; public compiled CLI/SDK. No user work/CN1/App installation.',originalSession:c.session.agentSessionId,originalRun:c.session.run,originalNativePid:nativePid,originalCore:beforeOwnerC.runtimeId,originalDaemonKey:offerC.daemonPublicKeyB64,originalClientKey:publicKey,originalPublisher:offerC.serverId,multihopPath:linkedC.observation.route.path,shorterPath:shorter.observation.route.path,oldCircuitPreserved:true,originalSubscriptionExactNewPayloadAfterShorterAndWithdrawal:true,originalReaderEndsBeforeOwnerStop:0,withdrawalRetainedHealthySecondPublisher:true,appliedLostReplyKey:held.result.key,unknownDispatchCount:1,nativeAcceptCount:1,peerEpoch:{before:peerBeforeRestart.epoch,after:activePeer.epoch},gatewayEpoch:{before:oldGateway.epoch,after:newGateway.epoch},sameNativeRunAfterOwnerAndGatewayRestart:true},null,2))
},180000)
