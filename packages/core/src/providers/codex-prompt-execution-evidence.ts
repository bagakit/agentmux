import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AgentProviderPromptExecutionContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence } from '../types.js'

const TAIL_BYTES = 512 * 1024
const HEADER_BYTES = 512 * 1024

/** A default TUI only auto-connects an already-listening control socket at startup.
 * Explicit embedded launch, or the absence of that socket in this native Session's
 * own home, excludes out-of-band pending additions. Never connect/create a daemon.
 */
export async function verifyCodexPromptExecutionTransport(context: AgentProviderPromptExecutionContext): Promise<boolean> {
  if (context.args.some(arg => arg === '--remote' || arg.startsWith('--remote=')) || context.args.includes('agents')) return false
  if (context.args.includes('--no-daemon')) return true
  const path = context.nativeHandle?.kind === 'provider' ? context.nativeHandle.transcriptPath : undefined
  const home = path && /^(.*)\/(?:sessions|archived_sessions)\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/u.exec(path)?.[1]
  if (!home || !isAbsolute(home)) return false
  try {
    await lstat(join(home, 'app-server-control', 'app-server-control.sock'))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
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
    const stat = await file.stat()
    if (!stat.isFile()) return null
    const header = Buffer.alloc(Math.min(stat.size, HEADER_BYTES))
    await file.read(header, 0, header.length, 0)
    const headerEnd = header.indexOf(10)
    if (headerEnd < 0) return null
    const meta = JSON.parse(header.subarray(0, headerEnd).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
    if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return null
    const sourceId = createHash('sha256').update(JSON.stringify([handle.sessionId, stat.dev, stat.ino])).digest('base64url')
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const tail = Buffer.alloc(stat.size - start)
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
      return { sourceId, id: createHash('sha256').update(JSON.stringify([sourceId, item.ordinal, item.type, event.type, event.turn_id])).digest('base64url'),
        nativeTurnId: event.turn_id, state,
        ...(event.type === 'task_complete' ? { endReason: 'completed' as const } :
          event.type === 'turn_aborted' && event.reason === 'interrupted' ? { endReason: 'interrupted' as const } : {}) }
    }
    // A complete, small new transcript with no turn can prove initial idle. A
    // retained suffix cannot make the same assertion.
    return start === 0 ? { sourceId, id: sourceId, state: 'idle' } : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  } finally { await file.close() }
}
