import { CONNECTION_API_LIMITS, type ConnectionApiJson, type ConnectionApiResponseBody } from '@agentmux/core/connections'

/** Consume only the admitted response body. No opaque bytes become a receipt. */
export async function readConnectionApiResponse(input: {
  body: AsyncIterable<Uint8Array> | null
  contentType: string | null
  contentLength?: string | null
  cancel(): void | Promise<void>
}): Promise<ConnectionApiResponseBody> {
  let complete = input.body === null
  try {
    if (!input.body) return { format: 'empty' }
    if (Number(input.contentLength) > CONNECTION_API_LIMITS.responseBytes) return { format: 'unavailable', reason: 'too-large' }
    const jsonType = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/iu.test(input.contentType ?? '')
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of input.body) {
      size += chunk.byteLength
      if (size > CONNECTION_API_LIMITS.responseBytes) return { format: 'unavailable', reason: 'too-large' }
      if (chunk.byteLength && !jsonType) return { format: 'unavailable', reason: 'unsupported-format' }
      chunks.push(chunk)
    }
    complete = true
    if (!size) return { format: 'empty' }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    const valid = (item: unknown, depth: number): boolean => {
      if (depth > CONNECTION_API_LIMITS.jsonDepth) return false
      if (item === null || typeof item === 'boolean' || typeof item === 'string') return true
      if (typeof item === 'number') return Number.isFinite(item)
      if (Array.isArray(item)) return item.every(child => valid(child, depth + 1))
      return !!item && typeof item === 'object' && Object.entries(item).every(([key, child]) =>
        !['__proto__', 'constructor', 'prototype'].includes(key) && valid(child, depth + 1))
    }
    return valid(value, 0) ? { format: 'json', value: value as ConnectionApiJson } : { format: 'unavailable', reason: 'unreadable' }
  } catch { return { format: 'unavailable', reason: 'unreadable' } }
  finally { if (!complete) try { await input.cancel() } catch { /* Only the original response read is unavailable. */ } }
}
