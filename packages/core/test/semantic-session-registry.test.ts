import { describe, expect, it } from 'vitest'
import { AgentMuxSemanticSessionRegistry } from '../src/semantic-session-registry.js'
import { AgentMuxMemorySemanticStore, type AgentMuxSemanticStore } from '../src/semantic-store.js'
import type { AgentMuxStoredSemanticSession } from '../src/types.js'

function session(run = 'run-1'): AgentMuxStoredSemanticSession {
  return {
    kind: 'agent',
    semanticSessionId: 'semantic-1',
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    daemonSession: { sessionId: run, incarnationId: `${run}-incarnation` },
    outputCursor: 0,
    createdAt: 100,
    updatedAt: 100
  }
}

describe('semantic session registry concurrency', () => {
  it('serializes persistence and rejects an old run update after a resume transition', async () => {
    const memory = new AgentMuxMemorySemanticStore()
    let enteredTransition!: () => void
    let releaseTransition!: () => void
    const transitionEntered = new Promise<void>((resolve) => { enteredTransition = resolve })
    const transitionRelease = new Promise<void>((resolve) => { releaseTransition = resolve })
    const store: AgentMuxSemanticStore = {
      async load() { return await memory.load() },
      async put(value) {
        if (value.daemonSession.sessionId === 'run-2') {
          enteredTransition()
          await transitionRelease
        }
        await memory.put(value)
      },
      async delete(id) { await memory.delete(id) }
    }
    const registry = new AgentMuxSemanticSessionRegistry(store)
    const original = session()
    const resumed = { ...original, daemonSession: session('run-2').daemonSession, updatedAt: 200 }
    await registry.put(original)

    const transition = registry.put(resumed, original.daemonSession)
    await transitionEntered
    const staleUpdate = registry.put({ ...original, outputCursor: 42 }, original.daemonSession)
    releaseTransition()

    await transition
    await expect(staleUpdate).rejects.toMatchObject({ code: 'STALE_SEMANTIC_SESSION' })
    expect(registry.get('semantic-1')).toEqual(resumed)
    expect(await memory.load()).toEqual([resumed])
  })
})
