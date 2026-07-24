import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHost } from '../src/execution-host.js'
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js'
import { AgentMuxRuntime } from '../src/runtime.js'

class RecoverableSshHost implements ExecutionHost {
  readonly id = 'remote'
  readonly kind = 'ssh' as const
  readonly label = 'Build box'
  disconnected = false

  async run(command: string, args: readonly string[], _options?: RunCommandOptions): Promise<CommandResult> {
    if (this.disconnected) return { stdout: '', stderr: 'Connection timed out', exitCode: 255 }
    if (command !== 'tmux') return { stdout: '', stderr: '', exitCode: 0 }
    if (args[0] === '-V') return { stdout: 'tmux 3.5a\n', stderr: '', exitCode: 0 }
    if (args[0] === 'list-sessions') return { stdout: '', stderr: '', exitCode: 0 }
    if (args[0] === 'list-panes') {
      return { stdout: '%1\t0\t0\tcodex\t4421\t100\n', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'capture-pane') return { stdout: 'READY\n', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: '', exitCode: 0 }
  }

  async exposeLoopbackPort(localPort: number): Promise<number> {
    return localPort
  }

  async dispose(): Promise<void> {}
}

class DiscoverableSshHost implements ExecutionHost {
  readonly id = 'discovered-remote'
  readonly kind = 'ssh' as const
  readonly label = 'Discovered build box'

  async run(command: string, args: readonly string[], _options?: RunCommandOptions): Promise<CommandResult> {
    if (command !== 'tmux') return { stdout: '', stderr: '', exitCode: 0 }
    if (args[0] === '-V') return { stdout: 'tmux 3.5a\n', stderr: '', exitCode: 0 }
    if (args[0] === 'list-sessions') {
      return { stdout: 'agentmux-existing\t100\t0\t1\n', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'show-environment') {
      return {
        stdout: [
          'AGENTMUX_SESSION_KIND=terminal',
          'AGENTMUX_HOST_ID=discovered-remote',
          'AGENTMUX_WORKSPACE_PATH=/srv/existing',
          'AGENTMUX_SESSION_LABEL=Existing terminal'
        ].join('\n'),
        stderr: '',
        exitCode: 0
      }
    }
    if (args[0] === 'list-panes') {
      return { stdout: '%1\t0\t0\tzsh\t4421\t100\n', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'capture-pane') return { stdout: 'RECOVERED\n', stderr: '', exitCode: 0 }
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

describe('AgentMuxRuntime remote recovery', () => {
  it('publishes SSH disconnection and returns to the same tmux session after refresh', async () => {
    const host = new RecoverableSshHost()
    const runtime = new AgentMuxRuntime({ hosts: [host] })
    runtimes.push(runtime)
    const launched = await runtime.launch({
      kind: 'agent',
      sessionId: 'recoverable',
      agentId: 'codex',
      commandOverride: 'fixture',
      hostId: host.id,
      workspacePath: '/srv/project'
    })
    expect(launched).toMatchObject({ tmuxSession: 'agentmux-recoverable', processState: 'running' })

    host.disconnected = true
    const disconnected = await runtime.refresh(launched.id)
    expect(disconnected).toMatchObject({
      tmuxSession: launched.tmuxSession,
      processState: 'unknown',
      status: { state: 'disconnected', source: 'tmux' }
    })

    host.disconnected = false
    const recovered = await runtime.refresh(launched.id)
    expect(recovered).toMatchObject({
      tmuxSession: launched.tmuxSession,
      processState: 'running',
      status: { state: 'running', source: 'tmux' },
      terminalSnapshot: 'READY'
    })
  })

  it('prepares an added SSH host without publishing until synchronous commit', async () => {
    const initialHost = new RecoverableSshHost()
    const runtime = new AgentMuxRuntime({ hosts: [initialHost] })
    runtimes.push(runtime)
    await runtime.start()

    const discoveredHost = new DiscoverableSshHost()
    const published: string[] = []
    runtime.onEvent((event) => {
      if (event.type === 'session') published.push(event.session.id)
    })

    const prepared = await runtime.prepareHost(discoveredHost)
    expect(runtime.snapshot().sessions).toEqual([])
    expect(() => runtime.hosts.get(discoveredHost.id)).toThrow('Unknown execution host')

    const retired = runtime.commitHost(prepared)
    const second = await runtime.discover(discoveredHost.id)

    expect(retired).toBeUndefined()
    expect(second).toHaveLength(1)
    expect(runtime.snapshot().sessions).toEqual([
      expect.objectContaining({
        id: 'existing',
        hostId: discoveredHost.id,
        workspacePath: '/srv/existing',
        terminalSnapshot: 'RECOVERED'
      })
    ])
    expect(published.filter((id) => id === 'existing')).toHaveLength(1)
  })
})
