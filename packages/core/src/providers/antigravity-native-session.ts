import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth, nativeProcessFiles, type NativeProcessFile } from '../agent-native-process.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { assertAntigravityHistorySource } from './antigravity-native-history.js'
import type { AgentProviderNativeSessionDiscovery, AgentProviderNativeSessionDiscoveryContext,
  AgentProviderSessionHistoryObservationContext, AgentSessionHistoryObservationHandle } from '../types.js'

function unavailable(message: string): AgentMuxError {
  return new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
}

type Presence = { file: NativeProcessFile; id: string; birth: string; transcriptPath: string }

/** agy's first-party presence.Acquire holds presence/<conversation UUID>.lock on its main CLI process.
 * Transcript writers are short-lived: absence of a transcript FD is not absence of the conversation.
 * The Run's exact entrance PID is the only confirmed main owner. Group children cannot substitute it. */
async function locate(context: AgentProviderNativeSessionDiscoveryContext): Promise<Presence | null> {
  const birth = await nativeProcessBirth(context.processId, context.signal)
  const candidates: Array<{ file: NativeProcessFile; id: string }> = []
  for (const file of await nativeProcessFiles(context.processId, context.signal)) {
    if (file.processId !== context.processId || file.access !== 'u' || basename(dirname(file.path)) !== 'presence') continue
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/iu.exec(basename(file.path))
    if (match) candidates.push({ file, id: match[1]! })
  }
  // A process may report the same native file through several descriptors.
  const unique = new Map(candidates.map(value => [JSON.stringify([value.id, value.file.path, String(value.file.device), String(value.file.inode)]), value]))
  if (unique.size > 1) throw unavailable('Several main native conversations are open; refresh after the native target is unambiguous. The Run is kept.')
  const original = unique.values().next().value
  if (!original) return null
  context.signal.throwIfAborted()
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(original.file.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    context.signal.throwIfAborted()
    throw unavailable('The exact native presence record could not be opened. Refresh can retry; the Run is kept.')
  }
  try {
    const current = await file.stat({ bigint: true })
    if (!current.isFile() || current.dev !== original.file.device || current.ino !== original.file.inode) {
      throw unavailable('The exact native presence record was replaced during discovery. Refresh can retry; the Run is kept.')
    }
  } finally { await file.close() }
  if (await nativeProcessBirth(context.processId, context.signal) !== birth) {
    throw unavailable('The native process changed during discovery. Refresh can retry; the Run is kept.')
  }
  context.signal.throwIfAborted()
  return { ...original, birth, transcriptPath: join(dirname(dirname(original.file.path)), 'brain', original.id, '.system_generated', 'logs', 'transcript.jsonl') }
}

export async function discoverAntigravityNativeSession(context: AgentProviderNativeSessionDiscoveryContext): Promise<AgentProviderNativeSessionDiscovery | null> {
  const original = await locate(context)
  if (!original) return null
  return { handle: { kind: 'provider', providerId: 'antigravity', sessionId: original.id, transcriptPath: original.transcriptPath },
    async assertCurrent() {
      const current = await locate(context)
      if (!current || current.birth !== original.birth || current.id !== original.id || current.transcriptPath !== original.transcriptPath ||
        current.file.processId !== original.file.processId || current.file.processGroup !== original.file.processGroup ||
        current.file.descriptor !== original.file.descriptor || current.file.device !== original.file.device || current.file.inode !== original.file.inode) {
        throw unavailable('The original native process presence changed. Refresh its exact source; the Run is kept.')
      }
    } }
}

/** Both exact native files contribute to one history page. There is no directory search or polling. */
export async function observeAntigravitySessionHistory(context: AgentProviderSessionHistoryObservationContext): Promise<AgentSessionHistoryObservationHandle> {
  context.signal.throwIfAborted()
  assertAntigravityHistorySource(context)
  if (!context.transcriptPath) throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
  const handles: AgentSessionHistoryObservationHandle[] = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const handle of handles) handle.dispose()
    context.signal.removeEventListener('abort', dispose)
  }
  const onChange: AgentProviderSessionHistoryObservationContext['onChange'] = (event) => {
    if (disposed) return
    if (event.kind === 'unavailable') dispose()
    context.onChange(event)
  }
  context.signal.addEventListener('abort', dispose, { once: true })
  try {
    for (const path of [context.transcriptPath, join(dirname(context.transcriptPath), 'transcript_full.jsonl')]) {
      const handle = await observeNativeJsonlHistory({ ...context, transcriptPath: path, onChange })
      if (disposed) handle.dispose()
      else handles.push(handle)
      context.signal.throwIfAborted()
      if (disposed) throw new AgentMuxError('Native history observation became unavailable during acquisition. Existing records are kept; refresh can retry.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE')
    }
    return { source: context.source, dispose }
  } catch (error) { dispose(); throw error }
}
