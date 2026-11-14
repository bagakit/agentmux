import { join } from 'node:path'
import { startHeadlessAgentMux } from '../../../src/headless-runtime.ts'
import { defineAgentProvider } from '../../../src/agent-provider.ts'
import { AgentMuxSpatialStateStore } from '../../../src/spatial-state.ts'

// A controlled protocol leaf, not an installed model CLI. Real Core, Hook HTTP,
// durable stores, public RPC and the official ctxmux daemon remain unchanged.
const provider = defineAgentProvider({
  catalog: { id: 'private-main-protocol', label: 'Private main protocol', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'post-launch-only',
    readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'native', installation: 'unmanaged' },
    resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
  buildArgs: (_prompt, args) => [...args], buildResumeArgs: (_id, _path, _prompt, args) => [...args],
  hook: { rules: [], nativeHandle: { sessionIdKeys: ['native_id'] } },
  readInputInitialization: async () => ({ state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown' })
})
const owner = await startHeadlessAgentMux({ providers: [provider],
  socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock'),
  service: { spatialState: new AgentMuxSpatialStateStore(join(process.env.AGENTMUX_STATE_DIRECTORY, 'spatial-state.json')) } })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void owner.stop() })
