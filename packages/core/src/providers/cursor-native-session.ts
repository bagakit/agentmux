import { basename, dirname } from 'node:path'
import { realpath } from 'node:fs/promises'
import { AgentMuxError } from '../errors.js'
import { nativeProcessFiles, nativeProcessBirth, type NativeProcessFile } from '../agent-native-process.js'
import { NativeSqliteHistoryReader } from '../native-sqlite-history-reader.js'
import { readCursorStoreMetadata, resolveCursorStorePath } from './cursor-native-history.js'
import type { AgentProviderNativeSessionDiscovery, AgentProviderNativeSessionDiscoveryContext } from '../types.js'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function unavailable(message: string): never {
  throw new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
}
type Candidate = { file: NativeProcessFile; id: string; path: string }
async function locate(context: AgentProviderNativeSessionDiscoveryContext): Promise<{ main: Candidate; children: string[] } | null> {
  const files = await nativeProcessFiles(context.processId, context.signal)
  const exact = new Map<string, Candidate>()
  for (const file of files) {
    if (basename(file.path) !== 'store.db' || !['w', 'u'].includes(file.access ?? '')) continue
    const id = basename(dirname(file.path))
    if (!uuid.test(id)) continue
    const path = resolveCursorStorePath(context.workspacePath, id, context.env)
    let physical: string
    try { physical = await realpath(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (physical !== file.path) continue
    exact.set(JSON.stringify([file.path, String(file.device), String(file.inode)]), { file, id, path })
  }
  const main: Candidate[] = [], children: Array<{ id: string; parent: string; root: string }> = []
  for (const candidate of exact.values()) {
    context.signal.throwIfAborted()
    const reader = await NativeSqliteHistoryReader.open(candidate.path, context.signal)
    try {
      if (reader.identity.dev !== String(candidate.file.device) || reader.identity.ino !== String(candidate.file.inode)) {
        unavailable('The open Cursor native source was replaced before its identity could be confirmed.')
      }
      const metadata = await readCursorStoreMetadata(reader, candidate.id)
      if (metadata.subagentInfo === undefined) main.push(candidate)
      else {
        const child = metadata.subagentInfo
        if (!child || typeof child !== 'object' || Array.isArray(child)) unavailable('Cursor native Session provenance is unknown.')
        const info = child as Record<string, unknown>
        if (typeof info.parentAgentId !== 'string' || !uuid.test(info.parentAgentId) ||
          typeof info.rootParentAgentId !== 'string' || !uuid.test(info.rootParentAgentId) ||
          typeof info.toolCallId !== 'string' || !info.toolCallId || typeof info.typeName !== 'string' || !info.typeName) {
          unavailable('Cursor native child provenance is incomplete; no main identity was inferred.')
        }
        children.push({ id: candidate.id, parent: info.parentAgentId, root: info.rootParentAgentId })
      }
    } finally { await reader.close() }
  }
  if (main.length > 1) unavailable('Several main Cursor native Sessions are open; the current target is ambiguous.')
  const original = main[0]
  if (!original) return null
  const family = new Set([original.id])
  for (let count = 0; count < children.length; count++) for (const child of children) {
    if (child.root === original.id && family.has(child.parent)) family.add(child.id)
  }
  return { main: original, children: [...family].filter(id => id !== original.id).sort() }
}

/** A current writable native DB plus native metadata is a read-only witness, never a Run operation. */
export async function discoverCursorNativeSession(context: AgentProviderNativeSessionDiscoveryContext): Promise<AgentProviderNativeSessionDiscovery | null> {
  const birth = await nativeProcessBirth(context.processId, context.signal), original = await locate(context)
  if (!original) return null
  const currentBirth = await nativeProcessBirth(context.processId, context.signal)
  if (birth !== currentBirth) unavailable('The original Cursor process birth changed during discovery.')
  return { handle: { kind: 'provider', providerId: 'cursor', sessionId: original.main.id, transcriptPath: original.main.path },
    childSessionIds: original.children,
    async assertCurrent() {
      if (await nativeProcessBirth(context.processId, context.signal) !== birth) unavailable('The original Cursor process changed; refresh its exact source.')
      const current = await locate(context), a = original.main.file, b = current?.main.file
      if (!current || current.main.id !== original.main.id || !b || a.path !== b.path ||
        a.processId !== b.processId || a.processGroup !== b.processGroup || a.device !== b.device || a.inode !== b.inode) {
        unavailable('The original Cursor writable native source changed; refresh its exact source.')
      }
    } }
}
