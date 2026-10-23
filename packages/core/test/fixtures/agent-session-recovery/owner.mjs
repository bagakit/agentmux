import { join } from 'node:path'
import { startHeadlessAgentMux } from '../../../src/headless-runtime.ts'

const owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
