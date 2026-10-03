import { AgentMuxClient,AgentMuxFileAgentSessionStore,AgentProviderRegistry } from '../../dist/index.js'
const provider=new AgentProviderRegistry().get('codex')
const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.argv[2]),providers:[{
 ...provider,
 async verifyPromptExecutionTransport(context){
  const started=performance.now()
  try{return await provider.verifyPromptExecutionTransport(context)}
  catch(error){console.error(JSON.stringify({phase:'private-child-transport-original-error',elapsedMs:performance.now()-started,
   name:error.name,code:error.code,message:error.message,stack:error.stack}));throw error}
 }
}]})
try{
 await client.connect()
 if(['--exit-after-interrupt-ack','--exit-after-refresh-ack'].includes(process.argv[4])){
  const input=client.kernel.input.bind(client.kernel)
  client.kernel.input=async(...args)=>{
   const accepted=await input(...args)
   // The private submitting process exits after Runtime acceptance but before
   // Core persists its ACK. A later process must join that exact receipt.
   if(args[1].data===(process.argv[4]==='--exit-after-refresh-ack'?'\x1b[I':'\x1b'))process.exit(73)
   return accepted
  }
 }
 await client.submitAgentPrompt(JSON.parse(process.argv[3]))
}finally{await client.dispose()}
