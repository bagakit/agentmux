import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux, defineAgentProvider, AgentMuxFileAgentSessionStore, AgentMuxError } from '../../src/index.ts'

const state = process.env.AGENTMUX_STATE_DIRECTORY
const launches = join(state, 'native-launches.ndjson'), activity = join(state, 'native-activity.json')
const program = `require('node:fs').appendFileSync(${JSON.stringify(launches)},JSON.stringify(process.argv.slice(1))+'\\n');process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('LIVE:'+d));console.log('NATIVE_READY');setInterval(()=>{},1000)`
const base = defineAgentProvider({ catalog: { id: 'startup-policy', label: 'Private native activity', executable: process.execPath,
  expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
  hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
  buildArgs: prompt => ['-e', program, 'original-native', ...(prompt ? [prompt] : [])],
  buildResumeArgs: (id, _path, prompt) => ['-e', program, id, ...(prompt ? [prompt] : [])],
  discoverNativeSession: async () => ({ handle: { kind: 'provider', providerId: 'startup-policy', sessionId: 'original-native' }, assertCurrent: async () => {} }),
  observeSessionStatus: async ({ onStatus }) => {
    if (!existsSync(activity)) writeFileSync(activity, JSON.stringify({ observedAt: Date.now(), state: 'working' }))
    const original = JSON.parse(readFileSync(activity, 'utf8'))
    if (original.observedAt === undefined) { original.observedAt = Date.now(); writeFileSync(activity, JSON.stringify(original)) }
    onStatus({ recordId: 'original-record', nativeTurnId: 'original-turn', state: original.state,
      nativeObservedAt: original.observedAt, ...(original.state === 'done' ? { endReason: 'completed' } : {}) })
    return { dispose() {} }
  }, hook: { rules: [] } })
const provider = { ...base, probeCapabilities: async (...args) => {
  if (existsSync(join(state, 'probe-hold'))) {
    writeFileSync(join(state, 'probe-entered'), 'original-probe')
    while (existsSync(join(state, 'probe-hold'))) await new Promise(resolve => setTimeout(resolve, 10))
  }
  return await base.probeCapabilities(...args)
} }
const store = new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE)
const readLifecycle = store.readLifecycleReservation.bind(store)
let gateGeneration, gateReads = 0
store.readLifecycleReservation = async (...args) => {
  if (existsSync(join(state, 'lifecycle-unavailable'))) throw new AgentMuxError('Original lifecycle read unavailable', 'CONTROL_UNAVAILABLE')
  const hold = join(state, 'lifecycle-hold')
  if (existsSync(hold)) {
    const generation = readFileSync(hold, 'utf8')
    if (generation !== gateGeneration) { gateGeneration = generation; gateReads = 0 }
    if (++gateReads === 2) {
      writeFileSync(join(state, 'lifecycle-entered'), JSON.stringify({ read: gateReads }))
      while (existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return await readLifecycle(...args)
}
const owner = await startHeadlessAgentMux({ store, providers: [provider], socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
