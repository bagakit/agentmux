import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { nativeProcessFiles, type NativeProcessFile } from '../agent-native-process.js'
import type { AgentProviderNativeSessionDiscovery, AgentProviderNativeSessionDiscoveryContext } from '../types.js'

const unavailable = (message: string): AgentMuxError => new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')

/** A declared main transcript actively open for writing in this exact Run process group.
 * SessionStart alone can arrive late or belong to a child; it never proves current identity. */
async function locate(context: AgentProviderNativeSessionDiscoveryContext): Promise<{ file: NativeProcessFile; id: string } | null> {
  const files = (await nativeProcessFiles(context.processId, context.signal))
    .filter(file => (file.access === 'w' || file.access === 'u') && file.path.endsWith('.jsonl'))
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
        if (id && p.isSidechain === false && basename(file.path) === `${id}.jsonl`) { main.push({ file, id }); break }
      }
      const after = await input.stat({ bigint: true })
      if (after.dev !== before.dev || after.ino !== before.ino) throw unavailable('The native transcript identity changed.')
    } finally { await input.close() }
  }
  const unique = new Map(main.map(value => [JSON.stringify([value.id, value.file.path, String(value.file.device), String(value.file.inode)]), value]))
  if (unique.size > 1) throw new AgentMuxError('Several writable main native transcripts are open; current conversation is ambiguous.', 'AGENT_NATIVE_IDENTITY_AMBIGUOUS')
  return unique.values().next().value ?? null
}

export async function discoverClaudeNativeSession(context: AgentProviderNativeSessionDiscoveryContext): Promise<AgentProviderNativeSessionDiscovery | null> {
  const original = await locate(context)
  if (!original) return null
  return { handle: { kind: 'provider', providerId: 'claude', sessionId: original.id, transcriptPath: original.file.path },
    async assertCurrent() {
      const current = await locate(context)
      if (!current || current.id !== original.id || current.file.path !== original.file.path ||
        current.file.processId !== original.file.processId || current.file.processGroup !== original.file.processGroup ||
        current.file.descriptor !== original.file.descriptor || current.file.device !== original.file.device || current.file.inode !== original.file.inode) {
        throw unavailable('The original writable main native transcript changed; refresh its exact source.')
      }
    } }
}
