import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const core=process.env.NODE_PUBLICATION_TEST_CORE
if(!core)throw Error('Private candidate Core required')
const load=name=>import(pathToFileURL(join(core,'dist',name+'.js')).href)
const {startHeadlessAgentMux}=await load('headless-runtime')
const {connectAgentMuxRpc}=await load('public-rpc-client')
const {connectHostedAgentMux}=await load('hosted-client')
let peer,peerRpc
if(process.env.NODE_PUBLICATION_TEST_PEER){
 peerRpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:process.env.NODE_PUBLICATION_TEST_PEER}})
 peer=await connectHostedAgentMux({rpc:peerRpc,expectedRuntimeId:process.env.NODE_PUBLICATION_TEST_PEER_RUNTIME,
  forwardRpc:async(method,params,context={})=>peerRpc.call(method,params,{...(context.caller?{credentials:context.caller}:{}),...(context.runtimeFence?{runtimeFence:context.runtimeFence}:{}),...(context.signal?{signal:context.signal}:{})})})
}
const owner=await startHeadlessAgentMux({socketPath:join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'headless.sock'),coreClients:()=>peer?[{hostId:'remote-b',client:peer}]:[],...(peer&&process.env.NODE_PUBLICATION_TEST_DESKTOP_ROUTE==='1'?{service:{callOriginalCore:async(hostId,method,params,context)=>{if(hostId!=='remote-b')throw Error('Exact private Desktop Host route unavailable');return peer.forwardRpc(method,params,context)}}}:{})})
process.stdout.write(JSON.stringify({owner:owner.ownerIdentity(),socketPath:owner.socketPath})+'\n')
const stop=()=>{void(async()=>{await owner.stop();await peer?.dispose();await peerRpc?.dispose();process.exit(0)})().catch(error=>{process.stderr.write(String(error));process.exit(1)})}
process.once('SIGTERM',stop);process.once('SIGINT',stop)
