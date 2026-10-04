import { spawn } from 'node:child_process'
import { AgentMuxError } from './errors.js'

export type CommandInput = string | Uint8Array

export type RunCommandOptions = {
  cwd?: string
  env?: Readonly<Record<string, string | undefined>>
  input?: CommandInput
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

export type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunCommandOptions
) => Promise<CommandResult>

export const runProcess: ProcessRunner = async (command, args, options = {}) => {
  if (options.signal?.aborted) {
    throw new AgentMuxError('Command was cancelled before launch.', 'COMMAND_ABORTED')
  }
  const environment = { ...process.env }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }
  const maximumBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let timeout: NodeJS.Timeout | undefined

    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      child.kill('SIGTERM')
      reject(error)
    }
    const accept = (target: Buffer[], value: Buffer | string): void => {
      if (settled) return
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      outputBytes += chunk.byteLength
      if (outputBytes > maximumBytes) {
        finishError(new AgentMuxError('Command output exceeded its byte limit.', 'COMMAND_OUTPUT_LIMIT'))
        return
      }
      target.push(chunk)
    }
    const abort = (): void => finishError(new AgentMuxError('Command was cancelled.', 'COMMAND_ABORTED'))

    child.once('error', finishError)
    child.stdout.on('data', (chunk) => accept(stdout, chunk))
    child.stderr.on('data', (chunk) => accept(stderr, chunk))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? 1
      })
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        finishError(new AgentMuxError('Command timed out.', 'COMMAND_TIMEOUT'))
      }, options.timeoutMs)
    }
    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input)
  })
}
