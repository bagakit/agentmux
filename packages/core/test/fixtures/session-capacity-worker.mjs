import { tmpdir as fixtureTmpdir } from 'node:os'
import { join as fixtureJoin, sep as fixtureSep } from 'node:path'
const fixturePath = relative => { const temporary = relative.replace(/^(?:private\/)?tmp\//u, ''); return (temporary === relative ? fixtureJoin(fixtureTmpdir(), 'agentmux-fixtures') : fixtureTmpdir()) + fixtureSep + temporary.replaceAll('/', fixtureSep) }
import { pathToFileURL } from 'node:url'
import { AgentMuxAgentSessionRegistry } from '../../dist/agent-session-registry.js'
const implementation = process.env.AGENTMUX_CAPACITY_STORE_MODULE
const { AgentMuxFileAgentSessionStore } = await import(implementation ? pathToFileURL(implementation).href : '../../dist/agent-session-store.js')
const [path, phase] = process.argv.slice(2)
const realRuns = JSON.parse(process.env.AGENTMUX_CAPACITY_RUN_IDS ?? '[]')
const workspacePath = process.env.AGENTMUX_CAPACITY_WORKSPACE ?? fixturePath("tmp/work")
const store = new AgentMuxFileAgentSessionStore(path)
if (phase === 'write') {
  for (let index = 0; index < 280; index++) {
    const prompt = `Task ${index}: ${'persist the original context. '.repeat(150)}`
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: `semantic-${index}`, providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath, run: { runId: realRuns[index] ?? `run-${index}` }, retiredRuns: [],
      hookBindingId: `hook-${index}`, hookToken: `token-${index}`, createdAt: 1, updatedAt: 1,
      futurePromptIntents: { schedule: { operationId: `schedule-${index}`, prompt, active: true, message: { userContent: prompt } } } })
  }
} else if (phase === 'update') {
  const records = await store.load()
  const first = records[0]
  await store.compareAndSwap(first, { ...first, updatedAt: 2 })
} else if (phase !== 'read') throw new Error('Invalid fixture phase')
const registry = new AgentMuxAgentSessionRegistry(store)
await registry.load('local')
const records = await store.load()
let publicRestoration
if (phase === 'read' && process.env.AGENTMUX_CAPACITY_PUBLIC_READ === '1') {
  const { AgentMuxClient } = await import('../../dist/index.js')
  const client = new AgentMuxClient({ store })
  try {
    const sessions = await client.readAgentSessions()
    publicRestoration = { count: sessions.length, first: sessions[0] }
  } finally { await client.dispose() }
}
console.log(JSON.stringify({ publicRestoration, pid: process.pid, count: records.length, first: records[0], last: records.at(-1),
  firstRegistered: registry.get('semantic-0')?.agentSessionId }))
