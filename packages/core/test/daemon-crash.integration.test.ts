import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/daemon-client.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const daemonEntry = resolve(import.meta.dirname, '../dist/agentmuxd.js')

async function waitForCondition(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function startDaemon(socketPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [daemonEntry, '--socket', socketPath], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { stdout += chunk })
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  await waitForCondition('the external daemon ready frame', () => {
    if (stdout.includes('"type":"ready"')) return true
    if (child.exitCode !== null) throw new Error(`External daemon exited before ready: ${stderr}`)
    return false
  })
  return child
}

async function stopChild(child: ChildProcess | null, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  await once(child, 'exit')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe.runIf(process.platform !== 'win32')('agentmuxd crash disposition', () => {
  beforeAll(async () => {
    await execFileAsync('pnpm', ['--filter', '@agentmux/core', 'build'], {
      cwd: repositoryRoot,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    })
  }, 35_000)

  it('restarts with the previous running identity marked lost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmuxd-crash-'))
    const socketPath = join(directory, 'agentmuxd.sock')
    let firstDaemon: ChildProcess | null = null
    let replacementDaemon: ChildProcess | null = null
    let sessionPid = 0
    const firstClient = new AgentMuxClient({ socketPath })
    const replacementClient = new AgentMuxClient({ socketPath })
    try {
      firstDaemon = await startDaemon(socketPath)
      await firstClient.connect()
      const firstDaemonIdentity = firstClient.daemonIdentity()
      const running = await firstClient.createTerminal({
        sessionId: 'crashed-daemon-session',
        createOperationId: 'operation-crashed-daemon-session',
        cwd: process.cwd()
      })
      sessionPid = running.pid
      expect((await stat(`${socketPath}.sessions.json`)).mode & 0o777).toBe(0o600)

      await stopChild(firstDaemon, 'SIGKILL')
      firstDaemon = null
      replacementDaemon = await startDaemon(socketPath)
      await replacementClient.connect()
      expect(replacementClient.daemonIdentity().daemonInstanceId).not.toBe(firstDaemonIdentity.daemonInstanceId)
      const recovered = (await replacementClient.listSessions())[0]!
      expect(recovered).toMatchObject({
        sessionId: running.sessionId,
        incarnationId: running.incarnationId,
        createOperationId: running.createOperationId,
        state: 'lost',
        lostReason: 'daemon-crash'
      })
      expect(await replacementClient.findCreateOperation(running.createOperationId)).toMatchObject({ state: 'lost' })
      const attached = await replacementClient.attach(running.sessionId)
      expect(attached.session.state).toBe('lost')
      await expect(replacementClient.resize(attached.session, 120, 40)).rejects.toMatchObject({
        code: 'SESSION_NOT_RUNNING'
      })
      await replacementClient.stop(attached.session)
      expect(await replacementClient.listSessions()).toEqual([])
      await waitForCondition('the crashed daemon PTY root to close', () => !processIsAlive(sessionPid))
    } finally {
      firstClient.disconnect()
      replacementClient.disconnect()
      await stopChild(firstDaemon, 'SIGKILL')
      await stopChild(replacementDaemon, 'SIGTERM')
      if (sessionPid > 0 && processIsAlive(sessionPid)) {
        try {
          process.kill(sessionPid, 'SIGKILL')
        } catch {
          // The exact test process may exit between the liveness check and cleanup.
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
