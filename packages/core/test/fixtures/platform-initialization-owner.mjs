import { join } from 'node:path'
import { startHeadlessAgentMux, AgentProviderRegistry } from '../../src/index.ts'
const owner = await startHeadlessAgentMux({ providers: [new AgentProviderRegistry().get('grok')],
  socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
