import { fixturePath } from './helpers/fixture-values.js'
import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
const trace = vi.hoisted(() => ({ path: '', bytes: [] as number[], failStat: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const result = await original.readFile(...args)
      if (args[0] === trace.path) trace.bytes.push(Buffer.byteLength(result))
      return result
    },
    stat: async (...args: Parameters<typeof original.stat>) => {
      if (args[0] === trace.path && trace.failStat) throw Object.assign(new Error('test-owned metadata I/O failure'), { code: 'EIO' })
      return await original.stat(...args)
    }
  }
})
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, AgentTimelineMutation } from '../src/types.js'
const mutation = (index: number): AgentTimelineMutation => ({ type: 'append', agentSessionId: 'semantic-0', item: {
  id: `event-${index}`, agentSessionId: 'semantic-0', kind: 'assistant_message', status: 'complete', source: 'acp',
  title: 'One related event', content: 'short', createdAt: 1, updatedAt: 1 } })

it.each([1, 280])('Timeline hot writes read zero catalog body bytes with %s durable Sessions', async count => {
  const root = await mkdtemp(fixturePath("tmp/agentmux-timeline-membership-")), path = join(root, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'semantic-0', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding-0', hookToken: 'token-0', createdAt: 1, updatedAt: 1 }
  try {
    await store.compareAndSwap(null, original)
    const document = JSON.parse(await readFile(path, 'utf8'))
    document.sessions = Array.from({ length: count }, (_, index) => ({ ...original, agentSessionId: `semantic-${index}`, run: { runId: `run-${index}` },
      hookBindingId: `binding-${index}`, hookToken: `token-${index}`, futurePromptIntents: {
        plan: { operationId: `op-${index}`, prompt: 'x'.repeat(8000), active: false, message: { userContent: 'x'.repeat(8000) } }
      } }))
    await writeFile(path, JSON.stringify(document) + '\n')
    // Production first loads the catalog into the Registry. The first cold read is deliberately not claimed free.
    const reopened = new AgentMuxFileAgentSessionStore(path)
    await reopened.load()
    trace.path = path; trace.bytes = []
    for (let index = 0; index < 8; index++) await reopened.applyTimelineMutation(mutation(index))
    expect(trace.bytes).toEqual([])
    const [current] = await reopened.load() as AgentMuxStoredAgentSession[]
    await reopened.compareAndSwap(current!, { ...current!, updatedAt: 2 })
    trace.bytes = []
    await reopened.applyTimelineMutation(mutation(8))
    expect(trace.bytes).toEqual([])
    // A distinct owner replaces the original file. The next append must validate its changed identity once.
    const external = new AgentMuxFileAgentSessionStore(path), [externalCurrent] = await external.load() as AgentMuxStoredAgentSession[]
    await external.compareAndSwap(externalCurrent!, { ...externalCurrent!, updatedAt: 3 })
    trace.bytes = []
    await reopened.applyTimelineMutation(mutation(9))
    expect(trace.bytes).toHaveLength(1)
    trace.bytes = []
    await reopened.applyTimelineMutation(mutation(10))
    expect(trace.bytes).toEqual([])
    trace.failStat = true
    await expect(reopened.applyTimelineMutation(mutation(11))).rejects.toMatchObject({ code: 'EIO' })
    trace.failStat = false
    expect((await reopened.loadTimeline('semantic-0')).items.map(item => item.id)).toEqual(Array.from({ length: 11 }, (_, index) => `event-${index}`))
    const [beforeDelete] = await external.load() as AgentMuxStoredAgentSession[]
    await external.compareAndSwap(beforeDelete!, null)
    await expect(reopened.applyTimelineMutation(mutation(12))).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    console.info(JSON.stringify({ sessions: count, affectedSessions: 1, hotCatalogBytes: 0, externalReplacementRevalidated: true, scope: 'private original FileStore; cold directory reads remain explicit' }))
  } finally { trace.path = ''; trace.failStat = false; await rm(root, { recursive: true, force: true }) }
})
