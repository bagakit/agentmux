import { fixturePath } from './helpers/fixture-values.js'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, stat, readFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxMemoryAgentSessionStore,
  loadAgentSessions,
  type AgentMuxAgentSessionStore
} from '../src/agent-session-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

function session(index: number) {
  return {
    kind: 'agent' as const,
    agentSessionId: `semantic-${index}`,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: fixturePath("tmp/work"),
    run: { runId: `run-${index}` },
    retiredRuns: [],
    hookBindingId: `hook-${index}`,
    hookToken: `token-${index}`,

    createdAt: 1,
    updatedAt: 1
  }
}

function store(values: readonly unknown[]): AgentMuxAgentSessionStore {
  return Object.assign(new AgentMuxMemoryAgentSessionStore(), { async load() { return values } })
}

describe('Agent Session Store resource limits', () => {
  it('retains a growing collection of distinct semantic identities', async () => {
    const values = Array.from({ length: 280 }, (_, index) => session(index))
    await expect(loadAgentSessions(store(values))).resolves.toEqual(values)
    await expect(loadAgentSessions(store([...values, values[0]]))).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
  })

  it('preserves malformed original bytes for recovery independently of document size', async () => {
    const root = await mkdtemp(fixturePath("tmp/agentmux-store-limit-"))
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    await writeFile(path, ' '.repeat(1024 * 1024 + 1), { mode: 0o600 })

    await expect(new AgentMuxFileAgentSessionStore(path).load()).resolves.toEqual([])
    const quarantined = (await readdir(root)).filter(name => name.startsWith('agent-sessions.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(root, quarantined[0]!), 'utf8')).toBe(' '.repeat(1024 * 1024 + 1))
  })
  it('persists legitimate growing context and restores the original identities in independent processes', async () => {
    const root = await mkdtemp(fixturePath("tmp/agentmux-capacity-")); roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const worker = fileURLToPath(new URL('./fixtures/session-capacity-worker.mjs', import.meta.url))
    const run = async (phase: string) => {
      const { stdout } = await promisify(execFile)(process.execPath, [worker, path, phase], { timeout: 60_000 })
      return JSON.parse(stdout) as { pid: number; count: number; first: ReturnType<typeof session>; last: ReturnType<typeof session>; firstRegistered: string }
    }
    const original = await run('write')
    expect((await stat(path)).size).toBeGreaterThan(1024 * 1024)
    const restored = await run('read')
    expect(restored.pid).not.toBe(original.pid)
    expect(restored.count).toBe(280)
    expect(restored.first).toEqual(original.first)
    expect(restored.last).toEqual(original.last)
    expect(restored.firstRegistered).toBe('semantic-0')
    const changed = await run('update')
    expect(changed.first).toEqual({ ...original.first, updatedAt: 2 })
    expect(changed.last).toEqual(original.last)
    expect((await run('read')).first).toEqual(changed.first)
  }, 90_000)

  it('keeps individually valid timeline context above the former whole-file byte cap', async () => {
    const root = await mkdtemp(fixturePath("tmp/agentmux-timeline-growth-")); roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const owner = new AgentMuxFileAgentSessionStore(path)
    await owner.compareAndSwap(null, session(0))
    const items = Array.from({ length: 150 }, (_, index) => ({ id: `activity-${index}`, agentSessionId: 'semantic-0',
      kind: 'assistant_message' as const, status: 'complete' as const, source: 'acp' as const,
      createdAt: 1, updatedAt: 1, title: `Activity ${index}`, content: 'recorded tool context. '.repeat(2800) }))
    const timelineRoot = join(root, 'agent-timelines')
    await mkdir(timelineRoot)
    const timelinePath = join(timelineRoot, createHash('sha256').update('semantic-0').digest('base64url') + '.jsonl')
    await writeFile(timelinePath, JSON.stringify({ version: 3, agentSessionId: 'semantic-0', revision: 150, items }) + '\n')
    expect((await stat(timelinePath)).size).toBeGreaterThan(8 * 1024 * 1024)
    await expect(owner.loadTimeline('semantic-0')).resolves.toMatchObject({ items })
    const updated = { ...items[0]!, updatedAt: 2, title: 'Reconciled original activity' }
    await owner.applyTimelineMutation({ type: 'upsert', agentSessionId: 'semantic-0', item: updated })
    const reopened = await new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-0')
    expect(reopened.items).toEqual([updated, ...items.slice(1)])
  })

})
