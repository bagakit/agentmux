import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth, nativeProcessFiles, type NativeProcessFile } from '../agent-native-process.js'
import { readNativeHistoryBytes } from '../native-jsonl-history-reader.js'
import { SESSION_HISTORY_TIMEOUT_MS } from '../session-history.js'
import type { AgentProviderPromptExecutionContext } from '../agent-provider.js'
import { verifyGrokSummaryIdentity } from './grok-native-history.js'

const unavailable = () => new AgentMuxError('The original writable Grok source is unconfirmed. Retained work and manual input remain available.', 'AGENT_NATIVE_STATUS_UNAVAILABLE')
const writable = (file: NativeProcessFile) => file.access === 'w' || file.access === 'u'

/** Only the original local Run can supply a missing locator. This never fills launch environment. */
export async function grokProcessSource(context: AgentProviderPromptExecutionContext, parent: AbortSignal): Promise<{ path: string; assertCurrent(): Promise<void> }> {
  const processId = context.processId, handle = context.nativeHandle
  if (!processId || handle?.kind !== 'provider' || handle.providerId !== 'grok') throw unavailable()
  const signal = () => AbortSignal.any([parent, AbortSignal.timeout(SESSION_HISTORY_TIMEOUT_MS)])
  const opening = signal(), birth = await nativeProcessBirth(processId, opening)
  const files = (await nativeProcessFiles(processId, opening)).filter(file => writable(file) && basename(file.path) === 'events.jsonl')
  if (!files.length || files.length > 16) throw unavailable()
  const primaries: NativeProcessFile[] = []
  const inspect = async (file: NativeProcessFile, active: AbortSignal): Promise<void> => {
    const input = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await input.stat({ bigint: true })
      if (!before.isFile() || before.dev !== file.device || before.ino !== file.inode) throw unavailable()
      const budget = { bytesRead: 0, startedAt: Date.now() }
      const bytes = await readNativeHistoryBytes(input, 0, Number(before.size < 65536n ? before.size : 65536n), active, budget)
      const end = bytes.indexOf(10)
      if (end < 0) throw unavailable()
      let row: Record<string, unknown>
      try { row = JSON.parse(bytes.subarray(0, end).toString('utf8')) as Record<string, unknown> } catch { throw unavailable() }
      if (!row || row.type !== 'turn_started' || row.session_relationship !== 'primary' || row.schema_version !== '1.0' ||
          row.session_id !== handle.sessionId || basename(dirname(file.path)) !== handle.sessionId) throw unavailable()
      await verifyGrokSummaryIdentity(dirname(file.path), { source: { providerId: 'grok', nativeSessionId: handle.sessionId },
        workspacePath: context.workspacePath, env: {}, signal: active }, budget, true)
      const currentHeader = await readNativeHistoryBytes(input, 0, end + 1, active, budget)
      if (!currentHeader.equals(bytes.subarray(0, end + 1))) throw unavailable()
      const after = await input.stat({ bigint: true }), current = await lstat(file.path, { bigint: true })
      if (!current.isFile() || after.dev !== before.dev || after.ino !== before.ino || current.dev !== before.dev || current.ino !== before.ino) throw unavailable()
    } finally { await input.close() }
  }
  // A second primary, including a different native conversation, is ambiguity rather than a fallback.
  for (const file of files) { await inspect(file, opening); primaries.push(file) }
  if (primaries.length !== 1) throw unavailable()
  const original = primaries[0]!, writerBirth = await nativeProcessBirth(original.processId, opening)
  const assertCurrent = async (active = signal()) => {
    if (await nativeProcessBirth(processId, active) !== birth || await nativeProcessBirth(original.processId, active) !== writerBirth) throw unavailable()
    const current = (await nativeProcessFiles(processId, active)).filter(file => writable(file) && basename(file.path) === 'events.jsonl')
    if (current.length !== 1 || !current.some(file => file.processId === original.processId && file.processGroup === original.processGroup &&
        file.descriptor === original.descriptor && file.path === original.path && file.device === original.device && file.inode === original.inode)) throw unavailable()
    await inspect(original, active)
    if (await nativeProcessBirth(processId, active) !== birth || await nativeProcessBirth(original.processId, active) !== writerBirth) throw unavailable()
  }
  await assertCurrent(opening)
  return { path: join(dirname(original.path), 'updates.jsonl'), assertCurrent }
}
