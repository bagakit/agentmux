import { createHmac, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import type { AgentProviderSessionHistoryContext } from './types.js'
import { NativeSourceSnapshots, type NativeSnapshotManifest } from './native-source-snapshot.js'
export type NativeSnapshotCursor = { version: 1; kind: 'scope' | 'range'; reference: string; cursor: string; origin: NativeSnapshotManifest['origin']; recovery?: { start: number; index: { ino: number; size: number; mtimeMs: number; ctimeMs: number } } }
export function nativeSnapshotStore(context: AgentProviderSessionHistoryContext): NativeSourceSnapshots {
  if (!context.nativeSnapshotDirectory || !context.nativeSnapshotSecret || !context.agentSessionId || !context.transcriptPath)
    throw new AgentMuxError('The original private native snapshot owner is unavailable. Ordinary reading remains available.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE')
  return new NativeSourceSnapshots({ directory: context.nativeSnapshotDirectory, secret: context.nativeSnapshotSecret,
    agentSessionId: context.agentSessionId, source: context.source, sourcePath: context.transcriptPath })
}
const signature = (context: AgentProviderSessionHistoryContext, body: string) => createHmac('sha256', context.nativeSnapshotSecret!).update('agentmux-native-cut.v1\0').update(JSON.stringify([context.agentSessionId, context.source])).update('\0').update(body).digest('base64url')
export function encodeNativeSnapshotCursor(context: AgentProviderSessionHistoryContext, value: NativeSnapshotCursor): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return 'nsc1.' + body + '.' + signature(context, body)
}
export function decodeNativeSnapshotCursor(context: AgentProviderSessionHistoryContext, cursor: string | undefined): NativeSnapshotCursor | undefined {
  if (!cursor?.startsWith('nsc1.')) return undefined
  const invalid = () => new AgentMuxError('The exact original immutable native cut could not be verified.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  const [, body, mac, extra] = cursor.split('.')
  if (extra || !body || !mac || mac.length !== 43 || !context.nativeSnapshotSecret) throw invalid()
  const actual = Buffer.from(mac), expected = Buffer.from(signature(context, body))
  if (!timingSafeEqual(actual, expected)) throw invalid()
  try {
    const result = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as NativeSnapshotCursor
    if (result.version !== 1 || !['scope', 'range'].includes(result.kind) || typeof result.reference !== 'string' || typeof result.cursor !== 'string' || !result.origin) throw invalid()
    return result
  } catch { throw invalid() }
}
export function liveNativeCut(cursor: string, origin: NativeSnapshotManifest['origin']): string {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
  return Buffer.from(JSON.stringify({ ...value, dev: Number(origin.dev), ino: Number(origin.ino), birth: Number(BigInt(origin.birth) / 1_000_000_000n) * 1000 + Number(BigInt(origin.birth) % 1_000_000_000n) / 1e6 })).toString('base64url')
}
