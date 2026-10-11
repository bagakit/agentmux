import { join } from 'node:path'
import { startHeadlessAgentMux, AgentProviderRegistry } from '../../dist/index.js'

const original = new AgentProviderRegistry().get('codex')
const provider = process.env.AGENTMUX_RECOVERY_NATIVE_UNSUPPORTED === '1'
  ? { ...original, catalog: { ...original.catalog, capabilities: { ...original.catalog.capabilities, nativeInterruption: false } },
      readPromptExecutionEvidence: undefined }
  : original
const owner = await startHeadlessAgentMux({ providers: [provider], socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
