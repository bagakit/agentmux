import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const fact = phase => {
  if (process.env.HOST_LIFECYCLE_FACTS) appendFileSync(process.env.HOST_LIFECYCLE_FACTS, JSON.stringify({ phase, pid: process.pid }) + '\n')
}
fact('headless-source-import-started')
const { startHeadlessAgentMux } = await import('@agentmux/core')
fact('headless-source-imported')
const runtime = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
fact('headless-source-owner-started')
process.stdout.write(JSON.stringify({ owner: runtime.ownerIdentity(), socketPath: runtime.socketPath }) + '\n')
process.once('SIGTERM', () => { void runtime.stop() })
