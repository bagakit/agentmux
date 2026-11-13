import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** One 127.0.0.1 listener on an ephemeral port: started on first use, closed once with its owner. */
export class LoopbackListener {
  private server: Server | null = null
  private origin: string | null = null
  private starting: Promise<string> | null = null
  private closed = false

  constructor(private readonly handle: (request: IncomingMessage, response: ServerResponse) => void,
    private readonly unavailable: () => Error) {}

  /** The Host header a request to this listener must carry; null before it listens. */
  get host(): string | null {
    return this.origin?.slice('http://'.length) ?? null
  }

  async start(): Promise<string> {
    if (this.origin) return this.origin
    if (this.starting) return await this.starting
    const server = createServer(this.handle)
    this.server = server
    this.starting = new Promise<string>((resolve, reject) => {
      server.once('error', error => {
        if (this.server === server) { this.server = null; this.origin = null }
        server.close()
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (this.closed || !address || typeof address === 'string') {
          server.close()
          reject(this.unavailable())
          return
        }
        // The origin names the address the socket actually bound, so a wider bind could never pass as loopback.
        this.origin = `http://${address.address}:${address.port}`
        resolve(this.origin)
      })
    })
    try { return await this.starting } finally { this.starting = null }
  }

  async close(): Promise<void> {
    this.closed = true
    try { await this.starting } catch { /* A concurrent start observes the close and closes its own server. */ }
    const server = this.server
    this.server = null
    this.origin = null
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      })
      server.closeAllConnections()
    })
  }
}
