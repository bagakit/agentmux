import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHost } from '../src/execution-host.js'
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js'
import { AgentMuxRuntime } from '../src/runtime.js'
import { TmuxClient } from '../src/tmux-client.js'

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
    expect(events.at(-1)).toBe('removed')

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
})
