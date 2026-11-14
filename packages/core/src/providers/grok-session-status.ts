import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentProviderPromptExecutionContext, AgentProviderSessionStatusObservationContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence, AgentProviderSessionHistoryContext, AgentProviderSessionStatus } from '../types.js'
import type { NativeJsonlHistoryRecord, NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { openGrokReader, resolveGrokUpdatesPath, verifyGrokSummaryIdentity } from './grok-native-history.js'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url')

/** Interpret only the original durable machine envelope. Stop/Hook annotations are not turn ends. */
export function grokTurnEvidence(entry: NativeJsonlHistoryRecord, sourceId: string, nativeSessionId: string,
  previous: AgentPromptExecutionEvidence | null): AgentPromptExecutionEvidence | null | undefined {
  const value = entry.value, params = value.params
  if (!object(params) || params.sessionId !== nativeSessionId) throw new AgentMuxError(
    'The native activity record belongs to another conversation.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
  const update = params.update
  if (!object(update) || typeof update.sessionUpdate !== 'string') return null
  const kind = update.sessionUpdate, meta = object(params._meta) ? params._meta : undefined
  const start = value.method === 'session/update' && kind === 'user_message_chunk'
  const activity = value.method === 'session/update' && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(kind)
  const end = value.method === '_x.ai/session/update' && kind === 'turn_completed'
  if (!start && !activity && !end) return undefined
  const turn = end ? update.prompt_id : meta?.promptId
  if (!text(turn) || end && meta?.promptId !== undefined && meta.promptId !== turn) return null
  const sequence = entry.start + 1
  if (previous?.nativeOrdinal !== undefined && sequence <= previous.nativeOrdinal) return undefined
  if (previous?.nativeTurnId) {
    const same = previous.nativeTurnId === turn
    if (end && !same || activity && (!same || previous.state === 'ended') || start && same && previous.state === 'ended') return undefined
  } else if (!start) return null
  const rawTime = meta?.agentTimestampMs ?? (typeof value.timestamp === 'number' ? value.timestamp * 1000 : undefined)
  const observedAt = Number.isSafeInteger(rawTime) && Number(rawTime) >= 0 ? Number(rawTime) : undefined
  const base = { sourceId, id: hash([sourceId, sequence, kind, turn]), nativeTurnId: turn,
    nativeOrdinal: sequence, nativeRecordId: `grok-update:${entry.start}`, ...(observedAt === undefined ? {} : { observedAt }) }
  if (!end) return { ...base, state: 'working' }
  if (update.error_kind != null) {
    if (!text(update.error_kind)) return null
    return { ...base, state: 'ended', endReason: 'failed', failure: { code: 'AGENT_PROVIDER_ERROR',
      nativeCode: update.error_kind, nativeTurnId: turn, message: 'The original Grok turn failed.',
      recovery: 'Inspect the original native failure before explicitly retrying.' } }
  }
  if (update.stop_reason !== 'end_turn') return null
  return { ...base, state: 'ended', endReason: 'completed' }
}

async function source(context: AgentProviderPromptExecutionContext, signal: AbortSignal) {
  const handle = context.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== 'grok') throw new AgentMuxError(
    'The original Grok native identity is unconfirmed.', 'AGENT_NATIVE_STATUS_UNAVAILABLE')
  // An exact retained path stands independently; an id-only locator needs its original private root.
  const home = context.env?.[process.platform === 'win32' ? 'USERPROFILE' : 'HOME']
  const root = context.env?.GROK_HOME || (home ? join(home, '.grok') : undefined)
  if (!handle.transcriptPath && !root) throw new AgentMuxError(
    'The original Grok execution environment is unconfirmed. Retained work and manual input remain available.', 'AGENT_NATIVE_STATUS_UNAVAILABLE')
  const input: AgentProviderSessionHistoryContext = { source: { providerId: 'grok', nativeSessionId: handle.sessionId },
    ...(handle.transcriptPath ? { transcriptPath: handle.transcriptPath } : {}), command: context.command ?? '', args: context.args,
    env: { ...context.env, ...(root ? { GROK_HOME: root } : {}) }, workspacePath: context.workspacePath, signal, limit: 1 }
  const path = await resolveGrokUpdatesPath(input), stat = await lstat(path, { bigint: true })
  if (!stat.isFile()) throw new AgentMuxError('The original native status file is unconfirmed.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
  const sourceId = hash(['grok', handle.sessionId, String(stat.dev), String(stat.ino)])
  if (context.nativePromptPredecessor && context.nativePromptPredecessor.sourceId !== sourceId) throw new AgentMuxError(
    'The original native status generation changed.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
  return { input: { ...input, transcriptPath: path }, path, sourceId, stat }
}

function assertOpenedSource(reader: NativeJsonlHistoryReader, original: Awaited<ReturnType<typeof source>>) {
  const actual = reader.sourceIdentity
  if (BigInt(actual.dev) !== original.stat.dev || BigInt(actual.ino) !== original.stat.ino) throw new AgentMuxError(
    'The original native source changed before its descriptor was opened.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
}

/** One current turn is sufficient for the finite read; older unrelated turns need no parsing. */
export async function readGrokPromptExecutionEvidence(context: AgentProviderPromptExecutionContext): Promise<AgentPromptExecutionEvidence | null> {
  const signal = context.signal ?? new AbortController().signal
  const original = await source(context, signal), reader = await openGrokReader(original.input)
  try {
    assertOpenedSource(reader, original)
    const suffix: NativeJsonlHistoryRecord[] = []
    let row: NativeJsonlHistoryRecord | null
    while ((row = await reader.readPrevious())) {
      suffix.push(row)
      const params = row.value.params
      if (object(params) && object(params.update) && row.value.method === 'session/update' && params.update.sessionUpdate === 'user_message_chunk') break
    }
    let latest: AgentPromptExecutionEvidence | null = null
    for (const entry of suffix.reverse()) {
      const next = grokTurnEvidence(entry, original.sourceId, original.input.source.nativeSessionId, latest)
      if (next !== undefined) latest = next
    }
    await reader.verifyUnchanged()
    if (reader.sourceSizeBytes !== Number(original.stat.size)) return null // A partial suffix is not an idle opportunity.
    if (latest && context.nativePromptPredecessor?.evidenceId === latest.id) return { sourceId: latest.sourceId,
      id: hash(['grok-resumed-initial', context.nativePromptPredecessor.run.runId, latest.id]), state: 'idle' }
    return latest
  } finally { await reader.close() }
}

function status(evidence: AgentPromptExecutionEvidence): AgentProviderSessionStatus | undefined {
  if (!evidence.nativeTurnId || evidence.state === 'idle') return
  return { recordId: evidence.id, nativeTurnId: evidence.nativeTurnId,
    ...(evidence.nativeOrdinal === undefined ? {} : { sequence: evidence.nativeOrdinal }),
    ...(evidence.nativeRecordId === undefined ? {} : { nativeRecordId: evidence.nativeRecordId }), state: evidence.state === 'working' ? 'working' : evidence.endReason === 'failed' ? 'error' : 'done',
    ...(evidence.endReason ? { endReason: evidence.endReason } : {}),
    ...(evidence.observedAt === undefined ? {} : { nativeObservedAt: evidence.observedAt }), ...(evidence.failure ? { failure: evidence.failure } : {}) }
}

/** The existing bounded JSONL reader and exact-file watch; no polling or per-Session store. */
export async function observeGrokSessionStatus(context: AgentProviderSessionStatusObservationContext): Promise<{ dispose(): void }> {
  const original = await source(context, context.signal)
  let disposed = false, reading = false, queued = false, cursor: string | undefined
  let consumed = 0
  let latest: AgentPromptExecutionEvidence | null = null, observer: { dispose(): void } | undefined
  const dispose = () => { if (!disposed) { disposed = true; observer?.dispose(); context.signal.removeEventListener('abort', dispose) } }
  const unavailable = (error: unknown) => {
    if (disposed || context.signal.aborted) return
    context.onUnavailable(error instanceof AgentMuxError ? error.code : 'AGENT_NATIVE_STATUS_UNAVAILABLE',
      error instanceof Error ? error.message : 'The original native activity is unconfirmed.')
    dispose()
  }
  const scan = async (initial: boolean) => {
    await verifyGrokSummaryIdentity(dirname(original.path), original.input, { bytesRead: 0, startedAt: Date.now() })
    const physical = await lstat(original.path, { bigint: true })
    if (!physical.isFile() || physical.dev !== original.stat.dev || physical.ino !== original.stat.ino) throw new AgentMuxError(
      'The original native activity source was replaced.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    const reader = await openGrokReader(original.input)
    try {
      assertOpenedSource(reader, original)
      await reader.seekChanges(cursor)
      let entry: NativeJsonlHistoryRecord | null
      const emit = (evidence: AgentPromptExecutionEvidence) => {
        if (context.nativePromptPredecessor?.evidenceId === evidence.id) return
        const value = status(evidence)
        if (value && !disposed && !context.signal.aborted) context.onStatus({ ...value, ...(initial ? { initialSnapshot: true as const } : {}) })
      }
      const previousId = latest?.id
      while ((entry = await reader.readNext())) {
        consumed = entry.end
        const next = grokTurnEvidence(entry, original.sourceId, original.input.source.nativeSessionId, latest)
        if (next === null) throw new AgentMuxError('The original native turn boundary is unconfirmed.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
        if (next) latest = next
      }
      cursor = await reader.changesCursor()
      // The cursor retains a complete original boundary; never join an unconfirmed suffix to a later source.
      if (consumed < reader.sourceSizeBytes) throw new AgentMuxError('The original native turn append is incomplete.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
      if (initial && !latest) throw new AgentMuxError('The original native source has no qualified turn boundary.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
      if (latest && (initial || latest.id !== previousId)) emit(latest)
    } finally { await reader.close() }
  }
  const check = () => {
    queued = true
    if (reading || disposed) return
    reading = true
    void (async () => {
      try { while (queued && !disposed) { queued = false; await scan(false) } }
      catch (error) { unavailable(error) }
      finally { reading = false }
    })()
  }
  try {
    await scan(true)
    observer = await observeNativeJsonlHistory({ ...original.input, onChange: value => value.kind === 'invalidated'
      ? check() : unavailable(new AgentMuxError(value.message, value.code)) })
    context.signal.addEventListener('abort', dispose, { once: true }); context.signal.throwIfAborted()
    check() // Close the original read-to-watch gap.
    return { dispose }
  } catch (error) { dispose(); throw error }
}
