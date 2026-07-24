import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxDaemonSessionManager } from '../src/daemon-session-manager.js'

const managers: AgentMuxDaemonSessionManager[] = []

function captureError(action: () => unknown): unknown {
  try {
    action()
    return null
  } catch (error) {
    return error
  }
}

function createTerminal(manager: AgentMuxDaemonSessionManager, suffix: string) {
  return manager.create({
    sessionId: `session-${suffix}`,
    createOperationId: `operation-${suffix}`,
    kind: 'terminal',
    agentId: null,
    agentSessionId: null,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    env: {}
  })
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(async (manager) => await manager.dispose()))
})

describe('AgentMux daemon session transactions', () => {
  it('deduplicates accepted input bytes and rejects gaps or partial overlaps', async () => {
    const manager = new AgentMuxDaemonSessionManager()
    managers.push(manager)
    const session = createTerminal(manager, 'input-cursor')
    const data = "printf 'input-once\\n'\n"
    const accepted = manager.write(session, 0, data)
    expect(accepted).toMatchObject({ acceptedThrough: Buffer.byteLength(data), duplicate: false })
    expect(manager.write(session, 0, data)).toMatchObject({
      acceptedThrough: Buffer.byteLength(data),
      duplicate: true
    })
    expect(captureError(() => manager.write(session, 1, `${data}x`))).toMatchObject({
      code: 'INPUT_CURSOR_MISMATCH'
    })
    expect(captureError(() => manager.write(session, accepted.acceptedThrough + 1, 'x'))).toMatchObject({
      code: 'INPUT_CURSOR_MISMATCH'
    })
    await manager.stop(session)
  })

  it('retires a create operation while allowing the session id to receive a new incarnation', async () => {
    const manager = new AgentMuxDaemonSessionManager()
    managers.push(manager)
    const first = createTerminal(manager, 'incarnation')
    expect(createTerminal(manager, 'incarnation')).toMatchObject({
      incarnationId: first.incarnationId,
      pid: first.pid
    })
    await manager.stop(first)
    expect(captureError(() => createTerminal(manager, 'incarnation'))).toMatchObject({
      code: 'CREATE_OPERATION_RETIRED'
    })
    const second = manager.create({
      sessionId: first.sessionId,
      createOperationId: 'operation-incarnation-two',
      kind: 'terminal',
      agentId: null,
      agentSessionId: null,
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: {}
    })
    expect(second.incarnationId).not.toBe(first.incarnationId)
    await expect(manager.stop(first)).rejects.toMatchObject({ code: 'STALE_SESSION_INCARNATION' })
    await manager.stop(second)
  })

  it('recovers durable running identities as lost instead of claiming PTY recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-journal-test-'))
    const journalPath = join(directory, 'sessions.json')
    try {
      const owner = new AgentMuxDaemonSessionManager({ journalPath })
      managers.push(owner)
      const running = createTerminal(owner, 'daemon-crash')

      const replacement = new AgentMuxDaemonSessionManager({ journalPath })
      managers.push(replacement)
      replacement.activate()
      expect(replacement.list()).toEqual([
        expect.objectContaining({
          sessionId: running.sessionId,
          incarnationId: running.incarnationId,
          state: 'lost',
          lostReason: 'daemon-crash'
        })
      ])
      expect(replacement.findByCreateOperation(running.createOperationId)).toMatchObject({ state: 'lost' })
      const lost = replacement.list()[0]!
      expect(captureError(() => replacement.resize(lost, 120, 40))).toMatchObject({
        code: 'SESSION_NOT_RUNNING'
      })

      await owner.stop(running)
      await replacement.stop(lost)
    } finally {
      await Promise.allSettled(managers.splice(0).map(async (manager) => await manager.dispose()))
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('removes a reboot-disposed lost session without signaling an unrelated process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-reboot-test-'))
    const journalPath = join(directory, 'sessions.json')
    try {
      await writeFile(journalPath, `${JSON.stringify({
        version: 2,
        sessions: [{
          sessionId: 'session-before-reboot',
          incarnationId: 'incarnation-before-reboot',
          createOperationId: 'operation-before-reboot',
          kind: 'terminal',
          agentId: null,
          agentSessionId: null,
          cwd: process.cwd(),
          pid: process.pid,
          processStartedAt: 1,
          state: 'running',
          cols: 80,
          rows: 24,
          createdAt: 1,
          latestSequence: 0,
          acceptedInputSequence: 0
        }]
      })}\n`, { mode: 0o600 })
      const manager = new AgentMuxDaemonSessionManager({ journalPath })
      managers.push(manager)
      manager.activate()
      const lost = manager.list()[0]!
      expect(lost).toMatchObject({ state: 'lost', lostReason: 'daemon-crash' })
      await manager.stop(lost)
      expect(manager.list()).toEqual([])
    } finally {
      await Promise.allSettled(managers.splice(0).map(async (manager) => await manager.dispose()))
      await rm(directory, { recursive: true, force: true })
    }
  })
})
