import { isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import { parseNativeConfirmationHandle } from './agent-native-session-confirmation.js'
import type { AgentNativeResumeSource } from './types.js'

/** A Provider-issued exact persisted source, separate from Core Session and Runtime Run identity. */
export function parseAgentNativeResumeSource(value: unknown): AgentNativeResumeSource {
  const invalid = (): never => { throw new AgentMuxError('Native resume requires the exact Provider source, original directory and source revision.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['nativeHandle', 'workspacePath', 'revision'].includes(key)) ||
      typeof p.workspacePath !== 'string' || !isAbsolute(p.workspacePath) || /[\0\r\n]/u.test(p.workspacePath) ||
      typeof p.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(p.revision)) invalid()
  let nativeHandle: AgentNativeResumeSource['nativeHandle']
  try { nativeHandle = parseNativeConfirmationHandle(p.nativeHandle) } catch { return invalid() }
  if (!nativeHandle.transcriptPath) invalid()
  return { nativeHandle, workspacePath: p.workspacePath as string, revision: p.revision as string }
}
