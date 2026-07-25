import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxFileAgentSessionStore,
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
    workspacePath: '/private/tmp/work',
    run: { runId: `run-${index}` },
    retiredRuns: [],
    hookBindingId: `hook-${index}`,
    hookToken: `token-${index}`,
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function store(values: readonly unknown[]): AgentMuxAgentSessionStore {
  return {
    async load() { return values },
    async loadRetiredRuns() { return [] },
    async loadRetiredAgentSessions() { return [] },
    async compareAndSwap() {},
    async reserveLifecycle() {},
    async claimStaleLifecycles() { return [] },
    async releaseLifecycle() {},
    async retireRuns() {},
    async commitLifecycle() {},
    async loadTimeline(agentSessionId) { return { agentSessionId, revision: 0, items: [] } },
    async applyTimelineMutation(mutation) {
      return {
        agentSessionId: mutation.agentSessionId,
        revision: 0,
        changed: false,
        mutation
      }
    }
  }
}

describe('Agent Session Store resource limits', () => {
  it('accepts 256 unique sessions and rejects the 257th before allocating another index', async () => {
    await expect(loadAgentSessions(store(Array.from({ length: 256 }, (_, index) => session(index)))))
      .resolves.toHaveLength(256)
    await expect(loadAgentSessions(store(Array.from({ length: 257 }, (_, index) => session(index)))))
      .rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_LIMIT' })
  })

  it('rejects an oversized persisted document before JSON parsing', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-limit-')
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    await writeFile(path, ' '.repeat(1024 * 1024 + 1), { mode: 0o600 })

    await expect(new AgentMuxFileAgentSessionStore(path).load()).rejects.toMatchObject({
      code: 'INVALID_AGENT_SESSION_STORE'
    })
  })
})
