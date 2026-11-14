// Private Core composition; original auth, Node owner and transports, no Agent launch.
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile, appendFile, readFile, access } from 'node:fs/promises'
const core=process.env.NODE_PUBLICATION_TEST_CORE
const load=name=>import(pathToFileURL(join(core,'dist',name+'.js')).href)
const {startHeadlessAgentMux}=await load('headless-runtime')
const {connectAgentMuxRpc}=await load('public-rpc-client')
const {connectHostedAgentMux}=await load('hosted-client')
const clients=[],rpcs=[]
if(process.env.NODE_PUBLICATION_TEST_PEER){
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:process.env.NODE_PUBLICATION_TEST_PEER}});rpcs.push(rpc)
 const client=await connectHostedAgentMux({connectOnDemand:true,rpc,expectedRuntimeId:process.env.NODE_PUBLICATION_TEST_PEER_RUNTIME,
  forwardRpc:async(method,params,context={})=>{
   if(method==='settings.node.inspect'){
    const hold=join(process.env.AGENTMUX_STATE_DIRECTORY,'hold-node-inspection')
    if(await access(hold).then(()=>true,()=>false)){
     await writeFile(hold+'.ready','ready')
     while(await access(hold).then(()=>true,()=>false))await new Promise(resolve=>setTimeout(resolve,5))
    }
   }
   return rpc.call(method,params,{...(context.caller?{credentials:context.caller}:{}),...(context.runtimeFence?{runtimeFence:context.runtimeFence}:{}),...(context.signal?{signal:context.signal}:{})})}})
 clients.push({hostId:'remote-b',client})
 const address=JSON.parse(await readFile(join(dirname(dirname(process.env.NODE_PUBLICATION_TEST_PEER)),'s/http.json'),'utf8'))
 const limited=await connectAgentMuxRpc({endpoint:{transport:'http',url:'http://127.0.0.1:'+address.port,token:'private-device-fixture'}});rpcs.push(limited)
 const published=await connectHostedAgentMux({connectOnDemand:true,rpc:limited,expectedRuntimeId:process.env.NODE_PUBLICATION_TEST_PEER_RUNTIME,
  forwardRpc:(method,params,context={})=>limited.call(method,params,{...(context.runtimeFence?{runtimeFence:context.runtimeFence}:{}),...(context.signal?{signal:context.signal}:{})})})
 clients.push({hostId:'public-b',client:published})
}
const host={id:'remote-b',kind:'ssh',label:'Original operator B',hostname:'private-fixture.invalid',runtimeId:process.env.NODE_PUBLICATION_TEST_PEER_RUNTIME}
const runtime=await startHeadlessAgentMux({socketPath:join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'headless.sock'),coreClients:()=>clients,
 http:{host:'127.0.0.1',port:0,authorize:request=>request.headers.get('authorization')==='Bearer private-device-fixture'?{principal:{kind:'device',id:'private-device'}}:null},
 service:{hostConfiguration:id=>clients.some(x=>x.hostId===id)?{...host,id}:null}})
await writeFile(join(process.env.AGENTMUX_STATE_DIRECTORY,'http.json'),JSON.stringify(runtime.server.httpAddress))
const service=runtime.server.service,call=service.call.bind(service)
service.call=async(method,params,context)=>{await appendFile(join(process.env.AGENTMUX_STATE_DIRECTORY,'calls.jsonl'),JSON.stringify({method,managed:!!context?.caller})+'\n');
 // Legacy Node readers did not enforce the incoming fence. Only that existing
 // receiver behavior is simulated here; auth and actual Node response remain real.
 if(method==='settings.node.inspect'&&process.env.NODE_OPERATOR_LEGACY_NODE_FENCE==='1'){const{runtimeFence:_ignored,...original}=context;context=original}
 return call(method,params,context)}
process.stdout.write(JSON.stringify({owner:runtime.ownerIdentity(),socketPath:runtime.socketPath})+'\n')
const stop=()=>void(async()=>{await runtime.stop();for(const c of clients)await c.client.dispose();for(const r of rpcs)await r.dispose();process.exit(0)})().catch(e=>{process.stderr.write(String(e));process.exit(1)})
process.once('SIGTERM',stop);process.once('SIGINT',stop)
