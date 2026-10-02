import { AgentMuxClient,AgentMuxFileAgentSessionStore } from '../../dist/index.js'
const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.argv[2])})
try{
 await client.connect()
 if(process.argv[4]==='--exit-after-interrupt-ack'){
  const input=client.kernel.input.bind(client.kernel)
  client.kernel.input=async(...args)=>{
   const accepted=await input(...args)
   // The private submitting process exits after Runtime acceptance but before
   // Core persists its ACK. A later process must join that exact receipt.
   if(args[1].data==='\x1b')process.exit(73)
   return accepted
  }
 }
 await client.submitAgentPrompt(JSON.parse(process.argv[3]))
}finally{await client.dispose()}
