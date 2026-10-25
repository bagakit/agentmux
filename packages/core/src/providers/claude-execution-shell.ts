import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { CLAUDE_EXECUTION_SHELL_TASK_PREFIX } from './claude-execution-protocol.js'

export interface ClaudeExecutionBashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}
export interface ClaudeExecutionBashResult {
  stdout: string
  stderr: string
  interrupted: boolean
  isImage: false
  noOutputExpected: boolean
  rawOutputPath?: string
  backgroundTaskId?: string
  backgroundOutputPath?: string
  timedOutAfterMs?: number
  /** Internal process outcome, removed before native MCP result projection. */
  exitCode?: number
}
export interface ClaudeExecutionTaskStopResult { message: string; task_id: string; task_type: 'local_bash'; command: string }
type Exit = { code: number | null; signal: NodeJS.Signals | null }
type Task = {
  id: string; command: string; child: ChildProcess; done: Promise<Exit>; outputPath: string
  exit?: Exit; stopped: boolean; stopping?: Promise<ClaudeExecutionTaskStopResult>
}
const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`
const text = (value: unknown): value is string => typeof value === 'string' && !!value && !value.includes('\0')
// Native Bash's model-facing response budget. Full output stays on its resource
// Host, so truncating this preview never truncates the actual command output.
const PREVIEW_BYTES = 30_000

/**
 * Provider shell resources inside the original helper Run, not a Run Runtime.
 * Core's execution journal owns dispatch/results; this object owns only the
 * children it actually spawned. Reader detach never calls close().
 * Authorization is the existing explicit host-user grant, not an OS sandbox.
 */
export function createClaudeExecutionShell(options: { workspacePath: string; outputDirectory: string; env?: NodeJS.ProcessEnv }) {
  if (!isAbsolute(options.workspacePath) || !isAbsolute(options.outputDirectory)) throw new TypeError('Exact resource shell paths must be absolute')
  const env = { ...process.env, ...options.env }
  const preferred = env.CLAUDE_CODE_GIT_BASH_PATH ?? env.SHELL
  const shell = preferred && isAbsolute(preferred) && ['bash', 'zsh', 'sh', 'bash.exe'].includes(basename(preferred)) ? preferred : '/bin/bash'
  const tasks = new Map<string, Task>()
  let cwd = options.workspacePath, closed = false
  const ready = mkdir(options.outputDirectory, { recursive: true, mode: 0o700 })
  async function signal(task: Task, value: NodeJS.Signals): Promise<void> {
    if (task.exit || task.child.pid === undefined) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(task.child.pid), '/T', '/F'], { stdio: 'ignore' })
      await new Promise<void>((resolve, reject) => { killer.once('error', reject); killer.once('close', code => code === 0 || task.exit ? resolve() : reject(new Error('The original resource process tree stop is unconfirmed'))) })
      return
    }
    try { process.kill(-task.child.pid, value) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  async function stop(task: Task): Promise<ClaudeExecutionTaskStopResult> {
    if (task.stopping) return await task.stopping
    task.stopping = (async () => {
      if (!task.exit) {
        task.stopped = true
        await signal(task, 'SIGTERM')
        // This grace applies only after an explicit stop, never to a slow tool.
        const force = setTimeout(() => { void signal(task, 'SIGKILL').catch(() => {}) }, 2_000)
        force.unref()
        try { await task.done } finally { clearTimeout(force) }
      }
      return { message: 'The original resource shell task has ended.', task_id: task.id, task_type: 'local_bash', command: task.command }
    })()
    return await task.stopping
  }
  return {
    async run(input: ClaudeExecutionBashInput, environment?: NodeJS.ProcessEnv): Promise<ClaudeExecutionBashResult> {
      if (closed) throw new Error('The original resource shell owner is closed')
      if (!text(input.command) || input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)) throw new TypeError('A shell command and positive optional wait are required')
      await ready
      if (closed) throw new Error('The original resource shell owner is closed')
      const id = `${CLAUDE_EXECUTION_SHELL_TASK_PREFIX}${randomUUID()}`, outputPath = join(options.outputDirectory, id + '.output')
      const scriptPath = join(options.outputDirectory, id + '.sh'), cwdPath = join(options.outputDirectory, id + '.cwd')
      // Dynamic command and cwd values live in the private script, never shell
      // command-line interpolation. Only successful foreground calls update cwd.
      await writeFile(scriptPath, `eval ${quote(input.command)} < /dev/null\n__amux_shell_exit=$?\npwd -P > ${quote(cwdPath)}\nexit $__amux_shell_exit\n`, { flag: 'wx', mode: 0o600 })
      const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
      await new Promise<void>((resolve, reject) => { output.once('open', () => resolve()); output.once('error', reject) })
      if (closed) { output.end(); await rm(scriptPath, { force: true }); throw new Error('The original resource shell owner is closed') }
      let stdoutBytes = 0, stderrBytes = 0, truncated = false
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      const collect = (chunks: Buffer[], data: Buffer, used: number): number => {
        const available = Math.max(0, PREVIEW_BYTES / 2 - used)
        if (data.length > available) truncated = true
        if (available) chunks.push(Buffer.from(data.subarray(0, available)))
        return used + Math.min(data.length, available)
      }
      const child = spawn(shell, [scriptPath], { cwd, env: { ...env, ...environment }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout!.pipe(output, { end: false }); child.stderr!.pipe(output, { end: false })
      child.stdout!.on('data', data => { stdoutBytes = collect(stdout, data, stdoutBytes) })
      child.stderr!.on('data', data => { stderrBytes = collect(stderr, data, stderrBytes) })
      let task!: Task
      let backgrounded = input.run_in_background === true
      const done = new Promise<Exit>((resolve, reject) => {
        child.once('error', error => { if (child.pid === undefined) reject(error) })
        child.once('close', (code, signal) => {
          const exit = { code, signal }
          task.exit = exit; tasks.delete(id)
          output.end(() => resolve(exit))
        })
        output.on('error', reject)
      })
      task = { id, command: input.command, child, done, outputPath, stopped: false }
      tasks.set(id, task)
      void done.finally(async () => {
        await rm(scriptPath, { force: true })
        if (backgrounded) await rm(cwdPath, { force: true })
      }).catch(() => {})
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      const result = (): ClaudeExecutionBashResult => ({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        interrupted: task.stopped || Boolean(task.exit?.signal), isImage: false, noOutputExpected: stdoutBytes + stderrBytes === 0,
        ...(truncated ? { rawOutputPath: outputPath } : {}) })
      if (input.run_in_background) {
        return { ...result(), backgroundTaskId: id, backgroundOutputPath: outputPath }
      }
      const waitMs = input.timeout ?? 120_000
      let timer: ReturnType<typeof setTimeout>
      const exit = await Promise.race([done, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs) })]).finally(() => clearTimeout(timer!))
      if (exit === null) { backgrounded = true; return { ...result(), backgroundTaskId: id, backgroundOutputPath: outputPath, timedOutAfterMs: waitMs } }
      if (exit.code === 0) {
        try {
          const next = (await readFile(cwdPath, 'utf8')).replace(/\r?\n$/u, '')
          // workspacePath is the starting location, not a host-user grant jail.
          if (isAbsolute(next)) cwd = await realpath(next)
        } catch { /* A missing cwd receipt cannot change the last confirmed location. */ }
      }
      await rm(cwdPath, { force: true })
      const value = result()
      if (exit.code !== null) value.exitCode = exit.code
      if (exit.code !== null && exit.code !== 0) value.stderr += `\nCommand exited with code ${exit.code}.`
      return value
    },
    async stop(input: { task_id?: string; shell_id?: string }): Promise<ClaudeExecutionTaskStopResult> {
      const id = input.task_id ?? input.shell_id
      const task = typeof id === 'string' ? tasks.get(id) : undefined
      if (!task) throw new Error('This original resource shell task is not running under this execution binding')
      return await stop(task)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await Promise.all([...tasks.values()].map(task => stop(task)))
    },
  }
}
