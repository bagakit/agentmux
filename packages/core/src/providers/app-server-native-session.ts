import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { nativeProcessFiles, type NativeProcessFile } from '../agent-native-process.js'
import type { AgentProviderId, AgentProviderNativeSessionWitness, AgentProviderNativeSessionDiscovery, AgentProviderNativeSessionDiscoveryContext } from '../types.js'

function unavailable(message: string): AgentMuxError {
  return new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
}

type MainRecordRole = (payload: Readonly<Record<string, unknown>>) => boolean
type NativeRecord = { file: NativeProcessFile; id: string; childSessionIds: string[] }
type NativeTarget = { id: string; path?: string }

async function locate(context: Pick<AgentProviderNativeSessionDiscoveryContext, 'processId' | 'signal'>, mainRole: MainRecordRole | undefined,
  scope: 'run-group' | 'process', target?: NativeTarget): Promise<NativeRecord[]> {
  const records = (await nativeProcessFiles(context.processId, context.signal, scope))
    .filter(file => /^rollout-.*\.jsonl$/u.test(basename(file.path)) && (!mainRole || file.access === 'w' || file.access === 'u') &&
      (target?.path === undefined || file.path === target.path))
  // The candidate budget counts record objects, not aliases of one writer FD.
  const files = [...new Map(records.map(file => [JSON.stringify([file.processId, file.path, String(file.device), String(file.inode)]), file])).values()]
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
      if (target && id !== target.id) continue
      if (mainRole ? mainRole(payload!) : payload!.source === 'cli') main.push({ file, id })
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
      const header = Buffer.alloc(newline + 1)
      if ((await input.read(header, 0, header.length, 0)).bytesRead !== header.length || !header.equals(bytes.subarray(0, header.length))) {
        throw unavailable('Native session role metadata changed during observation.')
      }
    } finally { await input.close() }
  }
  // One process can hold the same main record under several descriptors.
  const unique = new Map(main.map(value => [JSON.stringify([value.id, value.file.path, String(value.file.device), String(value.file.inode)]), value]))
  return [...unique.values()].map(original => {
    const family = new Set([original.id])
    for (let step = 0; step < children.length; step++) for (const child of children) {
      if (family.has(child.parent)) family.add(child.id)
    }
    return { ...original, childSessionIds: [...family].filter(id => id !== original.id).sort() }
  })
}

/** An exact target is membership, never a claim about the frontend selection.
 * Process scope is only for an already OS-bound peer. */
export async function locateAppServerNativeSession(context: Pick<AgentProviderNativeSessionDiscoveryContext, 'processId' | 'signal'>, mainRole?: MainRecordRole,
  scope: 'run-group' | 'process' = 'run-group', target?: NativeTarget): Promise<NativeRecord | null> {
  const records = await locate(context, mainRole, scope, target)
  if (records.length > 1) throw new AgentMuxError('Several main native records match; the exact target is ambiguous.', 'AGENT_NATIVE_IDENTITY_AMBIGUOUS')
  return records[0] ?? null
}

export async function discoverAppServerNativeSession(context: AgentProviderNativeSessionDiscoveryContext, providerId: AgentProviderId, mainRole?: MainRecordRole): Promise<AgentProviderNativeSessionDiscovery | null> {
  const originals = await locate(context, mainRole, 'run-group')
  const witness = (original: NativeRecord): AgentProviderNativeSessionWitness => {
    const assertRecord = async (target?: NativeTarget): Promise<void> => {
      // A descriptor is a replaceable handle; the original owner and file object must remain.
      const current = await locateAppServerNativeSession(context, mainRole, 'run-group', target)
      if (!current || current.id !== original.id || current.file.path !== original.file.path ||
        current.file.processId !== original.file.processId || current.file.processGroup !== original.file.processGroup ||
        current.file.device !== original.file.device || current.file.inode !== original.file.inode) {
        throw unavailable('The original native process record changed; refresh its exact source.')
      }
    }
    return { childSessionIds: original.childSessionIds,
      handle: { kind: 'provider', providerId, sessionId: original.id, transcriptPath: original.file.path },
      assertPresent: () => assertRecord({ id: original.id, path: original.file.path }),
      assertCurrent: () => assertRecord() }
  }
  if (originals.length > 1) return { candidates: originals.map(original => {
    const member = witness(original)
    return { handle: member.handle, childSessionIds: original.childSessionIds, assertPresent: member.assertPresent! }
  }) }
  return originals[0] ? witness(originals[0]) : null
}
