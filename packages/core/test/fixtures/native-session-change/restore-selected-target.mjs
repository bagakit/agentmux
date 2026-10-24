import { AgentMuxClient } from '../../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../../src/agent-session-store.js'

// A fresh Core process hydrates the same durable owner without seeding or connecting a Run.
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(process.argv[2]) })
try {
  await Reflect.get(client, 'registry').load('local')
  process.stdout.write(JSON.stringify({ processId: process.pid, session: client.agentSession(process.argv[3]) }))
} finally { await client.dispose() }
