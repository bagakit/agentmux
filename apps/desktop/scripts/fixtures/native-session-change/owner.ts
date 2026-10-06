import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxControlServer, AgentMuxError, defaultAgentMuxControlSocketPath } from '@agentmux/core'
import { AgentMuxHostedRuntimeService } from '../../../../../packages/core/src/hosted-runtime-service'
const privateRoot=process.argv[2],storePath=path.join(privateRoot,'agent-sessions.json')
const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(storePath)})
// Only native config installation is isolated. This fixture posts the actual issued Hook ingress.
;(client as any).ensureManagedHooks=async()=>undefined
await client.connect()
client.onEvent(event=>{if(event.type==='agent-error'||event.type==='agent-hook')void fs.appendFile(path.join(privateRoot,'owner-diagnostic.jsonl'),JSON.stringify(event)+'\n')})
const identity={runtimeId:'private-native-source-host',ownerInstanceId:randomUUID(),protocolVersion:2,processId:process.pid,ctxmux:client.runtimeIdentity(),availability:'connected' as const}
const hosted=new AgentMuxHostedRuntimeService(client,storePath,()=>identity)
const server=new AgentMuxControlServer({socketPath:defaultAgentMuxControlSocketPath(),coreClients:()=>[{hostId:'local',client}],hostedRuntime:()=>hosted})
await server.start()
const kernel=(client as any).kernel,write=kernel.input.bind(kernel)
kernel.input=async(runId:string,input:any)=>{
 const ack=await write(runId,input),flag=path.join(privateRoot,'lose-next-user-ack')
 if(await fs.stat(flag).catch(()=>null)) {
  await fs.rm(flag);await fs.writeFile(path.join(privateRoot,'lost-ack.json'),JSON.stringify({runId,input,ack}))
  throw new AgentMuxError('Private transport lost one already accepted input receipt.','PRIVATE_ACK_LOST','unknown')
 }
 return ack
}
process.send?.({ready:true,pid:process.pid,identity,storePath,socket:server.path})
process.on('message',async(message:any)=>{
 if(message?.operation!=='shutdown')return
 try { for(const session of client.agentSessions()) { const status=await client.statusAgent(session.agentSessionId);if(status.run.state==='running')await client.stopAgent(session.agentSessionId,session.run) }await server.stop();await hosted.dispose();await client.dispose();process.send?.({stopped:true});process.exit(0) }catch(error){process.send?.({stopped:false,error:String(error)});process.exit(1)}
})
