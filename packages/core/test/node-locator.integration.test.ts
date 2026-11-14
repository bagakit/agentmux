import { createServer } from 'node:http'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nodeRuntimeFixture } from './helpers/node-publishing-runtime.js'
const out=process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT?undefined:await mkdtemp('/tmp/nnp-locate-build-')
const compiled=process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT??(await(await import('./helpers/compile-core-source.mjs')).buildCandidateCore(resolve(import.meta.dirname,'../../..'),out!)).core
afterAll(async()=>{if(out)await rm(out,{recursive:true,force:true})})
const {connectHostedAgentMux}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/hosted-client.js')).href) as typeof import('../src/hosted-client.js')
const cleanups:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{const failures:unknown[]=[];for(const close of cleanups.splice(0).reverse()){try{await close()}catch(error){failures.push(error)}}if(failures.length)throw new AggregateError(failures,'Private Node locator cleanup failed')})
it('the original locator RPC and CLI resolve actual two-Core aliases, carriers, rename and unavailable scope',async()=>{
 const worker=resolve(import.meta.dirname,'fixtures/node-locator-core.mjs')
 const b=await nodeRuntimeFixture(undefined,false,compiled,worker);cleanups.push(()=>b.cleanup())
 const a=await nodeRuntimeFixture(b,false,compiled,worker);cleanups.push(()=>a.cleanup())
 async function save(scope:typeof a,alias:string,operationId:string){const initial=await scope.rpc.call('settings.node.inspect',{});return await scope.rpc.call('settings.node.configure',{expectedRevision:initial.policyRevision,operationId,policy:{alias,shareResources:false,allowedPaths:[],deniedPaths:[],defaultPath:null}})}
 const help=await a.cli(['node','locate','--help']);expect(help.code).toBe(0);expect(help.stdout).toContain('--expected-runtime')
 const guide=await a.cli(['node','--skill']);expect(guide.code).toBe(0);expect(guide.stdout).toContain('node locate --alias')
 await expect(a.rpc.call('node.locate',{alias:'studio',hostId:'local'} as never)).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
 await save(b,'studio','b-publish-alias')
 const unique=await a.cli(['node','locate','--alias','studio']);expect(unique.code,unique.stdout+unique.stderr).toBe(0);expect(unique.value.result.status).toBe('unique');expect(unique.value.result.matches).toHaveLength(1);expect(unique.value.result.matches[0]).toMatchObject({hostId:'remote-b',hostIds:['remote-b','remote-b-secondary'],publication:{node:{runtimeId:b.owner.runtimeId}}})
 const missing=await a.cli(['node','locate','--alias','absent']);expect(missing.code).toBe(0);expect(missing.value.result.status).toBe('missing')
 await save(a,'studio','a-publish-alias')
 const collision=await a.rpc.call('node.locate',{alias:'studio'});expect(collision.status).toBe('ambiguous');expect(collision.matches.map(m=>m.publication.node.runtimeId).sort()).toEqual([a.owner.runtimeId,b.owner.runtimeId].sort());expect(collision.matches.find(m=>m.publication.node.runtimeId===a.owner.runtimeId)).toMatchObject({hostId:'local',hostIds:['local','self-alias']})
 await save(b,'renamed-node','b-rename-alias')
 const pinned=await a.cli(['node','locate','--alias','studio','--expected-runtime',b.owner.runtimeId]);expect(pinned.code).toBe(0);expect(pinned.value.result).toMatchObject({status:'unique',matches:[{hostId:'remote-b',publication:{node:{runtimeId:b.owner.runtimeId,alias:'renamed-node'}}}]})
 const wrong=await a.rpc.call('node.locate',{alias:'studio',expectedRuntimeId:'wrong-original-runtime'});expect(wrong.status).toBe('missing');expect(wrong.matches).toHaveLength(0)
 const sdk=await connectHostedAgentMux({rpc:a.rpc,expectedRuntimeId:a.owner.runtimeId});cleanups.push(()=>sdk.dispose());await sdk.connect();const run=await sdk.createTerminal({createOperationId:'locator-original-run',workspacePath:a.root,command:process.execPath,args:['-e','process.stdin.on("data",b=>process.stdout.write(b))']});cleanups.push(()=>sdk.stopTerminal({runId:run.runId}))
 await b.rpc.call('runtime.owner.shutdown',{fence:{runtimeId:b.owner.runtimeId,ownerInstanceId:b.owner.ownerInstanceId}})
 const deadline=Date.now()+20000
 let stopped=false
 while(!stopped){try{await b.rpc.call('system.endpoint',{})}catch{stopped=true}if(!stopped){if(Date.now()>deadline)throw Error('Private original B endpoint did not close');await new Promise(yes=>setTimeout(yes,20))}}
 const uncertain=await a.cli(['node','locate','--alias','studio']);expect(uncertain.value.result.status).toBe('unconfirmed')
 expect(uncertain.code).toBe(1);expect(uncertain.value.result.matches[0].hostId).toBe('local');expect(uncertain.value.result.issues.map((v:{hostId:string})=>v.hostId)).toEqual(['remote-b','remote-b-secondary'])
 const stillPinned=await a.rpc.call('node.locate',{alias:'old-local-alias',expectedRuntimeId:a.owner.runtimeId});expect(stillPinned.status).toBe('unique');expect(stillPinned.issues).toHaveLength(2)
 const ack=await sdk.writeTerminal({runId:run.runId},{operationId:'locator-preserved-input',ownerInstanceId:sdk.runtimeIdentity().instanceId,expectedByte:0,data:'still healthy\n'});expect(ack.acceptedThroughByte).toBe(Buffer.byteLength('still healthy\n'))
 const calls=(await readFile(join(a.stateDirectory,'locator-calls.ndjson'),'utf8')).trim().split('\n').map(v=>JSON.parse(v));expect(calls.length).toBeGreaterThan(0);expect(calls.every(call=>call.method==='node.inspect'&&call.params.hostId==='local')).toBe(true)
 if(process.env.AGENTMUX_NODE_TEST_EVIDENCE)await writeFile(join(process.env.AGENTMUX_NODE_TEST_EVIDENCE,'two-core-locator.json'),JSON.stringify({a:a.owner,b:b.owner,unique:unique.value,collision,pinned:pinned.value,wrong,uncertain:uncertain.value,stillPinned,originalRun:{runId:run.runId,pid:run.pid,input:ack},fixedCalls:calls,boundary:'Two real private Core processes and official isolated Native, authenticated Unix carriers plus self-carriers; no physical mesh/network or new Agent.'},null,2)+'\n')
},60000)

it('the actual typed client rejects a location result for another original Runtime',async()=>{
 const {connectAgentMuxRpc}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/public-rpc-client.js')).href) as typeof import('../src/public-rpc-client.js')
 const server=createServer(async(request,response)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const input=JSON.parse(Buffer.concat(chunks).toString());response.setHeader('Content-Type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{status:'unique',issues:[],matches:[{hostId:'local',hostIds:['local'],publication:{node:{runtimeId:'wrong-original',ownerInstanceId:'wrong-instance',alias:'studio'},policyRevision:'policy',resourcesShared:false,roots:[],landing:null}}]}}))})
 await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));cleanups.push(()=>new Promise<void>(yes=>server.close(()=>yes())))
 const address=server.address();if(!address||typeof address==='string')throw Error('Private HTTP fixture missing address')
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'http',url:`http://127.0.0.1:${address.port}/`,token:'private-protocol-fixture'}});cleanups.push(()=>rpc.dispose())
 await expect(rpc.call('node.locate',{alias:'studio',expectedRuntimeId:'original'})).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
})
it('an unavailable original Host scope stays unavailable and does not disclose private diagnostics',async()=>{
 const {AgentMuxControlServer}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/public-rpc-server.js')).href) as typeof import('../src/public-rpc-server.js')
 const {connectAgentMuxRpc}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/public-rpc-client.js')).href) as typeof import('../src/public-rpc-client.js')
 const root=await mkdtemp('/tmp/nnp-locate-scope-');cleanups.push(()=>rm(root,{recursive:true,force:true}))
 const server=new AgentMuxControlServer({socketPath:join(root,'scope.sock'),coreClients:()=>{throw Error('/private/unpublished/config-path')}});await server.start();cleanups.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
 await expect(rpc.call('node.locate',{alias:'studio'})).rejects.toMatchObject({code:'NODE_LOCATION_SCOPE_UNAVAILABLE'})
 try{await rpc.call('node.locate',{alias:'studio'});throw Error('Expected unavailable scope')}catch(error){expect(String(error)).not.toContain('/private/unpublished/config-path')}
})

it('locating without an admitted Host scope never initializes a fallback Native client',async()=>{
 const {AgentMuxControlServer}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/public-rpc-server.js')).href) as typeof import('../src/public-rpc-server.js')
 const {connectAgentMuxRpc}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/public-rpc-client.js')).href) as typeof import('../src/public-rpc-client.js')
 const {AgentMuxClient}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/client.js')).href) as typeof import('../src/client.js')
 const native=vi.spyOn(AgentMuxClient.prototype,'connectRuntime').mockRejectedValue(Error('Unexpected fallback Native activation'));cleanups.push(async()=>native.mockRestore())
 const root=await mkdtemp('/tmp/nnp-locate-noscope-');cleanups.push(()=>rm(root,{recursive:true,force:true}));const server=new AgentMuxControlServer({socketPath:join(root,'scope.sock')});await server.start();cleanups.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
 await expect(rpc.call('node.locate',{alias:'studio'})).rejects.toMatchObject({code:'NODE_LOCATION_SCOPE_UNAVAILABLE'});expect(native).not.toHaveBeenCalled()
 const scoped=new AgentMuxControlServer({socketPath:join(root,'scoped.sock'),nodeLocatorHosts:()=>['local'],callOriginalCore:async()=>({node:{runtimeId:'original',ownerInstanceId:'instance',alias:'studio'},policyRevision:'policy',resourcesShared:false,roots:[],landing:null}) as never});await scoped.start();cleanups.push(()=>scoped.stop());const scopedRpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:scoped.path}});cleanups.push(()=>scopedRpc.dispose())
 expect((await scopedRpc.call('node.locate',{alias:'studio'})).status).toBe('unique')
 await expect(scopedRpc.call('node.locate',{alias:'studio'},{credentials:{agentSessionId:'claimed-original',capability:'unconfirmed-credential'}})).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'});expect(native).not.toHaveBeenCalled()

})

it('the complete configured locator scope includes an unprepared Host instead of claiming a live subset unique',async()=>{
 const {AgentMuxControlServer}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/public-rpc-server.js')).href) as typeof import('../src/public-rpc-server.js')
 const {connectAgentMuxRpc}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/public-rpc-client.js')).href) as typeof import('../src/public-rpc-client.js')
 const {NodePublishingOwner}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/node-publishing-owner.js')).href) as typeof import('../src/node-publishing-owner.js')
 const root=await mkdtemp('/tmp/nnp-locate-config-');cleanups.push(()=>rm(root,{recursive:true,force:true}));const owner=new NodePublishingOwner({stateDirectory:root,runtimeId:'configured-original',ownerInstanceId:'original-instance'});const initial=await owner.call('settings.node.inspect',{});await owner.call('settings.node.configure',{expectedRevision:initial.policyRevision,operationId:'publish-configured-local',policy:{alias:'studio',shareResources:false,allowedPaths:[],deniedPaths:[],defaultPath:null}})
 const server=new AgentMuxControlServer({socketPath:join(root,'scope.sock'),nodePublishing:owner,coreClients:()=>[],nodeLocatorHosts:()=>['local','not-prepared'],callOriginalCore:async()=>{throw Error('/private/not-prepared-route')}});await server.start();cleanups.push(()=>server.stop());const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
 const result=await rpc.call('node.locate',{alias:'studio'});expect(result.status).toBe('unconfirmed');expect(result.matches[0]?.hostId).toBe('local');expect(result.issues.map(issue=>issue.hostId)).toEqual(['not-prepared']);expect(JSON.stringify(result)).not.toContain('/private/not-prepared-route')
})
it('the public CLI preserves exact Session and Host focus conditions for the original Core parser',async()=>{
 const {parseAgentMuxCliInvocation}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/agentmux-cli-commands.js')).href) as typeof import('../src/agentmux-cli-commands.js')
 const {rpcControlRequest}=await import(/* @vite-ignore */pathToFileURL(join(compiled,'dist/rpc-business-codec.js')).href) as typeof import('../src/rpc-business-codec.js')
 const value=await parseAgentMuxCliInvocation(['space','focus','--region','original-region','--expect-session','same-sid','--expect-host','original-host']);expect(value.params).toMatchObject({expectedAgentSessionId:'same-sid',expectedAgentHostId:'original-host'});expect(rpcControlRequest('space.focus',value.params)).toMatchObject({operation:'focus',target:{kind:'space',regionId:'original-region'},expectedAgentSessionId:'same-sid',expectedAgentHostId:'original-host'})
 await expect(parseAgentMuxCliInvocation(['space','focus','--region','original-region','--expect-host','original-host'])).rejects.toMatchObject({code:'INVALID_CLI_ARGUMENT'})
 expect(()=>rpcControlRequest('space.focus',{target:{kind:'space',regionId:'original-region'},inputPolicy:'preserve',expectedAgentHostId:'original-host'})).toThrow()
})
