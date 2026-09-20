import { stat } from 'node:fs/promises'
import { shell } from 'electron'
import { AgentMuxError, type AgentMuxControlCrashLogFact, type AgentMuxControlCrashLogRequest,
  type AgentMuxControlCrashLogResult } from '@agentmux/core'
import type { CrashLogRevealResult } from '../shared/contracts.js'
import { crashLogPath } from './crash-log.js'

function cause(error: unknown): { code: string; message: string } {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'CONTROL_FAILED'
  return { code, message: error instanceof Error ? error.message : String(error) }
}

/** A current fixed-path fact; neither file contents nor configuration are read. */
export async function inspectCrashLog(): Promise<AgentMuxControlCrashLogFact> {
  const path = crashLogPath()
  try {
    const file = await stat(path)
    return file.isFile() ? { path, outcome: 'present' }
      : { path, outcome: 'check-failed', cause: { code: 'CRASH_LOG_NOT_FILE', message: 'The crash log path is not a regular file.' } }
  } catch (error) {
    const original = cause(error)
    return original.code === 'ENOENT' ? { path, outcome: 'absent' }
      : { path, outcome: 'check-failed', cause: original }
  }
}

/** Electron accepts a request; its void return does not prove a visible file manager. */
export async function requestCrashLogReveal(): Promise<CrashLogRevealResult> {
  const fact = await inspectCrashLog()
  if (fact.outcome !== 'present') return fact
  try {
    shell.showItemInFolder(fact.path)
    return { path: fact.path, outcome: 'requested' }
  } catch (error) {
    return { path: fact.path, outcome: 'check-failed', cause: cause(error) }
  }
}

export async function executeCrashLogControl(request: AgentMuxControlCrashLogRequest): Promise<AgentMuxControlCrashLogResult> {
  if (request.operation === 'diagnostics.crash-log.get') return { operation: request.operation, ...await inspectCrashLog() }
  const result = await requestCrashLogReveal()
  if (result.outcome === 'requested') return { operation: request.operation, path: result.path, requested: true }
  if (result.outcome === 'absent') throw new AgentMuxError(`ENOENT: No crash log file exists at ${result.path}.`, 'CONTROL_FAILED', 'ENOENT')
  throw new AgentMuxError(`Could not request the crash log at ${result.path}: ${result.cause.code} · ${result.cause.message}`,
    result.cause.code === 'CRASH_LOG_NOT_FILE' ? result.cause.code : 'CONTROL_FAILED', result.cause.code)
}
