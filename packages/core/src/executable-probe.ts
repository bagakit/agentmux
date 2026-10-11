import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { AgentMuxExecutorProbeResult } from './control.js'
import { AgentMuxError } from './errors.js'
import { missingExecutableCause } from './executable-diagnostics.js'

/** The executing Host's original invocation context. Omission never selects a workspace. */
export type AgentExecutableProbeContext = {
  workspacePath?: string
  env?: Readonly<Record<string, string>>
}

/** Observe one command without executing it or modifying the Host environment. */
export async function classifyExecutable(executable: string, context: AgentExecutableProbeContext = {}): Promise<AgentMuxExecutorProbeResult> {
  const searchPath = context.env?.PATH ?? process.env.PATH ?? ''
  const candidates = isAbsolute(executable) || executable.includes('/')
    ? [executable]
    : searchPath === '' && context.workspacePath === undefined ? []
      : searchPath.split(delimiter).map(directory => join(directory, executable))
  if (candidates.length === 0) return { executable, availability: 'check-failed', cause: {
    code: 'EXECUTABLE_SEARCH_UNAVAILABLE',
    message: `No candidate path was searchable for "${executable}". Check PATH and the shell environment this app was launched from.`
  } }
  let unknown: { code: string; message: string } | undefined
  let relative: { code: string; message: string } | undefined
  let notFile: { code: string; message: string } | undefined
  for (const value of candidates) {
    if (!isAbsolute(value) && context.workspacePath === undefined) {
      relative ??= { code: 'EXECUTABLE_WORKSPACE_REQUIRED', message: 'The executable candidate depends on its execution workspace. Supply that workspace to check the original launch.' }
      continue
    }
    const candidate = isAbsolute(value) ? value : resolve(context.workspacePath!, value)
    try {
      const metadata = await stat(candidate)
      if (!metadata.isFile()) {
        notFile ??= { code: 'EXECUTABLE_NOT_FILE', message: `${candidate} is ${metadata.isDirectory() ? 'a directory' : 'not a regular file'}; expected a regular executable file.` }
        continue
      }
      await access(candidate, constants.X_OK)
      // An earlier workspace-dependent PATH entry may select another executable.
      if (relative) return { executable, availability: 'check-failed', cause: relative }
      return { executable, availability: 'available' }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : 'EXECUTABLE_CHECK_FAILED'
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unknown ??= { code, message: error instanceof Error ? error.message : String(error) }
    }
  }
  if (relative || unknown) return { executable, availability: 'check-failed', cause: (relative ?? unknown)! }
  return { executable, availability: 'missing', cause: notFile ?? missingExecutableCause(executable) }
}

/** Keep the actual launch check's context when explaining a failed preflight. */
export async function executorUnavailableError(label: string, executable: string, context: AgentExecutableProbeContext): Promise<AgentMuxError> {
  const result = await classifyExecutable(executable, context)
  if (result.availability === 'check-failed') return new AgentMuxError(
    `Could not verify the ${label} executable on this host: ${result.cause.code}: ${result.cause.message}`,
    'AGENT_NOT_FOUND', 'executor-check-failed')
  if (result.availability === 'available') return new AgentMuxError(
    `${label} executable availability changed while preparing the launch. Retry the launch.`, 'AGENT_NOT_FOUND', 'executor-check-failed')
  return new AgentMuxError(result.cause ? `The configured ${label} executable is not available: ${result.cause.message}`
    : missingExecutableCause(executable).message, 'AGENT_NOT_FOUND', 'executor-missing')
}
