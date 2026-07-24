import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { NativeHookEnvelope } from './types.js'

const MAX_BODY_BYTES = 128 * 1024

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('Hook body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function respond(response: ServerResponse, statusCode: number, body = ''): void {
  response.writeHead(statusCode, body ? { 'content-type': 'application/json' } : undefined)
  response.end(body)
}

function isEnvelope(value: unknown): value is NativeHookEnvelope {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.semanticSessionId === 'string' && Boolean(record.semanticSessionId.trim()) &&
    typeof record.daemonSessionId === 'string' && Boolean(record.daemonSessionId.trim()) &&
    typeof record.incarnationId === 'string' && Boolean(record.incarnationId.trim()) &&
    typeof record.agentId === 'string' && Boolean(record.agentId.trim())
  )
}

export type HookServerEndpoint = {
  url: string
  token: string
  port: number
}

export class AgentHookServer {
  private server: Server | null = null
  private readonly token = randomBytes(32).toString('base64url')
  private endpoint: HookServerEndpoint | null = null

  constructor(private readonly onEvent: (event: NativeHookEnvelope) => void | Promise<void>) {}

  async start(): Promise<HookServerEndpoint> {
    if (this.endpoint) return this.endpoint
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Hook server did not bind a TCP port')
    this.endpoint = { url: `http://127.0.0.1:${address.port}/v1/events`, token: this.token, port: address.port }
    return this.endpoint
  }

  getEndpoint(): HookServerEndpoint | null {
    return this.endpoint
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.endpoint = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/events') {
      respond(response, 404)
      return
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      respond(response, 403)
      return
    }
    request.setTimeout(2_000, () => request.destroy())
    try {
      const parsed: unknown = JSON.parse(await readBody(request))
      if (!isEnvelope(parsed)) {
        respond(response, 400, JSON.stringify({ error: 'invalid_hook_envelope' }))
        return
      }
      await this.onEvent(parsed)
      respond(response, 204)
    } catch {
      // Observation is fail-open: malformed status must not hold up an agent hook.
      respond(response, 204)
    }
  }
}
