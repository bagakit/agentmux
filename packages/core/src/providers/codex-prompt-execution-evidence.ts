import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { nativeProcessFiles, nativeProcessBirth } from '../agent-native-process.js'
import type { AgentProviderPromptExecutionContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence } from '../types.js'
import { AgentMuxError } from '../errors.js'
import { codexFailure } from './codex-errors.js'

const TAIL_BYTES = 512 * 1024
const HEADER_BYTES = 512 * 1024
export const codexNativeSourceId = (sessionId: string, source: { dev: bigint; ino: bigint }): string =>
  createHash('sha256').update(`[${JSON.stringify(sessionId)},${source.dev},${source.ino}]`).digest('base64url')

/** Only this negative observation may retain the startup loop's existing wait. */
export class CodexPromptTransportUnconfirmedError extends AgentMuxError {
  constructor(context: AgentProviderPromptExecutionContext, reason: string, ownerCount?: number) {
    super('The native input transport is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED',
      JSON.stringify({ providerId: 'codex', reason,
        ...(Number.isSafeInteger(context.processId) && context.processId! > 0 ? { processId: context.processId } : {}),
        ...(context.nativeSourceId && /^[A-Za-z0-9_-]{43}$/u.test(context.nativeSourceId) ? { nativeSourceId: context.nativeSourceId } : {}),
        ...(ownerCount === undefined ? {} : { ownerCount }) }))
  }
}

export function codexTurnRecordEvidence(value: unknown, sourceId: string, nativeSessionId: string): AgentPromptExecutionEvidence | null {
  const item = value as { timestamp?: unknown; type?: unknown; ordinal?: unknown; payload?: {
    type?: unknown; turn_id?: unknown; thread_id?: unknown; reason?: unknown; error?: unknown
  } }
  const event = item?.payload
  const boundary = item?.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(event?.type))
  const turnRecord = item?.type === 'turn_context' || (item?.type === 'event_msg' &&
    event?.type === 'item_completed' && event.thread_id === nativeSessionId)
  if ((!boundary && !turnRecord) || !event || (event.thread_id !== undefined && event.thread_id !== nativeSessionId)) return null
  if (typeof event.turn_id !== 'string' || !event.turn_id || !Number.isSafeInteger(item.ordinal)) return null
  const state = !boundary || event.type === 'task_started' ? 'working' : 'ended'
  const failure = state === 'ended' && event.error != null ? codexFailure(event.error, event.turn_id) : undefined
  const observedAt = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN
  return { sourceId, id: createHash('sha256').update(JSON.stringify([sourceId, item.ordinal, item.type, event.type, event.turn_id])).digest('base64url'),
    nativeTurnId: event.turn_id, nativeOrdinal: Number(item.ordinal), state,
    ...(Number.isSafeInteger(observedAt) && observedAt >= 0 ? { observedAt } : {}),
    ...(failure ? { endReason: 'failed', failure } : event.type === 'task_complete' ? { endReason: 'completed' } :
      event.type === 'turn_aborted' && event.reason === 'interrupted' ? { endReason: 'interrupted' } : {}) }
}

/** Current local transport is proven by the exact native source's unique writer
 * in this Run's process group. Executable path/version observations are separate:
 * removing a mapped pathname cannot change this current input capability.
 * The caller still requires the supported complete current native pane and turn
 * through inspectPromptExecution/readPromptExecutionEvidence before input.
 */
export function createCodexPromptExecutionTransportVerifier(): (context: AgentProviderPromptExecutionContext) => Promise<boolean> {
  return async (context) => {
    const unconfirmed: (reason: string, ownerCount?: number) => never = (reason, ownerCount) => {
      throw new CodexPromptTransportUnconfirmedError(context, reason, ownerCount)
    }
    if (context.args.some(arg => arg === '--remote' || arg.startsWith('--remote=')) || context.args.includes('agents')) unconfirmed('unsupported-launch')
    if (!context.processId || !Number.isSafeInteger(context.processId) || context.processId <= 0) unconfirmed('runtime-process-unavailable')
    const handle = context.nativeHandle
    if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) unconfirmed('native-handle-unavailable')
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000)
    const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source
    try {
      source = await file.stat({ bigint: true })
      if (!source.isFile()) unconfirmed('native-source-not-file')
      if (!context.nativeSourceId || codexNativeSourceId(handle.sessionId, source) !== context.nativeSourceId) unconfirmed('native-source-mismatch')
      const header = Buffer.alloc(Number(source.size < BigInt(HEADER_BYTES) ? source.size : BigInt(HEADER_BYTES)))
      await file.read(header, 0, header.length, 0)
      const end = header.indexOf(10)
      if (end < 0) unconfirmed('native-header-incomplete')
      const meta = JSON.parse(header.subarray(0, end).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
      // Resume appends to the creator's rollout. Its version is historical metadata.
      if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) unconfirmed('native-header-mismatch')
    } finally { await file.close() }
    const rootBirth = await nativeProcessBirth(context.processId, signal)
    const matches = (await nativeProcessFiles(context.processId, signal)).filter(file => file.path === handle.transcriptPath &&
      file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
    const owners = [...new Set(matches.map(file => file.processId))]
    if (owners.length !== 1) unconfirmed(owners.length === 0 ? 'native-source-writer-missing' : 'native-source-writer-ambiguous', owners.length)
    const nativePid = owners[0]!
    const nativeBirth = await nativeProcessBirth(nativePid, signal)
    const after = (await nativeProcessFiles(context.processId, signal)).filter(file =>
      file.path === handle.transcriptPath && file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
    const afterOwners = [...new Set(after.map(file => file.processId))]
    if (afterOwners.length !== 1 || afterOwners[0] !== nativePid) unconfirmed('native-source-writer-changed', afterOwners.length)
    if (!after.some(file => matches.some(old => old.processId === file.processId && old.descriptor === file.descriptor))) unconfirmed('native-writer-descriptor-changed')
    if (await nativeProcessBirth(context.processId, signal) !== rootBirth) unconfirmed('runtime-process-changed')
    if (await nativeProcessBirth(nativePid, signal) !== nativeBirth) unconfirmed('native-writer-process-changed')
    if ((await readCodexPromptExecutionEvidence({ ...context, signal }))?.sourceId !== context.nativeSourceId) unconfirmed('native-evidence-mismatch')
    return true
  }
}

/** Decode only the Provider's native turn records, with bounded work per operation.
 * Native pending steers are not written here; the complete visible pane guards them.
 * A truncated suffix without an actual turn boundary remains unknown.
 */
export async function readCodexPromptExecutionEvidence(context: AgentProviderPromptExecutionContext): Promise<AgentPromptExecutionEvidence | null> {
  const handle = context.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) return null
  const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile()) return null
    const size = Number(stat.size)
    if (!Number.isSafeInteger(size)) return null
    const header = Buffer.alloc(Math.min(size, HEADER_BYTES))
    await file.read(header, 0, header.length, 0)
    const headerEnd = header.indexOf(10)
    if (headerEnd < 0) return null
    const meta = JSON.parse(header.subarray(0, headerEnd).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
    if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return null
    const sourceId = codexNativeSourceId(handle.sessionId, stat)
    const predecessor = context.nativePromptPredecessor
    // The retained source must be exactly the one Core observed before this Run
    // started. A replacement cannot inherit an initial-idle authorization.
    if (predecessor && predecessor.sourceId !== sourceId) return null
    const currentEvidence = (evidence: AgentPromptExecutionEvidence): AgentPromptExecutionEvidence =>
      predecessor?.evidenceId === evidence.id
        ? { sourceId, id: createHash('sha256').update(JSON.stringify([
          'resumed-native-initial', predecessor.run.runId, sourceId, predecessor.evidenceId
        ])).digest('base64url'), state: 'idle' }
        : evidence
    const start = Math.max(0, size - TAIL_BYTES)
    const tail = Buffer.alloc(size - start)
    await file.read(tail, 0, tail.length, start)
    const completeEnd = tail.lastIndexOf(10)
    if (completeEnd < 0) return null
    const first = start ? tail.indexOf(10) + 1 : 0
    if (first <= 0 && start) return null
    const lines = tail.subarray(first, completeEnd).toString('utf8').split('\n')
    let latest: AgentPromptExecutionEvidence | null = null
    for (const line of lines) {
      const record = JSON.parse(line) as { type?: string; payload?: { type?: string; thread_id?: string } }
      const payload = record.payload
      const relevant = (record.type === 'turn_context' || (record.type === 'event_msg' &&
        ['task_started', 'task_complete', 'turn_aborted', 'item_completed'].includes(payload?.type ?? ''))) &&
        (payload?.thread_id === undefined || payload.thread_id === handle.sessionId) &&
        (payload?.type !== 'item_completed' || payload.thread_id === handle.sessionId)
      if (!relevant) continue
      const evidence = codexTurnRecordEvidence(record, sourceId, handle.sessionId)
      // A malformed current boundary cannot resurrect a prior success.
      if (!evidence) return null
      if (latest && evidence.nativeOrdinal! <= latest.nativeOrdinal!) continue
      if (latest && evidence.state === 'ended' && evidence.nativeTurnId !== latest.nativeTurnId) continue
      if (latest?.state === 'ended' && payload?.type === 'item_completed') continue
      latest = evidence
    }
    if (latest) return currentEvidence(latest)
    // A complete, small new transcript with no turn can prove initial idle. A
    // retained suffix cannot make the same assertion.
    return start === 0 ? currentEvidence({ sourceId, id: sourceId, state: 'idle' }) : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  } finally { await file.close() }
}
