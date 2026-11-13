import {
  AgentMuxClient,
  AgentMuxFileAgentSessionStore,
  defineAgentProvider,
  type AgentCatalogEntry,
  type AgentMuxRunRef
} from '../../src/index.js'

const input = JSON.parse(process.argv[2]!) as {
  storePath: string
  providerCatalog: AgentCatalogEntry
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  operationId: string
}

// Only the parent seeds this private SQLite store and owns the existing ctxmux.
// Each worker is a fresh Core observer; it neither recreates metadata nor owns Runs.
const provider = defineAgentProvider({
  catalog: { ...input.providerCatalog, hookStrategy: { kind: 'native', installation: 'explicit-managed' } },
  planManagedHooks: () => null,
  buildArgs: (_prompt, args) => [...args],
  buildResumeArgs: (id, _path, prompt, args) => [...args, id, ...(prompt ? [prompt] : [])],
  hook: { rules: [] }
})
const store = new AgentMuxFileAgentSessionStore(input.storePath)
const client = new AgentMuxClient({ store, providers: [provider] })
const inner = client as any
const counters = { start: 0, input: 0, stop: 0 }
const refuse = (kind: keyof typeof counters) => async () => {
  ++counters[kind]
  throw new Error(`An observation worker attempted ${kind}; no Runtime mutation was dispatched.`)
}

// Install before connect, so startup recovery cannot hide a lifecycle or input effect.
inner.kernel.start = refuse('start')
inner.kernel.startPrepared = refuse('start')
inner.kernel.input = refuse('input')
inner.kernel.stop = refuse('stop')
const openInput = inner.kernel.openInput.bind(inner.kernel)
const observedChannels = new WeakSet<object>()
inner.kernel.openInput = async (...args: unknown[]) => {
  const channel = await openInput(...args)
  if (!observedChannels.has(channel)) {
    observedChannels.add(channel)
    channel.input = refuse('input')
  }
  return channel
}
// The parent may still own its Hook listener in the same private Runtime namespace.
Object.defineProperty(inner.hookServer, 'port', { value: 0 })

const observation = await (async () => {
  try {
    await client.connect()
    const result = await client.ensureAgentContinuity({
      agentSessionId: input.agentSessionId,
      expectedRun: input.expectedRun,
      operationId: input.operationId,
      trigger: 'startup'
    })
    return { result, stored: await store.readMetadata(input.agentSessionId) }
  } finally {
    await client.dispose()
  }
})()
process.stdout.write(JSON.stringify({ pid: process.pid, ...observation, counters }) + '\n')
