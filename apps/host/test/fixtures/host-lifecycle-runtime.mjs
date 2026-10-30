import { startHeadlessAgentMux } from '@agentmux/core'
import { join } from 'node:path'
const runtime = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
process.stdout.write(JSON.stringify({ owner: runtime.ownerIdentity(), socketPath: runtime.socketPath }) + '\n')
process.once('SIGTERM', () => { void runtime.stop() })
