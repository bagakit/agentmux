import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHost } from '../src/execution-host.js'
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js'
import { AgentMuxRuntime } from '../src/runtime.js'
import { TmuxClient, TmuxRollbackError } from '../src/tmux-client.js'

class TransactionalTmuxHost implements ExecutionHost {
  readonly id = 'remote'
  readonly kind = 'ssh' as const
  readonly label = 'Build box'
  readonly commands: string[][] = []
  failNewSession = true

  async run(_command: string, args: readonly string[], _options?: RunCommandOptions): Promise<CommandResult> {
    this.commands.push([...args])
    if (args[0] === '-V') return { stdout: 'tmux 3.5a\n', stderr: '', exitCode: 0 }
    if (args[0] === 'list-sessions') return { stdout: '', stderr: '', exitCode: 0 }
    if (args[0] === 'new-session' && this.failNewSession) {
      this.failNewSession = false
      return { stdout: '', stderr: 'failed to create session', exitCode: 1 }
    }
    if (args[0] === 'list-panes') {
      return { stdout: '%1\t0\t0\tzsh\t4421\t100\n', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'capture-pane') return { stdout: 'READY\n', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: '', exitCode: 0 }
  }

  async exposeLoopbackPort(localPort: number): Promise<number> {
    return localPort
  }

  async dispose(): Promise<void> {}
}

const runtimes: AgentMuxRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

describe('Session launch transaction', () => {
  it('removes a failed launch from public truth and permits the same id to retry', async () => {
    const host = new TransactionalTmuxHost()
    const runtime = new AgentMuxRuntime({ hosts: [host] })
    runtimes.push(runtime)
    const events: string[] = []
    runtime.onEvent((event) => events.push(event.type))

    await expect(runtime.launch({
      kind: 'terminal',
      sessionId: 'retryable',
      hostId: host.id,
      workspacePath: '/srv/project'
    })).rejects.toThrow('Failed to create tmux session')

    expect(runtime.snapshot()).toEqual({ sessions: [], activities: {} })
    expect(events).toEqual([])

    const launched = await runtime.launch({
      kind: 'terminal',
      sessionId: 'retryable',
      hostId: host.id,
      workspacePath: '/srv/project'
    })
    expect(launched).toMatchObject({ id: 'retryable', processState: 'running' })
  })

  it('rolls back a tmux session when post-create setup fails', async () => {
    const host = new TransactionalTmuxHost()
    host.failNewSession = false
    const originalRun = host.run.bind(host)
    let failSetup = true
    host.run = async (command, args, options) => {
      if (args[0] === 'set-option' && failSetup) {
        failSetup = false
        host.commands.push([...args])
        return { stdout: '', stderr: 'set-option failed', exitCode: 1 }
      }
      return await originalRun(command, args, options)
    }

    await expect(new TmuxClient(host).start({
      sessionName: 'agentmux-partial',
      cwd: '/srv/project'
    })).rejects.toThrow('set-option failed')

    expect(host.commands).toContainEqual(['kill-session', '-t', 'agentmux-partial'])
  })

  it('reserves a session id before concurrent launch preparation begins', async () => {
    const host = new TransactionalTmuxHost()
    host.failNewSession = false
    const runtime = new AgentMuxRuntime({ hosts: [host] })
    runtimes.push(runtime)

    const results = await Promise.allSettled([
      runtime.launch({ kind: 'terminal', sessionId: 'concurrent', hostId: host.id, workspacePath: '/srv/project' }),
      runtime.launch({ kind: 'terminal', sessionId: 'concurrent', hostId: host.id, workspacePath: '/srv/project' })
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(host.commands.filter(([command]) => command === 'new-session')).toHaveLength(1)
    expect(runtime.snapshot().sessions).toHaveLength(1)
    expect(runtime.snapshot().sessions[0]?.id).toBe('concurrent')
  })

  it('keeps an error session when tmux setup and rollback both fail', async () => {
    const host = new TransactionalTmuxHost()
    host.failNewSession = false
    const originalRun = host.run.bind(host)
    let failSetup = true
    let failCleanup = true
    host.run = async (command, args, options) => {
      if (args[0] === 'set-option' && failSetup) {
        failSetup = false
        host.commands.push([...args])
        return { stdout: '', stderr: 'set-option failed', exitCode: 1 }
      }
      if (args[0] === 'kill-session' && failCleanup) {
        failCleanup = false
        host.commands.push([...args])
        return { stdout: '', stderr: 'kill failed', exitCode: 1 }
      }
      return await originalRun(command, args, options)
    }
    const runtime = new AgentMuxRuntime({ hosts: [host] })
    runtimes.push(runtime)
    const events: string[] = []
    runtime.onEvent((event) => events.push(event.type))

    await expect(runtime.launch({
      kind: 'terminal',
      sessionId: 'rollback-failed',
      hostId: host.id,
      workspacePath: '/srv/project'
    })).rejects.toBeInstanceOf(TmuxRollbackError)

    expect(runtime.snapshot().sessions).toMatchObject([{
      id: 'rollback-failed',
      processState: 'unknown',
      status: { state: 'error', source: 'tmux' }
    }])
    expect(events).not.toContain('removed')

    await runtime.stopSession('rollback-failed')
    expect(runtime.snapshot().sessions).toEqual([])
  })
})
