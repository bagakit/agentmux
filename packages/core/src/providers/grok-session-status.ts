import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentProviderPromptExecutionContext, AgentProviderSessionStatusObservationContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence, AgentProviderSessionHistoryContext, AgentProviderSessionStatus } from '../types.js'
import type { NativeJsonlHistoryRecord, NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { openGrokReader, resolveGrokUpdatesPath, verifyGrokSummaryIdentity } from './grok-native-history.js'
import { grokProcessSource } from './grok-native-source.js'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url')

/** Interpret only the original durable machine envelope. Stop/Hook annotations are not turn ends. */
export function grokTurnEvidence(entry: NativeJsonlHistoryRecord, sourceId: string, nativeSessionId: string,
  previous: AgentPromptExecutionEvidence | null, submittedTurn?: string): AgentPromptExecutionEvidence | null | undefined {
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
  const turn = end ? update.prompt_id : start ? submittedTurn ?? meta?.promptId : meta?.promptId
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

function eventSequence(meta: Record<string, unknown> | undefined, nativeSessionId: string): number | undefined {
  const id = meta?.eventId, prefix = nativeSessionId + '-'
  if (typeof id !== 'string' || !id.startsWith(prefix) || !/^\d+$/u.test(id.slice(prefix.length))) return
  const value = Number(id.slice(prefix.length))
  return Number.isSafeInteger(value) ? value : undefined
}

/** Native prompt gate -> accepted counted user run. Neither a gate nor the first named activity is completion. */
class GrokTurnScan {
  latest: AgentPromptExecutionEvidence | null = null
  private unknown: AgentProviderSessionStatus | undefined
  private knownTurn: string | undefined
  private pending: { turn: string; end: number; sequence: number; allowed: boolean; previousTurn?: string } | undefined
  private userRun: { turn: string; index?: number; end: number; sequence?: number } | undefined
  constructor(private readonly sourceId: string, private readonly nativeSessionId: string) {}
  retainPrevious(turn: string | undefined): void { this.knownTurn = turn }
  previous(): string | undefined { return this.knownTurn }
  observation(): AgentProviderSessionStatus | undefined { return this.latest ? status(this.latest) : this.unknown }
  accept(entry: NativeJsonlHistoryRecord): void {
    const value = entry.value, params = value.params
    if (!object(params) || params.sessionId !== this.nativeSessionId) throw new AgentMuxError('The native activity record belongs to another conversation.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    const update = object(params.update) ? params.update : {}, meta = object(params._meta) ? params._meta : undefined
    const pending = this.pending, userRun = this.userRun, previousTurn = this.knownTurn
    this.pending = undefined; this.userRun = undefined
    const unknown = (turn: unknown) => {
      this.latest = null
      this.unknown = text(turn) ? { recordId: hash([this.sourceId, entry.start, 'unconfirmed', turn]), nativeTurnId: turn,
        sequence: entry.start + 1, state: 'unknown' } : undefined
    }
    const sequence = eventSequence(meta, this.nativeSessionId)
    if (value.method === '_x.ai/session/update' && update.sessionUpdate === 'hook_execution' && update.event_name === 'user_prompt_submit') {
      unknown(update.prompt_id ?? previousTurn)
      const runs = update.runs
      const valid = Array.isArray(runs) && runs.length > 0 && runs.some(run => object(run) && object(run.status) && run.status.status !== 'skipped') && runs.every(run => {
        if (!object(run) || !text(run.name) || !object(run.status)) return false
        const state = run.status
        if (state.status === 'skipped') return true
        if (!Number.isSafeInteger(state.elapsed_ms) || Number(state.elapsed_ms) < 0) return false
        return state.status === 'success' || state.status === 'failed' && typeof state.error === 'string' && (state.blocked === undefined || state.blocked === false)
      })
      if (text(update.prompt_id) && sequence !== undefined) this.pending = { turn: update.prompt_id, end: entry.end, sequence,
        allowed: valid && meta?.isReplay !== true && (meta?.promptId === undefined || meta.promptId === update.prompt_id),
        ...(previousTurn ? { previousTurn } : {}) }
      return
    }
    let submitted: string | undefined
    if (value.method === 'session/update' && update.sessionUpdate === 'user_message_chunk') {
      const index = object(update._meta) ? update._meta.promptIndex : undefined
      const counted = Number.isSafeInteger(index) && Number(index) >= 0
      if (object(update._meta) && update._meta.promptIndex !== undefined && !counted) { unknown(meta?.promptId ?? previousTurn); return }
      if (!text(meta?.promptId)) {
        if (counted && sequence !== undefined && pending?.allowed && pending.end === entry.start && sequence === pending.sequence + 1 && pending.turn !== pending.previousTurn) submitted = pending.turn
        else if (counted && sequence !== undefined && userRun && userRun.sequence !== undefined && userRun.index === index && userRun.end === entry.start && sequence === userRun.sequence + 1) submitted = userRun.turn
        else { unknown(pending?.turn ?? previousTurn); return }
      } else if (pending && (!pending.allowed || pending.turn !== meta.promptId)) { unknown(pending.turn); return }
      else if (userRun && userRun.index === index && userRun.turn !== meta?.promptId) { unknown(previousTurn); return }
      if (meta?.isReplay === true) { unknown(submitted ?? meta?.promptId ?? previousTurn); return }
      const turn = submitted ?? String(meta?.promptId)
      const continuation = userRun?.end === entry.start && userRun.turn === turn && userRun.index === index &&
        (sequence === undefined || userRun.sequence === undefined || sequence === userRun.sequence + 1)
      if (!continuation && turn === previousTurn) { unknown(turn); return }
      this.userRun = { turn, end: entry.end, ...(counted ? { index: Number(index) } : {}), ...(sequence === undefined ? {} : { sequence }) }
    }
    const next = grokTurnEvidence(entry, this.sourceId, this.nativeSessionId, this.latest, submitted)
    if (next === null) { unknown(meta?.promptId ?? update.prompt_id ?? previousTurn); return }
    if (next !== undefined) { this.latest = next; this.knownTurn = next.nativeTurnId; this.unknown = undefined }
  }
}

/** One original user run, its adjacent gate, and following machine records. */
async function turnFrame(reader: NativeJsonlHistoryReader, before = reader.sourceSizeBytes): Promise<NativeJsonlHistoryRecord[]> {
  const suffix: NativeJsonlHistoryRecord[] = []
  let row: NativeJsonlHistoryRecord | null, at = before
  while ((row = await reader.readBefore(at))) {
    at = row.start
    suffix.push(row)
    const p = row.value.params
    if (!object(p) || !object(p.update) || row.value.method !== 'session/update' || p.update.sessionUpdate !== 'user_message_chunk') continue
    const index = object(p.update._meta) ? p.update._meta.promptIndex : undefined
    const named = object(p._meta) ? p._meta.promptId : undefined
    let first = row.start, before = await reader.readBefore(row.start)
    while (before) {
      const prior = before.value.params
      if (before.end !== first || !object(prior) || !object(prior.update) || before.value.method !== 'session/update' || prior.update.sessionUpdate !== 'user_message_chunk') break
      const priorIndex = object(prior.update._meta) ? prior.update._meta.promptIndex : undefined
      const countedRun = Number.isSafeInteger(index) && priorIndex === index
      const explicitRun = index === undefined && priorIndex === undefined && text(named) && object(prior._meta) && prior._meta.promptId === named
      if (!countedRun && !explicitRun) break
      suffix.push(before); first = before.start; before = await reader.readBefore(before.start)
    }
    if (before) suffix.push(before)
    break
  }
  return suffix.reverse()
}

/** Current and immediately preceding qualified frames, never a full-prefix retired-ID ledger. */
async function currentTurn(reader: NativeJsonlHistoryReader, scan: GrokTurnScan, sourceId: string, nativeSessionId: string): Promise<void> {
  const entries = await turnFrame(reader)
  const user = entries.find(entry => entry.value.method === 'session/update' && object(entry.value.params) &&
    object(entry.value.params.update) && entry.value.params.update.sessionUpdate === 'user_message_chunk')
  let before = entries[0]?.start ?? 0
  // A claimed ID or index zero does not prove that a current source has no prior turn.
  // Retain the nearest actual qualified predecessor, just as the live scan does.
  if (user) {
    while (before > 0) {
      const frame = await turnFrame(reader, before), previous = new GrokTurnScan(sourceId, nativeSessionId)
      for (const entry of frame) previous.accept(entry)
      if (previous.previous()) { scan.retainPrevious(previous.previous()); break }
      const start = frame[0]?.start ?? 0
      if (start >= before) break
      before = start
    }
  }
  for (const entry of entries) scan.accept(entry)
}

async function completeCut(reader: NativeJsonlHistoryReader): Promise<boolean> {
  await reader.seekChanges(undefined, true)
  return ((await reader.readBeforeChanges())?.end ?? 0) === reader.sourceSizeBytes
}

async function source(context: AgentProviderPromptExecutionContext, signal: AbortSignal) {
  const handle = context.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== 'grok') throw new AgentMuxError(
    'The original Grok native identity is unconfirmed.', 'AGENT_NATIVE_STATUS_UNAVAILABLE')
  // An exact retained path stands independently; an id-only locator needs its original private root.
  const home = context.env?.[process.platform === 'win32' ? 'USERPROFILE' : 'HOME']
  const root = context.env?.GROK_HOME || (home ? join(home, '.grok') : undefined)
  const witness = !handle.transcriptPath && !root ? await grokProcessSource(context, signal) : undefined
  const input: AgentProviderSessionHistoryContext = { source: { providerId: 'grok', nativeSessionId: handle.sessionId },
    ...(handle.transcriptPath || witness ? { transcriptPath: handle.transcriptPath ?? witness!.path } : {}), command: context.command ?? '', args: context.args,
    env: { ...context.env, ...(root ? { GROK_HOME: root } : {}) }, workspacePath: context.workspacePath, signal, limit: 1 }
  const path = await resolveGrokUpdatesPath(input), stat = await lstat(path, { bigint: true })
  if (!stat.isFile()) throw new AgentMuxError('The original native status file is unconfirmed.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
  const sourceId = hash(['grok', handle.sessionId, String(stat.dev), String(stat.ino)])
  if (context.nativePromptPredecessor && context.nativePromptPredecessor.sourceId !== sourceId) throw new AgentMuxError(
    'The original native status generation changed.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
  return { input: { ...input, transcriptPath: path }, path, sourceId, stat, witness }
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
    const extent = reader.sourceSizeBytes
    if (!await completeCut(reader)) return null
    const scan = new GrokTurnScan(original.sourceId, original.input.source.nativeSessionId)
    await currentTurn(reader, scan, original.sourceId, original.input.source.nativeSessionId)
    const latest = scan.latest
    await reader.verifyUnchanged()
    await original.witness?.assertCurrent()
    if (reader.sourceSizeBytes !== extent) return null // A partial suffix is not an idle opportunity.
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
  const turns = new GrokTurnScan(original.sourceId, original.input.source.nativeSessionId)
  let observer: { dispose(): void } | undefined
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
      const extent = reader.sourceSizeBytes
      await reader.seekChanges(cursor)
      let entry: NativeJsonlHistoryRecord | null
      const emit = (value: AgentProviderSessionStatus) => {
        if (context.nativePromptPredecessor?.evidenceId === value.recordId) return
        if (value && !disposed && !context.signal.aborted) context.onStatus({ ...value, ...(initial ? { initialSnapshot: true as const } : {}) })
      }
      const previousId = turns.observation()?.recordId
      if (initial) {
        if (!await completeCut(reader)) throw new AgentMuxError('The original native turn append is incomplete.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
        await currentTurn(reader, turns, original.sourceId, original.input.source.nativeSessionId); consumed = reader.sourceSizeBytes
      }
      else while ((entry = await reader.readNext())) { consumed = entry.end; turns.accept(entry) }
      cursor = await reader.changesCursor()
      await original.witness?.assertCurrent()
      // The cursor retains a complete original boundary; never join an unconfirmed suffix to a later source.
      if (consumed < reader.sourceSizeBytes || reader.sourceSizeBytes !== extent) throw new AgentMuxError('The original native turn append is incomplete.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
      const latest = turns.observation()
      if (!latest) throw new AgentMuxError('The original native source has no qualified turn boundary.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
      if (initial || latest.recordId !== previousId) emit(latest)
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
