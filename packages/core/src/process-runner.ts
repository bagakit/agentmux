import { execa } from 'execa'

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
  const result = await execa(command, args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    maxBuffer: options.maxOutputBytes ?? 8 * 1024 * 1024,
    reject: false,
    stripFinalNewline: false
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1
  }
}
