import type { Readable } from 'node:stream'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionApiRequest, type ConnectionApiDescription, type ConnectionApiRequest, type ConnectionConfig } from '@agentmux/core/connections'
import type { ConnectionApiAdapter } from '../../connection-api-adapter.js'
import { readConnectionApiResponse } from '../../connection-api-response.js'

export type FeishuApiScope = { url: string; data: string | FormData | undefined; protect(value: string): void }
export type FeishuApiHttpResponse = { status: number | undefined; contentType: string | null; contentLength: string | null; body: Readable }
const unavailable = (): never => { throw new AgentMuxError('This native Feishu path or request format is unavailable.', 'CONNECTION_API_ENDPOINT_UNAVAILABLE') }

export const FEISHU_API_DESCRIPTION: ConnectionApiDescription = { documentationUrl: 'https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/overview', requestFormats: ['json', 'multipart'], responseFormats: ['json', 'empty'] }
export function validateFeishuApiRequest(value: ConnectionApiRequest): ConnectionApiRequest {
  const input = parseConnectionApiRequest(value), parts = input.path.split('/')
  if (!input.path.startsWith('/open-apis/')) return unavailable()
  const service = parts[2]!.toLowerCase()
  if (['auth', 'authen', 'oauth', 'passport', 'human_authentication'].includes(service) ||
      /^\/open-apis\/admin\/v\d+\/password(?:\/|$)/iu.test(input.path) ||
      // Native application list/get export secret; application patch/config can replace authentication material.
      /^\/open-apis\/application\/v\d+\/applications(?:\/[^/]+)?$/iu.test(input.path) ||
      /^\/open-apis\/application\/v\d+\/applications\/[^/]+\/config(?:\/|$)/iu.test(input.path)) return unavailable()
  if (input.method === 'GET' && (input.body !== undefined || input.files?.length)) return unavailable()
  if (input.files?.length && (input.body !== undefined &&
      (!input.body || Array.isArray(input.body) || typeof input.body !== 'object' || Object.values(input.body).some(value => value !== null && typeof value === 'object')))) return unavailable()
  return input
}

/** Original SDK authentication and wire transport are supplied by the owning adapter. */
export function createFeishuApi(call: (config: ConnectionConfig, credential: string, scope: FeishuApiScope,
  request: ConnectionApiRequest) => Promise<FeishuApiHttpResponse>): ConnectionApiAdapter {
  return {
    description: FEISHU_API_DESCRIPTION,
    validate(value) { validateFeishuApiRequest(value) },
    async request(config, credential, value, context) {
      const input = validateFeishuApiRequest(value)
      let data: string | FormData | undefined = input.body === undefined ? undefined : JSON.stringify(input.body)
      if (input.files?.length) {
        const form = new FormData()
        for (const [key, value] of Object.entries(input.body ?? {})) form.append(key, String(value))
        for (const file of input.files) form.append(file.field, new Blob([Buffer.from(file.base64, 'base64')], { type: file.contentType }), file.name)
        data = form
      }
      const response = await call(config, credential, { url: `https://${config.application.domain}${input.path}`, data, protect: context.protect }, input)
      if (!Number.isInteger(response.status)) throw new AgentMuxError('The native Feishu response could not be confirmed.', 'CONNECTION_API_REQUEST_UNCONFIRMED')
      const body = await readConnectionApiResponse({ body: response.body, contentType: response.contentType,
        contentLength: response.contentLength, cancel() { response.body.destroy() } })
      return { status: response.status!, body }
    }
  }
}
