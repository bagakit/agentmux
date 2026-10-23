import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { CapsuleEndpoint, CapsuleInjectionPort, CapsuleIssue, CapsuleRecord } from './types.js'
import { errorCode, safeFile } from './storage.js'
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
}
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
    let pathname: string
    try {
      const raw = (req.url ?? '/').split('?')[0] ?? '/'
      pathname = decodeURIComponent(raw)
      if (
        !pathname.startsWith('/') ||
        pathname.includes('\\') ||
        pathname.includes('\0') ||
        pathname.split('/').some((x) => x === '..')
      )
        throw Error()
    } catch {
      res.writeHead(400)
      res.end('Invalid Capsule path.')
      return
    }
    let relative = pathname.slice(1)
    if (!relative) relative = record.entry
    else if (relative.endsWith('/')) relative += 'index.html'
    let file: Awaited<ReturnType<typeof safeFile>>
    try {
      file = await safeFile(record.contentRoot, relative)
    } catch (error) {
      // Only navigation-shaped SPA paths fall back. Missing asset requests remain honest 404s.
      if (
        errorCode(error) === 'ENOENT' &&
        record.routing === 'spa' &&
        !extname(relative) &&
        (!req.headers.accept || req.headers.accept.includes('text/html'))
      ) {
        try {
          relative = record.entry
          file = await safeFile(record.contentRoot, relative)
        } catch {
          res.writeHead(404)
          res.end('Capsule entry is unavailable.')
          return
        }
      } else {
        res.writeHead(errorCode(error) === 'ENOENT' ? 404 : 403)
        res.end('Capsule file is unavailable.')
        return
      }
    }
    try {
      const type = mime[extname(relative).toLowerCase()] ?? 'application/octet-stream'
      res.setHeader('Content-Type', type)
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
