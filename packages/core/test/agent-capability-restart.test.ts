import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { hashAgentCapability, issueAgentCapability, resolveCapabilityAuthor } from '../src/agent-capability.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

// 凭证只以 hash 落盘。如果它没被真正持久化，重启后 Core 就再也认不出这个 Agent——
// 于是 Agent A 重启一次就永远说不了话。这条只能用真实 Store 往返来证明。

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function freshStore() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-capability-'))
  roots.push(root)
  const path = join(root, 'sessions.json')
  return { path, store: new AgentMuxFileAgentSessionStore(path) }
}

function session(capabilityHash: string): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-a',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'binding-1',
    hookToken: 'token-1',
    capabilityHash,
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('凭证跨重启存活', () => {
  it('第二个 Store 实例读回同一个 hash，凭证仍解析得出 author', async () => {
    const raw = issueAgentCapability()
    const { path, store } = await freshStore()
    await store.compareAndSwap(null, session(hashAgentCapability(raw)))

    // 换一个 Store 实例读同一个目录——这就是"重启"。
    const reopened = new AgentMuxFileAgentSessionStore(path)
    const loaded = (await reopened.load()) as AgentMuxStoredAgentSession[]
    const restored = loaded.find((entry) => entry.agentSessionId === 'agent-a')!

    expect(restored.capabilityHash).toBe(hashAgentCapability(raw))
    expect(resolveCapabilityAuthor(raw, {
      agentSessionId: restored.agentSessionId,
      workspacePath: restored.workspacePath,
      runId: restored.run.runId,
      capabilityHash: restored.capabilityHash!
    }, 'run-1')).toBe('agent-a')
  })

  it('落盘的是 hash 而不是 raw——原文不该出现在磁盘上', async () => {
    const raw = issueAgentCapability()
    const { path, store } = await freshStore()
    await store.compareAndSwap(null, session(hashAgentCapability(raw)))

    const reopened = new AgentMuxFileAgentSessionStore(path)
    const dumped = JSON.stringify(await reopened.load())
    expect(dumped).not.toContain(raw)
    expect(dumped).toContain(hashAgentCapability(raw))
  })
})
