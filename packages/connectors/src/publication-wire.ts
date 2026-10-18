import { AgentMuxError } from '@agentmux/core'
import type { PublicationOperation, PublicationPayload } from './publication-store.js'

/** Stored speech operations retain their original encoding, including legacy question payloads. */
export function publicationSpeechText(payload: Extract<PublicationPayload, { kind: 'speech' }>): string {
  return [payload.text, ...(payload.questions ?? []).map(question => [question.prompt, ...question.options.map(option => `- ${option.label}`)].join('\n'))].filter(Boolean).join('\n\n')
}

/** No authentication material belongs here. The adapter resolves current Host credentials at effect time. */
export type PreparedPublication = {
  adapterId: string
  renderVersion: string
  requestKey: string
  request: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    query?: Record<string, string>
    body?: string
    contentType?: 'application/json' | 'text/plain; charset=utf-8'
    multipart?: { payloadJson: string; files: PreparedPublicationResource[] }
  }
}
/** Private bytes remain in the original Outbox operation, never in a mutable cache or URL. */
export type PreparedPublicationResource = { resourceId: string; sha256: string; byteLength: number; name: string; contentType: string }
export type PublicationEffectContext = { readResource(resource: Readonly<PreparedPublicationResource>): Uint8Array }
/** Preparation is synchronous and pure; all network effects occur after the original transaction commits. */
export interface PublicationPreparer {
  adapterId: string
  renderVersion: string
  supportedRenderVersions: readonly string[]
  readonly directResources?: true
  prepare(operation: Readonly<PublicationOperation>): PreparedPublication
}
export function parsePreparedPublication(value: unknown, adapter: PublicationPreparer): PreparedPublication {
  const invalid = (): never => { throw new AgentMuxError('The adapter could not prepare a bounded original request. No platform effect was dispatched.', 'PUBLICATION_PREPARATION_UNCONFIRMED') }
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) === Object.prototype
  const text = (item: unknown, limit = 16_384): item is string => typeof item === 'string' && item.length > 0 && item.length <= limit && !/[\u0000-\u001f\u007f]/u.test(item)
  if (!record(value) || Object.keys(value).some(key => !['adapterId', 'renderVersion', 'requestKey', 'request'].includes(key)) ||
      !text(value.adapterId) || !text(value.renderVersion) || !text(value.requestKey) || !record(value.request)) return invalid()
  if (value.adapterId !== adapter.adapterId || !adapter.supportedRenderVersions.includes(value.renderVersion))
    throw new AgentMuxError('The original prepared request needs its compatible adapter version. Its identity and payload are retained.', 'PUBLICATION_ADAPTER_UNAVAILABLE')
  const request = value.request
  if (Object.keys(request).some(key => !['method', 'path', 'query', 'body', 'contentType', 'multipart'].includes(key)) ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(request.method)) || !text(request.path) || !request.path.startsWith('/') || request.path.startsWith('//') ||
      request.body !== undefined && (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 4 * 1024 * 1024) ||
      request.contentType !== undefined && !['application/json', 'text/plain; charset=utf-8'].includes(String(request.contentType)) ||
      request.query !== undefined && (!record(request.query) || Object.keys(request.query).length > 100 || Object.entries(request.query).some(([key, item]) => !text(key) || !text(item)))) return invalid()
  if (request.multipart !== undefined) {
    const multipart = request.multipart
    if (!adapter.directResources || request.body !== undefined || request.contentType !== undefined || !record(multipart) ||
        Object.keys(multipart).some(key => !['payloadJson', 'files'].includes(key)) || typeof multipart.payloadJson !== 'string' || Buffer.byteLength(multipart.payloadJson) > 4 * 1024 * 1024 ||
        !Array.isArray(multipart.files) || !multipart.files.length || multipart.files.some(file => !record(file) ||
          Object.keys(file).some(key => !['resourceId', 'sha256', 'byteLength', 'name', 'contentType'].includes(key)) || !text(file.resourceId) ||
          typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.byteLength) || Number(file.byteLength) < 1 ||
          !text(file.name, 255) || !text(file.contentType, 255))) return invalid()
  }
  // Detach adapter-owned objects before the caller saves or dispatches them.
  return JSON.parse(JSON.stringify(value)) as PreparedPublication
}
