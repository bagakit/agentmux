import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { CAPSULE_ASSET_CHUNK_BYTES, type CapsuleInspection, type CapsulePort } from '@agentmux/core/capsule'

/** A local byte carrier for one authenticated original owner; never an arbitrary URL proxy. */
export class RemoteCapsuleProxy {
  readonly server: Server
  private originValue: string | undefined
  constructor(public capsule: CapsuleInspection, public client: CapsulePort) {
    this.server = createServer((request, response) => {
      const controller = new AbortController()
      const cancel = () => { if (!response.writableFinished) controller.abort() }
      response.once('close', cancel)
      void (async () => {
        if (!this.originValue || request.headers.host !== new URL(this.originValue).host) {
          response.writeHead(421); response.end('Use the exact Capsule endpoint.'); return
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return
        }
        const capsule = this.capsule, client = this.client, endpoint = capsule.endpoint
        if (endpoint.status !== 'available') throw Error(endpoint.issue.message)
        const input = { capsuleId: capsule.record.capsuleId, expectedRevision: capsule.record.revision,
          expectedInstanceId: endpoint.instanceId, path: request.url ?? '/', length: CAPSULE_ASSET_CHUNK_BYTES,
          ...(request.headers.accept === undefined ? {} : { accept: request.headers.accept }), head: request.method === 'HEAD' }
        let part = await client.call('capsule.asset.read', { ...input, offset: 0 }, { signal: controller.signal })
        response.writeHead(part.status, { 'Content-Type': part.contentType, 'Content-Length': part.totalBytes,
          'X-AgentMux-Capsule-Instance': endpoint.instanceId, 'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' })
        if (input.head) { response.end(); return }
        for (;;) {
          controller.signal.throwIfAborted()
          const bytes = Buffer.from(part.bytesBase64, 'base64')
          if (!response.write(bytes)) await once(response, 'drain', { signal: controller.signal })
          if (part.eof) break
          if (!bytes.length || part.assetStamp === null) throw Error('The original Capsule asset made no progress.')
          part = await client.call('capsule.asset.read', { ...input, offset: part.offset + bytes.length,
            assetStamp: part.assetStamp }, { signal: controller.signal })
        }
        response.end()
      })().catch(() => {
        if (response.headersSent) response.destroy()
        else { response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('The original Capsule asset read is unavailable. Inspect that Host’s connection and Core version, then reload this same page. Its original data and workface are retained.') }
      }).finally(() => response.off('close', cancel))
    })
  }
  get origin(): string { if (!this.originValue) throw Error('The Capsule carrier has not acquired its local endpoint.'); return this.originValue }
  async listen(savedOrigin?: string): Promise<void> {
    const saved = savedOrigin === undefined ? undefined : new URL(savedOrigin)
    if (saved && (saved.protocol !== 'http:' || saved.hostname !== '127.0.0.1' || saved.origin !== savedOrigin || !saved.port || Number(saved.port) < 1))
      throw Error('The saved Capsule carrier origin is invalid. Its original workface is retained.')
    // A saved origin is part of Chromium data identity. Port contention cannot select a new origin.
    await new Promise<void>((resolve, reject) => {
      const error = (e: Error) => { this.server.off('listening', ready); reject(e) }
      const ready = () => { this.server.off('error', error); resolve() }
      this.server.once('error', error); this.server.once('listening', ready)
      this.server.listen(saved ? Number(saved.port) : 0, '127.0.0.1')
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw Error('The local Capsule carrier endpoint is unconfirmed.')
    this.originValue = `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> {
    if (!this.server.listening) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }
}
