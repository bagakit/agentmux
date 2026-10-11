import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const core = await import(process.env.AGENTMUX_TEST_CONTINUITY_SUPERVISION_ENTRY)
const provider = core.defineAgentProvider({ catalog: { id: 'resume-process', label: 'Controlled resume process', executable: process.execPath,
  expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
  hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
  buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, prompt) => ['-e', config.program, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
const store = new core.AgentMuxFileAgentSessionStore(config.storePath), client = new core.AgentMuxClient({ store, providers: [provider] })
const inner = client
Object.defineProperty(inner.hookServer, 'port', { value: 0 })
const start = inner.kernel.start.bind(inner.kernel), input = inner.kernel.input.bind(inner.kernel)
let starts = 0, inputs = 0
inner.kernel.start = async request => { starts++; return await start(request) }
inner.kernel.input = async (...args) => { inputs++; return await input(...args) }
try {
  await client.connect()
  const initial = await store.readMetadata(config.agentSessionId)
  process.send({ kind: 'connected', initial })
  for (;;) {
    const current = await store.readMetadata(config.agentSessionId), root = current?.continuityOperations?.['automatic-root']
    if (root?.supervision?.attemptCount === 2 && root.supervision.phase === 'observing' &&
      (await inner.kernel.status(current.run.runId)).state.type === 'running') {
      process.send({ kind: 'restored', session: current, starts, inputs }); break
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await once(process, 'message')
} finally {
  await client.dispose()
  process.disconnect()
}
