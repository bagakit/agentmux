import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const state = vi.hoisted(() => ({ userDataRoot: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.userDataRoot : tmpdir()) }
}))

import { AgentMuxFileAgentSessionStore, defaultAgentMuxRuntimeDirectory } from '@agentmux/core'
import { desktopAgentSessionStorePath } from '../src/main/agent-session-store-path.js'

beforeEach(async () => {
  state.userDataRoot = await mkdtemp(join(tmpdir(), 'agentmux-userdata-'))
})

afterEach(async () => {
  await rm(state.userDataRoot, { recursive: true, force: true })
})

function storedSession() {
  return {
    kind: 'agent' as const,
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 200,
    nativeHandle: {
      kind: 'provider' as const,
      providerId: 'codex',
      sessionId: 'native-1'
    }
  }
}

describe('desktop agent session store path', () => {
  it('lands under Electron userData, never in the ephemeral temp runtime directory', () => {
    const path = desktopAgentSessionStorePath()
    // Acceptance: the session identity file (and agent-timelines derived from its dirname) must live in
    // durable userData. Reverting this to the temp runtime dir must fail here.
    expect(path.startsWith(state.userDataRoot)).toBe(true)
    expect(path.startsWith(defaultAgentMuxRuntimeDirectory())).toBe(false)
    expect(dirname(path)).toBe(state.userDataRoot)
  })

  it('round-trips a nativeHandle through the injected durable path so resume survives restart', async () => {
    const writer = new AgentMuxFileAgentSessionStore(desktopAgentSessionStorePath())
    await writer.compareAndSwap(null, storedSession())

    // A fresh instance stands in for the next AgentMux launch reopening the same durable file.
    const reopened = new AgentMuxFileAgentSessionStore(desktopAgentSessionStorePath())
    const sessions = await reopened.load()
    expect(sessions).toHaveLength(1)
    expect((sessions[0] as { nativeHandle?: unknown }).nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'codex',
      sessionId: 'native-1'
    })

    // The session file sits directly in userData — not the temp runtime dir.
    const entries = await readdir(state.userDataRoot)
    expect(entries).toContain('agent-sessions.json')
  })
})
