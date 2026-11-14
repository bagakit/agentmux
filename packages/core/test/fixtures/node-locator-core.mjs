import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const core=process.env.NODE_PUBLICATION_TEST_CORE
if(!core)throw Error('Private candidate Core required')
const load=name=>import(pathToFileURL(join(core,'dist',name+'.js')).href)
const {startHeadlessAgentMux}=await load('headless-runtime')
const {connectAgentMuxRpc}=await load('public-rpc-client')
const {connectHostedAgentMux}=await load('hosted-client')
let peer,peerRpc,self,selfRpc
const routes=[]
if(process.env.NODE_PUBLICATION_TEST_PEER){
 peerRpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:process.env.NODE_PUBLICATION_TEST_PEER}})
 peer=await connectHostedAgentMux({rpc:peerRpc,expectedRuntimeId:process.env.NODE_PUBLICATION_TEST_PEER_RUNTIME,
  forwardRpc:async(method,params,context={})=>{if(method.startsWith('node.'))appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY,'locator-calls.ndjson'),JSON.stringify({method,params})+'\n');return peerRpc.call(method,params,{...(context.caller?{credentials:context.caller}:{}),...(context.runtimeFence?{runtimeFence:context.runtimeFence}:{}),...(context.signal?{signal:context.signal}:{})})}})
 routes.push({hostId:'remote-b',client:peer},{hostId:'remote-b-secondary',client:peer})
}
const owner=await startHeadlessAgentMux({socketPath:join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'headless.sock'),coreClients:()=>routes})
// A real configured second carrier of the same original Runtime, not a copied Node owner.
selfRpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:owner.socketPath}})
self=await connectHostedAgentMux({rpc:selfRpc,expectedRuntimeId:owner.ownerIdentity().runtimeId,forwardRpc:(method,params,context={})=>selfRpc.call(method,params,{...(context.signal?{signal:context.signal}:{})})})
routes.push({hostId:'self-alias',client:self})
process.stdout.write(JSON.stringify({owner:owner.ownerIdentity(),socketPath:owner.socketPath})+'\n')
const stop=()=>{void(async()=>{await owner.stop();await self.dispose();await selfRpc.dispose();await peer?.dispose();await peerRpc?.dispose();process.exit(0)})().catch(error=>{process.stderr.write(String(error));process.exit(1)})}
process.once('SIGTERM',stop);process.once('SIGINT',stop)
