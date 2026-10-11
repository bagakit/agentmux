import { readFile } from 'node:fs/promises'
const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const core = await import(config.entry)
const store = new core.AgentMuxFileAgentSessionStore(config.storePath)
const client = new core.AgentMuxClient({ store })
try {
  const result = await client.controlAgentContinuity(config.request)
  process.stdout.write(JSON.stringify(result) + '\n')
} finally { await client.dispose() }
