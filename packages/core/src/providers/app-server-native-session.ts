import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { nativeProcessFiles, type NativeProcessFile } from '../agent-native-process.js'
import type { AgentProviderId, AgentProviderNativeSessionDiscovery, AgentProviderNativeSessionDiscoveryContext } from '../types.js'

function unavailable(message: string): AgentMuxError {
  return new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
}

async function locate(context: AgentProviderNativeSessionDiscoveryContext): Promise<{ file: NativeProcessFile; id: string; childSessionIds: string[] } | null> {
  const files = (await nativeProcessFiles(context.processId, context.signal))
    .filter(file => /^rollout-.*\.jsonl$/u.test(basename(file.path)))
  if (files.length > 16) throw unavailable('Native record discovery exceeded its bounded candidate count.')
  const main: Array<{ file: NativeProcessFile; id: string }> = []
  const children: Array<{ id: string; parent: string }> = []
  for (const file of files) {
    context.signal.throwIfAborted()
    const input = await open(file.path, 'r')
    try {
      const before = await input.stat({ bigint: true })
      if (!before.isFile() || before.dev !== file.device || before.ino !== file.inode) {
        throw unavailable('The observed native record was replaced before identity could be confirmed.')
      }
      const bytes = Buffer.alloc(64 * 1024 + 1)
      const { bytesRead } = await input.read(bytes, 0, bytes.length, 0)
      const newline = bytes.indexOf(10, 0)
      if (newline < 0 || newline > 64 * 1024 || newline >= bytesRead) {
        throw unavailable('Native session metadata is incomplete or exceeds its first-record budget.')
      }
      const first: unknown = JSON.parse(bytes.subarray(0, newline).toString('utf8'))
      if (!first || typeof first !== 'object' || Array.isArray(first)) throw unavailable('Native session metadata is invalid.')
      const record = first as Record<string, unknown>
      const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
        ? record.payload as Record<string, unknown> : undefined
      const id = normalizeNativeSessionId(payload?.id)
      if (record.type !== 'session_meta' || !id) throw unavailable('Native session metadata has no exact identity.')
      if (payload!.source === 'cli') main.push({ file, id })
      else {
        const source = payload!.source && typeof payload!.source === 'object' ? payload!.source as Record<string, unknown> : undefined
        const subagent = source?.subagent && typeof source.subagent === 'object' ? source.subagent as Record<string, unknown> : undefined
        const spawn = subagent?.thread_spawn && typeof subagent.thread_spawn === 'object' ? subagent.thread_spawn as Record<string, unknown> : undefined
        const parent = normalizeNativeSessionId(spawn?.parent_thread_id)
        if (!parent) {
          throw unavailable('Native session provenance is unknown; no main session was inferred.')
        }
        children.push({ id, parent })
      }
      const after = await input.stat({ bigint: true })
      if (after.dev !== before.dev || after.ino !== before.ino) throw unavailable('Native session record identity changed.')
    } finally { await input.close() }
  }
  // One process can hold the same main record under several descriptors.
  const unique = new Map(main.map(value => [JSON.stringify([value.id, value.file.path, String(value.file.device), String(value.file.inode)]), value]))
  if (unique.size > 1) throw unavailable('Several main native sessions are open; the target is ambiguous.')
  const original = unique.values().next().value
  if (!original) return null
  const family = new Set([original.id])
  for (let step = 0; step < children.length; step++) for (const child of children) {
    if (family.has(child.parent)) family.add(child.id)
  }
  return { ...original, childSessionIds: [...family].filter(id => id !== original.id).sort() }
}

export async function discoverAppServerNativeSession(context: AgentProviderNativeSessionDiscoveryContext, providerId: AgentProviderId): Promise<AgentProviderNativeSessionDiscovery | null> {
  const original = await locate(context)
  if (!original) return null
  return {
    childSessionIds: original.childSessionIds,
    handle: { kind: 'provider', providerId, sessionId: original.id, transcriptPath: original.file.path },
    async assertCurrent() {
      const current = await locate(context)
      if (!current || current.id !== original.id || current.file.path !== original.file.path ||
        current.file.processId !== original.file.processId || current.file.processGroup !== original.file.processGroup ||
        current.file.descriptor !== original.file.descriptor || current.file.device !== original.file.device || current.file.inode !== original.file.inode) {
        throw unavailable('The original native process record changed; refresh its exact source.')
      }
    }
  }
}
