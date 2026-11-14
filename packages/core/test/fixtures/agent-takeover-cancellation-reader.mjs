import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { AgentMuxCreationAuthority } from '../../src/agent-creation-authority.js'
import { createHostSpatialAgentControl } from '../../../../apps/host/src/spatial-agent-control.js'
const [root, runtimeId, inputFile, sid, mode] = process.argv.slice(2)
const input=JSON.parse(await readFile(inputFile,'utf8')), original=await readFile(join(root,'spatial.json'),'utf8')
const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json')), client=new AgentMuxClient({store})
client.creationAuthority=new AgentMuxCreationAuthority({stateDirectory:join(root,'creation-authority'),runtimeId})
let controls=0
const forbidden=async()=>{controls++;throw Error('A cancelled original intent cannot dispatch Start, input or Stop.')}
Object.assign(client.kernel,{start:forbidden,startPrepared:forbidden,input:forbidden,stop:forbidden,connect:forbidden})
const owner={runtimeId,ownerInstanceId:'restarted-cancellation-reader',protocolVersion:2,processId:process.pid,ctxmux:null,availability:'connected'}
const spatial=new AgentMuxSpatialStateStore(join(root,'spatial.json')),hosted=new AgentMuxHostedRuntimeService(client,null,()=>owner)
let server,rpc
const runtime={client,ownerIdentity:()=>owner,get server(){return server}}
server=new AgentMuxControlServer({socketPath:join(root,'cancel-reader.sock'),spatialState:spatial,coreClients:()=>[{hostId:'local',client}],hostedRuntime:()=>hosted,
  spatialAgentControl:createHostSpatialAgentControl({configurationPath:join(root,'config.json'),spatial,runtime:()=>runtime})})
try {
  await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  const written=mode==='write'?await rpc.call('agent.takeover.cancel',input):null
  const checked=await rpc.call('agent.takeover.cancel.inspect',input)
  let replay
  try {await rpc.call('agent.open',input.request)}catch(error){replay=error.code}
  let held=false
  if(sid){
    await client.registry.load('local')
    const session=await store.readMetadata(sid)
    await client.continueInitialInput(session,{runId:session.run.runId,state:{type:'running'}})
    held=(await store.readCreationCancellation(input.request.operationId))?.operationId===input.operationId
  }
  console.log(JSON.stringify({pid:process.pid,written,checked,replay,controls,held,graphUnchanged:original===await readFile(join(root,'spatial.json'),'utf8')}))
}finally{await rpc?.dispose();await server.stop();await hosted.dispose();await client.dispose()}
