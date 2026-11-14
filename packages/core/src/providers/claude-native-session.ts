import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { nativeProcessFiles, type NativeProcessFile } from '../agent-native-process.js'
import type { AgentProviderNativeSessionDiscovery, AgentProviderNativeSessionDiscoveryContext, AgentProviderNativeSessionWitness } from '../types.js'
import { discoverClaudeRegisteredSession } from './claude-native-registry.js'

const unavailable = (message: string): AgentMuxError => new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')

/** A declared main transcript actively open for writing in this exact Run process group.
 * SessionStart alone can arrive late or belong to a child; it never proves current identity. */
export type ClaudeNativeRecord = { file: NativeProcessFile; id: string }
export async function locateClaudeNativeSessions(context: Pick<AgentProviderNativeSessionDiscoveryContext, 'processId' | 'signal'>, target?: ClaudeNativeRecord): Promise<ClaudeNativeRecord[]> {
  const files = (await nativeProcessFiles(context.processId, context.signal))
    .filter(file => (file.access === 'w' || file.access === 'u') && file.path.endsWith('.jsonl') &&
      (!target || file.path === target.file.path))
  if (files.length > 16) throw unavailable('Native transcript discovery exceeded its bounded candidate count.')
  const main: Array<{ file: NativeProcessFile; id: string }> = []
  for (const file of files) {
    context.signal.throwIfAborted()
    const input = await open(file.path, 'r')
    try {
      const before = await input.stat({ bigint: true })
      if (!before.isFile() || before.dev !== file.device || before.ino !== file.inode) throw unavailable('The observed native transcript was replaced.')
      const bytes = Buffer.alloc(64 * 1024), { bytesRead } = await input.read(bytes, 0, bytes.length, 0)
      // Incomplete records and unrelated JSONL are not evidence. No directory, cwd, timestamp or missing-agent inference.
      const records = bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, -1)
      for (const line of records) {
        let p: Record<string, unknown>
        try { p = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (!p || typeof p !== 'object' || Array.isArray(p) || !['user', 'assistant'].includes(String(p.type))) continue
        const id = normalizeNativeSessionId(p.sessionId)
        if (id && (!target || id === target.id) && p.isSidechain === false && basename(file.path) === `${id}.jsonl`) { main.push({ file, id }); break }
      }
      const after = await input.stat({ bigint: true })
      if (after.dev !== before.dev || after.ino !== before.ino) throw unavailable('The native transcript identity changed.')
    } finally { await input.close() }
  }
  const unique = new Map(main.map(value => [JSON.stringify([value.id, value.file.path, String(value.file.device), String(value.file.inode)]), value]))
  return [...unique.values()]
}

export async function discoverClaudeNativeSession(context: AgentProviderNativeSessionDiscoveryContext): Promise<AgentProviderNativeSessionDiscovery | null> {
  let registrationFailure: unknown
  try {
    const registered = await discoverClaudeRegisteredSession(context)
    if (registered) return registered
  } catch (error) {
    // A current native identity conflict cannot be hidden by an old log descriptor.
    if (error instanceof AgentMuxError && error.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED') throw error
    registrationFailure = error
  }
  const originals = await locateClaudeNativeSessions(context)
  // A failed auxiliary observation does not revoke independent positive file evidence.
  if (!originals.length && registrationFailure) throw registrationFailure
  const witness = (original: ClaudeNativeRecord): AgentProviderNativeSessionWitness => {
    const assertRecord = async (target?: ClaudeNativeRecord): Promise<void> => {
      const records = await locateClaudeNativeSessions(context, target)
      if (records.length > 1) throw new AgentMuxError('Several writable main native transcripts are open; current conversation is ambiguous.', 'AGENT_NATIVE_IDENTITY_AMBIGUOUS')
      const current = records[0]
      // A descriptor is a replaceable handle; the original owner and file object must remain.
      if (!current || current.id !== original.id || current.file.path !== original.file.path ||
        current.file.processId !== original.file.processId || current.file.processGroup !== original.file.processGroup ||
        current.file.device !== original.file.device || current.file.inode !== original.file.inode) {
        throw unavailable('The original writable main native transcript changed; refresh its exact source.')
      }
    }
    return { handle: { kind: 'provider', providerId: 'claude', sessionId: original.id, transcriptPath: original.file.path },
      assertCurrent: () => assertRecord(), assertPresent: () => assertRecord(original) }
  }
  if (originals.length > 1) return { candidates: originals.map(original => {
    const member = witness(original)
    return { handle: member.handle, assertPresent: member.assertPresent! }
  }) }
  return originals[0] ? witness(originals[0]) : null
}
