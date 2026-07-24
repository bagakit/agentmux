import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHost } from '../src/execution-host.js'
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js'
import { AgentMuxRuntime } from '../src/runtime.js'

type Paste = { session: string; text: string }

class ReorderingTmuxHost implements ExecutionHost {
  readonly id = 'local'
  readonly kind = 'local' as const
  readonly label = 'Ordering fixture'
  readonly buffers = new Map<string, string>()
  readonly pastes: Paste[] = []
  failInput: string | null = null

  async run(_command: string, args: readonly string[], options?: RunCommandOptions): Promise<CommandResult> {
    if (args[0] === '-V') return this.result('tmux 3.5a\n')
    if (args[0] === 'list-sessions') return this.result()
    if (args[0] === 'list-panes') return this.result('%1\t0\t0\tzsh\t4421\t100\n')
    if (args[0] === 'capture-pane') return this.result()
    if (args[0] === 'load-buffer') {
      const name = args[2]!
      const text = typeof options?.input === 'string' ? options.input : ''
      const delay = text === 'slow' ? 40 : text.length === 1 ? (122 - text.charCodeAt(0)) * 2 : 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (text === this.failInput) return this.result('', 'input failed', 1)
      this.buffers.set(name, text)
      return this.result()
    }
    if (args[0] === 'paste-buffer') {
      this.pastes.push({
        session: args[4]!.split(':')[0]!,
        text: this.buffers.get(args[2]!) ?? ''
      })
    }
    return this.result()
  }

  async exposeLoopbackPort(localPort: number): Promise<number> {
    return localPort
  }

  async dispose(): Promise<void> {}

  private result(stdout = '', stderr = '', exitCode = 0): CommandResult {
    return { stdout, stderr, exitCode }
  }
}

const runtimes: AgentMuxRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    for (const session of runtime.snapshot().sessions) await runtime.stopSession(session.id).catch(() => {})
    await runtime.dispose()
  }
})

async function launch(runtime: AgentMuxRuntime, sessionId: string): Promise<void> {
  await runtime.launch({ kind: 'terminal', sessionId, workspacePath: process.cwd() })
}

describe('runtime input ordering', () => {
  it('serializes input per session while allowing different sessions to progress independently', async () => {
    const host = new ReorderingTmuxHost()
    const runtime = new AgentMuxRuntime({ hosts: [host] })
    runtimes.push(runtime)
    await launch(runtime, 'ordered')
    await launch(runtime, 'independent')

    await Promise.all(['a', 'b', 'c'].map(async (text) => await runtime.send('ordered', text, false)))
    expect(host.pastes.map((item) => item.text)).toEqual(['a', 'b', 'c'])

    host.pastes.length = 0
    await Promise.all([
      runtime.send('ordered', 'slow', false),
      runtime.send('independent', 'fast', false)
    ])
    expect(host.pastes).toEqual([
      { session: 'agentmux-independent', text: 'fast' },
      { session: 'agentmux-ordered', text: 'slow' }
    ])
  })

  it('continues with the next queued input after one send fails', async () => {
    const host = new ReorderingTmuxHost()
    host.failInput = 'bad'
    const runtime = new AgentMuxRuntime({ hosts: [host] })
    runtimes.push(runtime)
    await launch(runtime, 'recoverable')

    const failed = runtime.send('recoverable', 'bad', false)
    const recovered = runtime.send('recoverable', 'good', false)

    await expect(failed).rejects.toThrow('tmux load-buffer failed')
    await expect(recovered).resolves.toBeUndefined()
    expect(host.pastes).toEqual([{ session: 'agentmux-recoverable', text: 'good' }])
  })
})
