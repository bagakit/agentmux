import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mintObjectId } from '@agentmux/identity'
import { pipeline } from 'node:stream/promises'
import type { CapsuleEndpoint, CapsuleInjectionPort, CapsuleIssue, CapsuleRecord } from './types.js'
import { errorCode } from './storage.js'
import { openCapsuleAsset } from './assets.js'
export function endpointIssue(capsuleId: string, code: string, message: string): CapsuleIssue {
  return {
    capsuleId,
    code,
    stage: 'endpoint',
    message,
    recovery:
      'Resolve the same Capsule again after restoring its pinned content or releasing its original loopback port.',
  }
}
export class CapsuleHttp {
  readonly server: Server
  /** Process-lifetime service identity, independent of the durable page and its origin. */
  readonly instanceId = mintObjectId()
  private issue: CapsuleIssue | undefined
  private injectionIssue: CapsuleIssue | undefined
  private starting: Promise<void> | undefined
  constructor(
    public record: CapsuleRecord,
    private injection?: CapsuleInjectionPort,
  ) {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Capsule content could not be read. Inspect this Capsule for recovery.')
        } else res.destroy()
      })
    })
    this.server.on('error', (error) => {
      this.issue = endpointIssue(
        this.record.capsuleId,
        errorCode(error),
        'The original loopback endpoint is unavailable. Its port has not been reassigned.',
      )
    })
  }
  async listen(): Promise<void> {
    if (this.server.listening) return
    if (this.starting) return this.starting
    this.starting = this.startListening()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }
  private async startListening(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const error = (e: Error) => {
          this.server.off('listening', listening)
          reject(e)
        },
        listening = () => {
          this.server.off('error', error)
          resolve()
        }
      this.server.once('error', error)
      this.server.once('listening', listening)
      this.server.listen(this.record.port, '127.0.0.1')
    })
    const address = this.server.address()
    if (address && typeof address === 'object') this.record = { ...this.record, port: address.port }
    this.issue = undefined
  }
  observation(): CapsuleEndpoint {
    const observedAt = Date.now()
    return this.server.listening
      ? {
          status: 'available',
          port: this.record.port,
          instanceId: this.instanceId,
          url: `http://127.0.0.1:${this.record.port}/`,
          observedAt,
        }
      : {
          status: 'unavailable',
          port: this.record.port,
          observedAt,
          issue:
            this.issue ??
            endpointIssue(
              this.record.capsuleId,
              'CAPSULE_ENDPOINT_UNAVAILABLE',
              'The original loopback service is not currently listening.',
            ),
        }
  }
  issues(): CapsuleIssue[] {
    return this.injectionIssue ? [this.injectionIssue] : []
  }
  async close(): Promise<void> {
    if (!this.server.listening) return
    this.server.closeAllConnections()
    await new Promise<void>((res, rej) => this.server.close((e) => (e ? rej(e) : res())))
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const record = this.record
    if (req.headers.host !== `127.0.0.1:${record.port}`) {
      res.writeHead(421)
      res.end('Use the exact loopback endpoint.')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    const asset = await openCapsuleAsset(record, req.url ?? '/', req.headers.accept)
    if (asset.status !== 200) {
      res.writeHead(asset.status)
      res.end(asset.message)
      return
    }
    const { file, pathname, contentType: type } = asset
    try {
      res.setHeader('Content-Type', type)
      res.setHeader('X-AgentMux-Capsule-Instance', this.instanceId)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.setHeader('Referrer-Policy', 'no-referrer')
      if (req.method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      if (type.startsWith('text/html') && record.mode === 'injected' && this.injection) {
        let addition: string | null = null
        try {
          addition = await this.injection.html({
            record: structuredClone(record),
            url: `http://127.0.0.1:${record.port}${pathname}`,
          })
          this.injectionIssue = undefined
        } catch {
          this.injectionIssue = {
            capsuleId: record.capsuleId,
            code: 'CAPSULE_INJECTION_UNAVAILABLE',
            stage: 'injection',
            message:
              'The optional App injection could not be confirmed. Original page content remains readable.',
            recovery: 'Reload this exact Capsule after restoring its trusted document adapter.',
          }
        }
        if (addition) {
          const html = await file.readFile('utf8')
          res.writeHead(200)
          res.end(html.includes('</head>') ? html.replace('</head>', `${addition}</head>`) : addition + html)
          return
        }
      }
      res.writeHead(200)
      await pipeline(file.createReadStream({ autoClose: false }), res)
    } finally {
      await file.close()
    }
  }
}
