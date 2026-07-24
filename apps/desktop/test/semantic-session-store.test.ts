import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMuxStoredSemanticSession } from '@agentmux/core'
import { DesktopSemanticSessionStore } from '../src/main/semantic-session-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

function session(id: string): AgentMuxStoredSemanticSession {
  return {
    kind: 'agent',
    semanticSessionId: id,
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    daemonSession: { sessionId: `${id}-run`, incarnationId: `${id}-incarnation` },
    outputCursor: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('Desktop semantic session persistence', () => {
  it('serializes concurrent host writes into one durable document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-semantic-store-'))
    roots.push(root)
    const path = join(root, 'sessions.json')
    const store = new DesktopSemanticSessionStore(path)
    await Promise.all([store.put(session('one')), store.put(session('two'))])

    await expect(new DesktopSemanticSessionStore(path).load()).resolves.toEqual([
      session('one'),
      session('two')
    ])
  })

  it('keeps in-memory truth unchanged when an atomic replacement fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-semantic-store-'))
    roots.push(root)
    const path = join(root, 'sessions.json')
    const store = new DesktopSemanticSessionStore(path)
    await store.put(session('one'))
    await rm(path)
    await mkdir(path)

    await expect(store.put(session('two'))).rejects.toBeInstanceOf(Error)
    await expect(store.load()).resolves.toEqual([session('one')])
  })
})
