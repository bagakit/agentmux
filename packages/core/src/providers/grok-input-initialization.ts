import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AgentProviderInputInitialization, AgentProviderInputInitializationContext } from '../agent-provider.js'

const execute = promisify(execFile)
// Preserve the original argv. Only these root options are known to leave `inspect`
// as a read-only subcommand; single/resume/prompt/custom wrapper forms stay unknown.
const flags = new Set(['--always-approve', '--no-alt-screen', '--fullscreen', '--minimal', '--no-plan', '--no-subagents', '--disable-web-search', '--verbatim'])
const values = new Set(['--model', '-m', '--reasoning-effort', '--effort', '--permission-mode', '--leader-socket', '--cwd', '--add-dir'])
function inspectionArgs(original: readonly string[]): readonly string[] | undefined {
  // buildArgs carries its initial prompt in exactly one final `--`, prompt pair.
  // That is launch input, not configuration for a read-only subcommand.
  const separator = original.indexOf('--')
  if (separator >= 0 && separator !== original.length - 2) return
  const args = separator < 0 ? original : original.slice(0, separator)
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!, split = value.indexOf('='), name = split < 0 ? value : value.slice(0, split)
    if (flags.has(value)) continue
    if (!values.has(name) || (split < 0 && ++i >= args.length)) return
  }
  return args
}

/** Native inspect reports configuration, not a live input channel or trust consent. */
export async function readGrokInputInitialization(context: AgentProviderInputInitializationContext): Promise<AgentProviderInputInitialization> {
  const args = inspectionArgs(context.args)
  const home = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  // Historical overrides are not an effective environment snapshot. Never fill
  // missing native roots from the observing Core after restart/reconfiguration.
  if (!context.command || !isAbsolute(context.command) || context.processId === undefined || !args ||
      !context.env?.[home] || !context.env.GROK_HOME) return { state: 'unknown', reason: 'inspection-unavailable' }
  try {
    const env = Object.fromEntries(Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const { stdout } = await execute(context.command, [...args, 'inspect', '--json'], {
      cwd: context.workspacePath, env, ...(context.signal ? { signal: context.signal } : {}), maxBuffer: 1024 * 1024
    })
    const value: unknown = JSON.parse(stdout)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown', reason: 'inspection-unavailable' }
    const observed = value as Record<string, unknown>
    if (typeof observed.cwd !== 'string' || typeof observed.projectTrusted !== 'boolean' ||
        observed.cwd !== context.workspacePath && await realpath(observed.cwd) !== await realpath(context.workspacePath)) return { state: 'unknown', reason: 'inspection-unavailable' }
    return observed.projectTrusted === false ? { state: 'pending', reason: 'directory-trust' }
      : { state: 'unknown', reason: 'native-input-unconfirmed' }
  } catch {
    context.signal?.throwIfAborted()
    return { state: 'unknown', reason: 'inspection-unavailable' }
  }
}
