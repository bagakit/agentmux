import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import type { AgentProviderSessionStatusContext, AgentProviderSessionStatusObservationContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence, AgentProviderSessionStatus } from '../types.js'
import { codexTurnRecordId } from './codex-turn-outcome.js'
import { codexNativeSourceId, codexTurnRecordEvidence, readCodexPromptExecutionEvidence } from './codex-prompt-execution-evidence.js'

const READ_BYTES = 512 * 1024

function status(evidence: AgentPromptExecutionEvidence | null, context: AgentProviderSessionStatusContext): AgentProviderSessionStatus | null {
  if (!evidence?.nativeTurnId || evidence.state === 'idle' || context.nativePromptPredecessor?.evidenceId === evidence.id) return null
  return { recordId: evidence.id, nativeTurnId: evidence.nativeTurnId,
    ...(evidence.nativeRecordId ? { nativeRecordId: evidence.nativeRecordId } : {}),
    ...(evidence.nativeOrdinal === undefined ? {} : { sequence: evidence.nativeOrdinal }),
    state: evidence.state === 'working' ? 'working' : evidence.endReason === 'failed' ? 'error' : evidence.endReason === 'completed' ? 'done' : 'unknown',
    ...(evidence.endReason ? { endReason: evidence.endReason } : {}),
    ...(evidence.observedAt === undefined ? {} : { nativeObservedAt: evidence.observedAt }),
    ...(evidence.failure ? { failure: evidence.failure } : {}) }
}

/** One exact source watch and bounded incremental bytes, independent of other Sessions/PTY traffic. */
export async function observeCodexSessionStatus(context: AgentProviderSessionStatusObservationContext): Promise<{ dispose(): void }> {
  const handle = context.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) {
    throw new AgentMuxError('The native status source has not been established.', 'AGENT_NATIVE_STATUS_UNAVAILABLE')
  }
  const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let observer: { dispose(): void } | undefined
  let disposed = false, reading = false, queued = false, offset = 0
  let carry: Buffer = Buffer.alloc(0)
  let latest: AgentPromptExecutionEvidence | null = null
  const decoder = new TextDecoder('utf8', { fatal: true })
  const dispose = (): void => {
    if (disposed) return
    disposed = true; observer?.dispose(); context.signal.removeEventListener('abort', dispose)
    void file.close()
  }
  const unavailable = (error: unknown): void => {
    if (disposed) return
    context.onUnavailable(error instanceof AgentMuxError ? error.code : 'AGENT_NATIVE_STATUS_UNAVAILABLE',
      error instanceof Error ? error.message : 'Native status observation failed. Inspect the Session to retry.')
    dispose()
  }
  try {
    context.signal.throwIfAborted()
    const stat = await file.stat({ bigint: true })
    const sourceId = codexNativeSourceId(handle.sessionId, stat)
    const header = Buffer.alloc(Math.min(Number(stat.size), READ_BYTES))
    await file.read(header, 0, header.length, 0)
    const end = header.indexOf(10)
    if (!stat.isFile() || end < 0) throw new AgentMuxError('Native status source identity is unknown.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
    const meta = JSON.parse(header.subarray(0, end).toString('utf8')) as { type?: string; payload?: { session_id?: string; id?: string } }
    if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId ||
      (context.nativePromptPredecessor && context.nativePromptPredecessor.sourceId !== sourceId)) {
      throw new AgentMuxError('Native status source does not match the original conversation.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    }
    const emit = (evidence: AgentPromptExecutionEvidence | null, initialSnapshot = false): void => {
      if (disposed || context.signal.aborted) return
      const next = status(evidence, context)
      if (next) context.onStatus({ ...next, ...(initialSnapshot ? { initialSnapshot: true as const } : {}) })
    }
    // Keep the predecessor's ordering/terminal fence even when its display is suppressed.
    const { nativePromptPredecessor: _predecessor, ...sourceContext } = context
    const initial = await readCodexPromptExecutionEvidence(sourceContext)
    if (!initial) throw new AgentMuxError('The current native turn status is unknown. No completion was inferred.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
    if (initial && initial.sourceId !== sourceId) throw new AgentMuxError('Native status source changed during the read.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    latest = initial
    emit(initial, true)
    offset = Number(stat.size)
    // Do not join an incomplete pre-watch suffix to an unrelated subsequent line.
    const lastByte = Buffer.alloc(1)
    if (offset) await file.read(lastByte, 0, 1, offset - 1)
    if (offset && lastByte[0] !== 10) {
      const tail = Buffer.alloc(Math.min(offset, READ_BYTES)); await file.read(tail, 0, tail.length, offset - tail.length)
      const newline = tail.lastIndexOf(10)
      carry = newline >= 0 ? tail.subarray(newline + 1) : Buffer.alloc(0)
    }
    const check = (): void => {
      queued = true
      if (reading || disposed) return
      reading = true
      void (async () => {
        try {
          while (queued && !disposed) {
            queued = false
            const current = await file.stat({ bigint: true })
            if (current.size < BigInt(offset)) throw new AgentMuxError('Native status source was truncated.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
            const size = Number(current.size)
            if (size === offset) continue
            const start = Math.max(offset, size - READ_BYTES)
            const gap = start > offset
            const bytes = Buffer.alloc(size - start); await file.read(bytes, 0, bytes.length, start)
            if (gap) {
              carry = Buffer.alloc(0)
              context.onUnavailable('AGENT_NATIVE_STATUS_GAP', 'Native status exceeded the observation window. The retained state and input remain available; inspect the current Session.')
            }
            const skipped = gap ? (bytes.indexOf(10) < 0 ? bytes.length : bytes.indexOf(10) + 1) : 0
            const recordStart = gap ? start + skipped : offset - carry.length
            const data = Buffer.concat([carry, bytes.subarray(skipped)])
            let from = 0
            for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, from)) {
              const line = data.subarray(from, end), recordOffset = recordStart + from
              from = end + 1
              if (!line.length) continue
              const value = JSON.parse(decoder.decode(line))
              const evidence = codexTurnRecordEvidence(value, sourceId, handle.sessionId, latest)
              if (evidence === null) throw new AgentMuxError('The appended native turn status is unknown. No completion was inferred.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
              if (evidence) {
                latest = { ...evidence, nativeRecordId: codexTurnRecordId(value, recordOffset) }
                emit(latest)
              }
            }
            carry = data.subarray(from); offset = size
            if (carry.length > READ_BYTES) {
              carry = Buffer.alloc(0)
              context.onUnavailable('AGENT_NATIVE_STATUS_GAP', 'A native status record exceeded the observation window. The retained state and input remain available.')
            }
          }
        } catch (error) { unavailable(error) }
        finally { reading = false }
      })()
    }
    observer = await observeNativeJsonlHistory({ source: { providerId: 'codex', nativeSessionId: handle.sessionId },
      transcriptPath: handle.transcriptPath, workspacePath: context.workspacePath, command: '', args: context.args, env: {}, signal: context.signal,
      onChange: observation => observation.kind === 'invalidated' ? check() : unavailable(new AgentMuxError(observation.message, observation.code)) })
    const currentPath = await lstat(handle.transcriptPath, { bigint: true })
    if (!currentPath.isFile() || currentPath.dev !== stat.dev || currentPath.ino !== stat.ino) {
      throw new AgentMuxError('Native status source changed during watch setup.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    }
    context.signal.addEventListener('abort', dispose, { once: true })
    context.signal.throwIfAborted()
    check() // Close the initial read -> watch setup gap.
    return { dispose }
  } catch (error) { dispose(); throw error }
}
