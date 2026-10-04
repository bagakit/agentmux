import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { nativeProcessFiles, nativeProcessBirth } from '../agent-native-process.js'
import type { AgentProviderPromptExecutionContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence } from '../types.js'

const TAIL_BYTES = 512 * 1024
const HEADER_BYTES = 512 * 1024
const sourceIdentity = (sessionId: string, source: { dev: bigint; ino: bigint }): string =>
  createHash('sha256').update(`[${JSON.stringify(sessionId)},${source.dev},${source.ino}]`).digest('base64url')

/** Current local transport is proven by the exact native source's unique writer
 * in this Run's process group. Executable path/version observations are separate:
 * removing a mapped pathname cannot change this current input capability.
 * The caller still requires the supported complete current native pane and turn
 * through inspectPromptExecution/readPromptExecutionEvidence before input.
 */
export function createCodexPromptExecutionTransportVerifier(): (context: AgentProviderPromptExecutionContext) => Promise<boolean> {
  return async (context) => {
    if (context.args.some(arg => arg === '--remote' || arg.startsWith('--remote=')) || context.args.includes('agents')) return false
    if (!context.processId || !Number.isSafeInteger(context.processId) || context.processId <= 0) return false
    const handle = context.nativeHandle
    if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) return false
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000)
    const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source
    try {
      source = await file.stat({ bigint: true })
      if (!source.isFile()) return false
      if (!context.nativeSourceId || sourceIdentity(handle.sessionId, source) !== context.nativeSourceId) return false
      const header = Buffer.alloc(Number(source.size < BigInt(HEADER_BYTES) ? source.size : BigInt(HEADER_BYTES)))
      await file.read(header, 0, header.length, 0)
      const end = header.indexOf(10)
      if (end < 0) return false
      const meta = JSON.parse(header.subarray(0, end).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
      // Resume appends to the creator's rollout. Its version is historical metadata.
      if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return false
    } finally { await file.close() }
    const rootBirth = await nativeProcessBirth(context.processId, signal)
    const matches = (await nativeProcessFiles(context.processId, signal)).filter(file => file.path === handle.transcriptPath &&
      file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
    const owners = [...new Set(matches.map(file => file.processId))]
    if (owners.length !== 1) return false
    const nativePid = owners[0]!
    const nativeBirth = await nativeProcessBirth(nativePid, signal)
    const after = (await nativeProcessFiles(context.processId, signal)).filter(file =>
      file.path === handle.transcriptPath && file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
    const afterOwners = [...new Set(after.map(file => file.processId))]
    return afterOwners.length === 1 && afterOwners[0] === nativePid &&
      after.some(file => matches.some(old => old.processId === file.processId && old.descriptor === file.descriptor)) &&
      await nativeProcessBirth(context.processId, signal) === rootBirth && await nativeProcessBirth(nativePid, signal) === nativeBirth &&
      (await readCodexPromptExecutionEvidence({ ...context, signal }))?.sourceId === context.nativeSourceId
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
    const sourceId = sourceIdentity(handle.sessionId, stat)
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
    for (let index = lines.length - 1; index >= 0; index--) {
      const item = JSON.parse(lines[index]!) as { type?: unknown; ordinal?: unknown; payload?: { type?: unknown; turn_id?: unknown; thread_id?: unknown; reason?: unknown } }
      const event = item.payload
      const boundary = item.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(event?.type))
      // A long turn may have evicted task_started from this bounded suffix. These
      // ordered native records still identify that turn; a later end wins because
      // this traversal is newest first. Child-thread events cannot bind this Run.
      const turnRecord = item.type === 'turn_context' || (item.type === 'event_msg' &&
        event?.type === 'item_completed' && event.thread_id === handle.sessionId)
      if ((!boundary && !turnRecord) || !event) continue
      if (typeof event.turn_id !== 'string' || !event.turn_id || !Number.isSafeInteger(item.ordinal)) return null
      const state = !boundary || event.type === 'task_started' ? 'working' : 'ended'
      return currentEvidence({ sourceId, id: createHash('sha256').update(JSON.stringify([sourceId, item.ordinal, item.type, event.type, event.turn_id])).digest('base64url'),
        nativeTurnId: event.turn_id, state,
        ...(event.type === 'task_complete' ? { endReason: 'completed' as const } :
          event.type === 'turn_aborted' && event.reason === 'interrupted' ? { endReason: 'interrupted' as const } : {}) })
    }
    // A complete, small new transcript with no turn can prove initial idle. A
    // retained suffix cannot make the same assertion.
    return start === 0 ? currentEvidence({ sourceId, id: sourceId, state: 'idle' }) : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  } finally { await file.close() }
}
