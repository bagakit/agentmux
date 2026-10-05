import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadResult } from './types.js'

export type SessionHistoryResourceReader = (input: AgentSessionHistoryResourceRequest) => Promise<AgentSessionHistoryResourceReadResult>
export type SessionHistoryResourceRecord = Pick<AgentSessionHistoryResourceRequest, 'source' | 'recordId' | 'turnId'>

/** Explicit complete-content read. No Runtime operations, cache or guessed file locations. */
export async function readSessionHistoryTextResource(
  part: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }>, partIndex: number,
  record: SessionHistoryResourceRecord, read: SessionHistoryResourceReader, signal?: AbortSignal
): Promise<AgentSessionHistoryContentPart> {
  const metadata = part.content
  if (part.resourceType !== 'text' || !metadata || metadata.encoding !== 'json-utf8') throw new Error('This resource does not contain recorded text.')
  const hash = sha256.create(), decoder = new TextDecoder('utf-8', { fatal: true }), chunks: string[] = []
  let offsetBytes = 0, agentSessionId: string | undefined, expectedReference = part.reference
  do {
    signal?.throwIfAborted()
    const receipt = await read({ ...record, partIndex, expectedReference, offsetBytes, maxBytes: 128 * 1024 })
    signal?.throwIfAborted()
    if (receipt.source.providerId !== record.source.providerId || receipt.source.nativeSessionId !== record.source.nativeSessionId ||
      receipt.recordId !== record.recordId || receipt.turnId !== record.turnId || receipt.partIndex !== partIndex ||
      receipt.reference !== expectedReference || (agentSessionId !== undefined && receipt.agentSessionId !== agentSessionId))
      throw new Error('Content response belongs to another recorded resource.')
    agentSessionId = receipt.agentSessionId
    const fragment = receipt.result
    if (fragment.status !== 'fragment') throw new Error(fragment.status === 'unavailable' ? fragment.message : 'Recorded text returned image bytes.')
    if (fragment.encoding !== metadata.encoding || fragment.offsetBytes !== offsetBytes || fragment.totalBytes !== metadata.byteLength ||
      fragment.sha256 !== metadata.sha256 || fragment.byteLength < 1 || fragment.byteLength > 128 * 1024 ||
      !Number.isSafeInteger(fragment.byteLength) || offsetBytes + fragment.byteLength > metadata.byteLength ||
      fragment.nextOffsetBytes !== (offsetBytes + fragment.byteLength === metadata.byteLength ? null : offsetBytes + fragment.byteLength))
      throw new Error('Recorded content fragment is incomplete or changed.')
    const binary = atob(fragment.dataBase64), bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    if (bytes.length !== fragment.byteLength || btoa(binary) !== fragment.dataBase64) throw new Error('Recorded content fragment bytes are invalid.')
    if (fragment.continuationReference !== undefined) {
      if (typeof fragment.continuationReference !== 'string' || !fragment.continuationReference || /[\0\r\n]/u.test(fragment.continuationReference))
        throw new Error('Recorded content authority is invalid.')
      expectedReference = fragment.continuationReference
    }
    hash.update(bytes); chunks.push(decoder.decode(bytes, { stream: true })); offsetBytes += bytes.length
  } while (offsetBytes < metadata.byteLength)
  chunks.push(decoder.decode())
  if (bytesToHex(hash.digest()) !== metadata.sha256) throw new Error('Recorded content changed; reread its original history page.')
  const value: unknown = JSON.parse(chunks.join(''))
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== metadata.kind) throw new Error('Recorded content lost its original semantic kind.')
  const candidate = value as AgentSessionHistoryContentPart
  if (candidate.kind === 'text' || candidate.kind === 'reasoning' ? typeof candidate.text !== 'string' :
    candidate.kind === 'tool-call' ? typeof candidate.name !== 'string' || typeof candidate.input !== 'string' :
    candidate.kind === 'tool-result' ? typeof candidate.output !== 'string' : candidate.kind !== 'resource' || typeof candidate.reference !== 'string')
    throw new Error('Recorded content has an invalid semantic body.')
  return candidate
}
