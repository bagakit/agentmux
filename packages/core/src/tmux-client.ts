import { randomUUID } from 'node:crypto'
import { AgentMuxError, CommandExecutionError } from './errors.js'
import type { ExecutionHost } from './execution-host.js'

export const AGENTMUX_TMUX_PREFIX = 'agentmux-'

type TmuxStartRequestBase = {
  sessionName: string
  cwd: string
  env?: Readonly<Record<string, string>>
  cols?: number
  rows?: number
}

export type TmuxStartRequest = TmuxStartRequestBase & (
  | { command: string; args: readonly string[] }
  | { command?: undefined; args?: undefined }
)

export type TmuxPaneInfo = {
  paneId: string
  dead: boolean
  exitCode?: number
  command?: string
  pid?: number
  activity?: number
}

export type TmuxSessionInfo = {
  name: string
  createdAt?: number
  attachedClients: number
  windows: number
}

function requireSuccess(
  result: { exitCode: number; stderr: string },
  command: string,
  args: readonly string[],
  message: string
): void {
  if (result.exitCode !== 0) {
    throw new CommandExecutionError(message, command, args, result.exitCode, result.stderr.trim())
  }
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export class TmuxClient {
  constructor(readonly host: ExecutionHost) {}

  async assertAvailable(): Promise<string> {
    const args = ['-V']
    const result = await this.host.run('tmux', args, { timeoutMs: 8_000 })
    requireSuccess(result, 'tmux', args, `tmux is not available on ${this.host.label}`)
    return result.stdout.trim()
  }

  async start(request: TmuxStartRequest): Promise<void> {
    if (!request.sessionName.startsWith(AGENTMUX_TMUX_PREFIX)) {
      throw new AgentMuxError('Refusing to create an unscoped tmux session.', 'UNSCOPED_TMUX_SESSION')
    }
    const environment = Object.entries(request.env ?? {}).flatMap(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes('\0')) {
        throw new AgentMuxError(`Invalid tmux environment entry: ${name}`, 'INVALID_ENV')
      }
      return ['-e', `${name}=${value}`]
    })
    const command = request.command === undefined ? [] : ['--', request.command, ...request.args]
    const args = [
      'new-session',
      '-d',
      '-s',
      request.sessionName,
      '-c',
      request.cwd,
      '-x',
      String(request.cols ?? 120),
      '-y',
      String(request.rows ?? 36),
      ...environment,
      ...command
    ]
    const result = await this.host.run('tmux', args, { timeoutMs: 15_000 })
    requireSuccess(result, 'tmux', args, `Failed to create tmux session ${request.sessionName}`)
    try {
      await this.run(['set-option', '-t', request.sessionName, 'remain-on-exit', 'on'])
      await this.run(['set-option', '-t', request.sessionName, 'history-limit', '50000'])
    } catch (error) {
      await this.stop(request.sessionName).catch(() => {})
      throw error
    }
  }

  async list(): Promise<TmuxSessionInfo[]> {
    const result = await this.host.run(
      'tmux',
      ['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'],
      { timeoutMs: 8_000 }
    )
    if (result.exitCode !== 0) {
      return /no server running|failed to connect/i.test(result.stderr) ? [] : Promise.reject(
        new CommandExecutionError('Failed to list tmux sessions.', 'tmux', ['list-sessions'], result.exitCode, result.stderr)
      )
    }
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', created, attached, windows] = line.split('\t')
        const createdAt = parseNumber(created)
        return {
          name,
          ...(createdAt !== undefined ? { createdAt } : {}),
          attachedClients: parseNumber(attached) ?? 0,
          windows: parseNumber(windows) ?? 0
        }
      })
  }

  async inspect(sessionName: string): Promise<TmuxPaneInfo | null> {
    const result = await this.host.run(
      'tmux',
      [
        'list-panes',
        '-t',
        `${sessionName}:0.0`,
        '-F',
        '#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}\t#{pane_pid}\t#{pane_activity}'
      ],
      { timeoutMs: 8_000 }
    )
    // ssh reserves 255 for transport/authentication failures. Preserve that
    // distinction so clients can offer an honest reconnect action instead of
    // reporting that a still-running remote tmux pane disappeared.
    if (result.exitCode === 255 && this.host.kind === 'ssh') {
      throw new CommandExecutionError(
        `SSH connection to ${this.host.label} is unavailable.`,
        'tmux',
        ['list-panes', '-t', `${sessionName}:0.0`],
        result.exitCode,
        result.stderr
      )
    }
    if (result.exitCode !== 0) return null
    const line = result.stdout.split('\n').find(Boolean)
    if (!line) return null
    const [paneId = '', dead, exitCode, command, pid, activity] = line.split('\t')
    const parsedExitCode = parseNumber(exitCode)
    const parsedPid = parseNumber(pid)
    const parsedActivity = parseNumber(activity)
    return {
      paneId,
      dead: dead === '1',
      ...(parsedExitCode !== undefined ? { exitCode: parsedExitCode } : {}),
      ...(command ? { command } : {}),
      ...(parsedPid !== undefined ? { pid: parsedPid } : {}),
      ...(parsedActivity !== undefined ? { activity: parsedActivity } : {})
    }
  }

  async capture(sessionName: string, historyLines = 2_000): Promise<string> {
    const args = [
      'capture-pane',
      '-p',
      '-e',
      '-J',
      '-t',
      `${sessionName}:0.0`,
      '-S',
      `-${Math.max(1, Math.min(historyLines, 50_000))}`
    ]
    const result = await this.host.run('tmux', args, { timeoutMs: 8_000, maxOutputBytes: 4 * 1024 * 1024 })
    requireSuccess(result, 'tmux', args, `Failed to capture tmux session ${sessionName}`)
    return result.stdout.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
  }

  async sendText(sessionName: string, text: string, submit = false): Promise<void> {
    const bufferName = `agentmux-${randomUUID().replaceAll('-', '')}`
    await this.run(['load-buffer', '-b', bufferName, '-'], text)
    await this.run(['paste-buffer', '-b', bufferName, '-t', `${sessionName}:0.0`, '-d'])
    if (submit) await this.run(['send-keys', '-t', `${sessionName}:0.0`, 'Enter'])
  }

  async interrupt(sessionName: string): Promise<void> {
    await this.run(['send-keys', '-t', `${sessionName}:0.0`, 'C-c'])
  }

  async resize(sessionName: string, cols: number, rows: number): Promise<void> {
    await this.run([
      'resize-pane',
      '-t',
      `${sessionName}:0.0`,
      '-x',
      String(Math.max(20, Math.floor(cols))),
      '-y',
      String(Math.max(5, Math.floor(rows)))
    ])
  }

  async stop(sessionName: string): Promise<void> {
    if (!sessionName.startsWith(AGENTMUX_TMUX_PREFIX)) {
      throw new AgentMuxError('Refusing to stop an unscoped tmux session.', 'UNSCOPED_TMUX_SESSION')
    }
    const result = await this.host.run('tmux', ['kill-session', '-t', sessionName], { timeoutMs: 8_000 })
    if (result.exitCode !== 0 && !/can't find session|no server running/i.test(result.stderr)) {
      requireSuccess(result, 'tmux', ['kill-session', '-t', sessionName], `Failed to stop ${sessionName}`)
    }
  }

  async showEnvironment(sessionName: string): Promise<Record<string, string>> {
    const result = await this.host.run('tmux', ['show-environment', '-t', sessionName], { timeoutMs: 8_000 })
    if (result.exitCode !== 0) return {}
    const environment: Record<string, string> = {}
    for (const line of result.stdout.split('\n')) {
      if (!line || line.startsWith('-')) continue
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      environment[line.slice(0, separator)] = line.slice(separator + 1)
    }
    return environment
  }

  private async run(args: readonly string[], input?: string): Promise<void> {
    const result = await this.host.run('tmux', args, {
      ...(input !== undefined ? { input } : {}),
      timeoutMs: 8_000
    })
    requireSuccess(result, 'tmux', args, `tmux ${args[0] ?? 'command'} failed`)
  }
}
