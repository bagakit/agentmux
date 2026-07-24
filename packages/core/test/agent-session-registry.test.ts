import { describe, expect, it } from 'vitest'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

function session(run = 'run-1'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'semantic-1',
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: run },
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100
  }
}

describe('semantic session registry concurrency', () => {
  it('serializes persistence and rejects an old run update after a resume transition', async () => {
    const memory = new AgentMuxMemoryAgentSessionStore()
    let enteredTransition!: () => void
    let releaseTransition!: () => void
    const transitionEntered = new Promise<void>((resolve) => { enteredTransition = resolve })
    const transitionRelease = new Promise<void>((resolve) => { releaseTransition = resolve })
    const store: AgentMuxAgentSessionStore = {
      async load() { return await memory.load() },
      async put(value) {
        if (value.run.runId === 'run-2') {
          enteredTransition()
          await transitionRelease
        }
        await memory.put(value)
      },
      async delete(id) { await memory.delete(id) }
    }
    const registry = new AgentMuxAgentSessionRegistry(store)
    const original = session()
    const resumed = { ...original, run: session('run-2').run, updatedAt: 200 }
    await registry.put(original)

    const transition = registry.put(resumed, original.run)
    await transitionEntered
    const staleUpdate = registry.put({ ...original, outputCursorBytes: 42 }, original.run)
    releaseTransition()

    await transition
    await expect(staleUpdate).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(registry.get('semantic-1')).toEqual(resumed)
    expect(await memory.load()).toEqual([resumed])
  })
})
