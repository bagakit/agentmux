import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadResult } from '@agentmux/core'

export const source = { providerId: 'fixture-provider', nativeSessionId: 'original-native-session' }
export const record = { source, recordId: 'original-record', turnId: 'original-turn' }
export const originalBody = 'BEGIN 原文🙂\n' + '跨 UTF-8 chunk 中文🙂 and original text. '.repeat(12_000) + '\nEND 原文完整'
/** Only the transport is simulated. Actual semantic parts, bytes, hash and shared reader are real. */
export function contentFixture(complete: AgentSessionHistoryContentPart, name = complete.kind) {
  const bytes = new TextEncoder().encode(JSON.stringify(complete)), hash = bytesToHex(sha256(bytes))
  const part: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }> = {
    kind: 'resource', resourceType: 'text', reference: `fixture:${name}`, label: `Complete ${complete.kind}`,
    content: { encoding: 'json-utf8', kind: complete.kind, byteLength: bytes.length, sha256: hash }
  }
  const requests: AgentSessionHistoryResourceRequest[] = []
  let failures = 0
  return { part, complete, requests, failNext: () => { failures++ },
    read: async (input: AgentSessionHistoryResourceRequest): Promise<AgentSessionHistoryResourceReadResult> => {
      requests.push(input)
      if (failures > 0) { failures--; throw new Error('Original source temporarily unavailable. Retry keeps this record.') }
      const offset = input.offsetBytes ?? 0, chunk = bytes.subarray(offset, offset + (input.maxBytes ?? 128 * 1024))
      return { agentSessionId: 'original-core-session', source, recordId: record.recordId, turnId: record.turnId,
        partIndex: input.partIndex, reference: part.reference, result: { status: 'fragment', encoding: 'json-utf8',
          dataBase64: btoa(Array.from(chunk, byte => String.fromCharCode(byte)).join('')), byteLength: chunk.length,
          offsetBytes: offset, totalBytes: bytes.length, sha256: hash, nextOffsetBytes: offset + chunk.length === bytes.length ? null : offset + chunk.length } }
    }
  }
}
