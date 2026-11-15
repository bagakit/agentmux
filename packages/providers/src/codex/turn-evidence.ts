import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { codexTurnOutcome, codexTurnRecordId } from './turn-outcome.js'
import type { codexFailure } from './errors.js'

export type CodexPromptEvidence = {
  sourceId: string
  id: string
  state: 'idle' | 'working' | 'ended'
  nativeTurnId?: string
  nativeRecordId?: string
  nativeOrdinal?: number
  endReason?: 'interrupted' | 'completed' | 'failed'
  observedAt?: number
  failure?: ReturnType<typeof codexFailure>
}

export type CodexEvidenceContext = {
  nativeHandle?: Readonly<{ kind: string; providerId?: string; sessionId: string; transcriptPath?: string }>
  nativePromptPredecessor?: Readonly<{ run: { runId: string }; sourceId: string; evidenceId: string }>
}

const TAIL_BYTES = 512 * 1024
const HEADER_BYTES = 512 * 1024
export const codexNativeSourceId = (sessionId: string, source: { dev: bigint; ino: bigint }): string =>
  createHash('sha256').update(`[${JSON.stringify(sessionId)},${source.dev},${source.ino}]`).digest('base64url')

type CodexTurnRecord = { timestamp?: unknown; type?: unknown; ordinal?: unknown; payload?: {
  type?: unknown; turn_id?: unknown; thread_id?: unknown; completed_at_ms?: unknown
  item?: { type?: unknown; id?: unknown; kind?: unknown; agent_thread_id?: unknown }
} }

function isSubagentActivity(record: CodexTurnRecord): boolean {
  return record?.type === 'event_msg' && record.payload?.type === 'item_completed' && record.payload.item?.type === 'SubAgentActivity'
}

/** Codex emits this item only for a confirmed successful child turn. */
export function codexSubagentCompletion(value: unknown, nativeSessionId: string): {
  nativeSessionId: string; nativeAgentId: string; observedAt: number
} | undefined {
  const record = value as CodexTurnRecord, event = record?.payload
  if (!isSubagentActivity(record) || event?.thread_id !== nativeSessionId || event.item?.kind !== 'completed' ||
    typeof event.turn_id !== 'string' || !event.turn_id || typeof event.item.id !== 'string' || !event.item.id) return
  const nativeAgentId = event.item.agent_thread_id, observedAt = event.completed_at_ms
  if (typeof nativeAgentId !== 'string' || !nativeAgentId.trim() || nativeAgentId === nativeSessionId ||
    typeof observedAt !== 'number' || !Number.isSafeInteger(observedAt) || observedAt <= 0) return
  return { nativeSessionId, nativeAgentId, observedAt }
}

/** Undefined ignores an unrelated/older record; null means a malformed native turn fact. */
export function codexTurnRecordEvidence(value: unknown, sourceId: string, nativeSessionId: string,
  previous: CodexPromptEvidence | null = null): CodexPromptEvidence | null | undefined {
  const item = value as CodexTurnRecord
  if (isSubagentActivity(item)) return undefined
  const event = item?.payload
  const boundary = item?.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(event?.type))
  const turnRecord = item?.type === 'turn_context' || (item?.type === 'event_msg' &&
    event?.type === 'item_completed' && event.thread_id === nativeSessionId)
  if ((!boundary && !turnRecord) || !event || (event.thread_id !== undefined && event.thread_id !== nativeSessionId)) return undefined
  if (typeof event.turn_id !== 'string' || !event.turn_id || !Number.isSafeInteger(item.ordinal)) return null
  const state = !boundary || event.type === 'task_started' ? 'working' : 'ended'
  if (previous?.nativeOrdinal !== undefined && Number(item.ordinal) <= previous.nativeOrdinal) return undefined
  if (previous?.nativeTurnId) {
    const sameTurn = event.turn_id === previous.nativeTurnId
    // Item activity refreshes an established turn; only a real start/context opens another.
    if (event.type === 'item_completed' && (!sameTurn || previous.state === 'ended')) return undefined
    if (state === 'ended' && !sameTurn || state === 'working' && sameTurn && previous.state === 'ended') return undefined
  }
  const outcome = codexTurnOutcome(item as Record<string, unknown>, nativeSessionId)
  const observedAt = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN
  return { sourceId, id: createHash('sha256').update(JSON.stringify([sourceId, item.ordinal, item.type, event.type, event.turn_id])).digest('base64url'),
    nativeTurnId: event.turn_id, nativeOrdinal: Number(item.ordinal), state,
    ...(Number.isSafeInteger(observedAt) && observedAt >= 0 ? { observedAt } : {}),
    ...(outcome ? { endReason: outcome.status, ...(outcome.status === 'failed' ? { failure: outcome.failure } : {}) } : {}) }
}

/** Decode only the Provider's native turn records, with bounded work per operation.
 * Native pending steers are not written here; the complete visible pane guards them.
 * A truncated suffix without an actual turn boundary remains unknown.
 */
export async function readCodexPromptExecutionEvidence(context: CodexEvidenceContext, observeRecord?: (record: unknown) => void): Promise<CodexPromptEvidence | null> {
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
    const currentEvidence = (evidence: CodexPromptEvidence): CodexPromptEvidence =>
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
    let latest: CodexPromptEvidence | null = null
    let recordOffset = start + first
    for (const line of lines) {
      const value = JSON.parse(line)
      observeRecord?.(value)
      const evidence = codexTurnRecordEvidence(value, sourceId, handle.sessionId, latest)
      // A malformed current boundary cannot resurrect a prior success.
      if (evidence === null) return null
      if (evidence) latest = { ...evidence, nativeRecordId: codexTurnRecordId(value, recordOffset) }
      recordOffset += Buffer.byteLength(line) + 1
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
