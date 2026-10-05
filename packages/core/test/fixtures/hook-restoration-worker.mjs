import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentHookServer } from '../../dist/hook-server.js'

// Observe actual owner allocations without changing admission or binding behavior.
// This worker and its trace live only in the fixture's isolated Runtime directory.
const createBinding = AgentHookServer.prototype.createBinding
AgentHookServer.prototype.createBinding = function (...args) {
  appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'hook-binding-trace.ndjson'), JSON.stringify({ agentSessionId: args[0] }) + '\n')
  return createBinding.apply(this, args)
}
await import('./headless-runtime-worker.mjs')
