import { AgentMuxClient,AgentMuxFileAgentSessionStore } from '../../dist/index.js'
const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.argv[2])})
try{await client.connect();await client.submitAgentPrompt(JSON.parse(process.argv[3]))}finally{await client.dispose()}
