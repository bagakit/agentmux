import { afterEach, vi } from 'vitest'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { generateKeyPair } from '@agentmux/relay/e2ee'
import * as core from '../../src/index.js'
import { connectRelayHostedClient } from '../../src/relay-hosted.js'
import { startAgentMuxHost } from '../../../../apps/host/src/host.js'
import { rpcOwnerFixture } from './public-rpc-owner.js'

const factsPath = process.env.AGENTMUX_RELAY_INPUT_FACTS
const cleanups: Array<() => unknown | Promise<unknown>> = []
const roots: string[] = []
export const carrierFact = (value: unknown) => {
  if (factsPath) appendFileSync(factsPath, JSON.stringify(value) + '\n')
}
export function held<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) {
    try { await close() } catch (error) { errors.push(error) }
  }
  for (const root of roots.splice(0)) {
    if (existsSync(root)) errors.push(Error('Private actual Host root remains: ' + root))
    else carrierFact({ kind: 'cleanup', rootRemoved: root })
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Private actual Relay Host cleanup failed')
})
type Frame = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
type Request = { connection: number; frame: Frame; at: number }

/** Actual Host/headless/LocalRelay/DeviceAuthority; only the original native Runtime I/O is controlled. */
export async function actualRelayOwner() {
  const original = await rpcOwnerFixture(['caller'], core)
  cleanups.push(original.close)
  roots.push(original.root)
  await original.client.dispose()
  const assets = join(original.root, 'mobile')
  await mkdir(assets)
  const html = '<!doctype html><title>Private Relay owner</title>'
  const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex')
  await writeFile(join(assets, 'index.html'), html)
  const manifest = { schema: 'agentmux.mobile-web-release.v1', buildId: 'r20-private-carrier',
    files: [{ path: 'index.html', bytes: Buffer.byteLength(html), digest: hash(html) }] }
  await writeFile(join(assets, 'mobile-release.json'), JSON.stringify({ ...manifest, digest: hash(JSON.stringify(manifest)) }))

  const sockets: WebSocket[] = []
  let handshakes = 0
  const NativeWebSocket = globalThis.WebSocket
  vi.stubGlobal('WebSocket', class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      sockets.push(this)
      const send = this.send.bind(this)
      this.send = data => {
        if (typeof data === 'string' && data.startsWith('{') && JSON.parse(data).type === 'e2ee_hello') handshakes++
        send(data)
      }
    }
  })
  const native = original.inner.kernel
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local')
    inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'openInput', 'input', 'resize', 'observeOutput', 'attach', 'detach', 'stop']) {
      if (native[name]) inner.kernel[name] = native[name]
    }
  })
  let connections = 0
  let inFlight = 0
  const requests: Request[] = []
  const replies: Request[] = []
  let sendReply: ((frame: Frame, connection: number, send: (frame: unknown) => Promise<void>) => Promise<void>) | undefined
  const authenticated = core.AgentMuxControlServer.prototype.openAuthenticatedFrames
  vi.spyOn(core.AgentMuxControlServer.prototype, 'openAuthenticatedFrames').mockImplementation(function (options) {
    const connection = ++connections
    const send = async (frame: unknown) => {
      replies.push({ connection, frame: frame as Frame, at: performance.now() })
      if (sendReply) await sendReply(frame as Frame, connection, options.send)
      else await options.send(frame)
    }
    const port = authenticated.call(this, { ...options, send })
    return { ...port, receive: async frame => {
      requests.push({ connection, frame: frame as Frame, at: performance.now() })
      inFlight++
      try { await port.receive(frame) } finally { inFlight-- }
    } }
  })
  const host = await startAgentMuxHost({ store: original.store, socketPath: join(original.root, 'host.sock'),
    desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: assets, mobilePort: 0 })
  connect.mockRestore()
  const journal = Reflect.get(host.client, 'messageQueue') as { messageChanges(): Promise<unknown> }
  cleanups.push(async () => { await host.dispose(); await journal.messageChanges() })
  const local = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(original.root, 'host.sock') } })
  cleanups.push(() => local.dispose())
  const link = await local.call('device.link', {})
  const offered = parseConnectionOfferUrl(link.url)
  if (!offered) throw Error('Actual Host returned no connection offer')
  const offer = { ...offered, relay: { ...offered.relay, endpoint: '127.0.0.1:' + offered.relay.endpoint.split(':').at(-1)! } }
  const keyPair = generateKeyPair()
  const options = { offer, keyPair }
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'relay', offer }, relayKeyPair: keyPair })
  cleanups.push(() => rpc.dispose())
  const hosted = async (createWebSocket?: (url: string) => WebSocket) => {
    const controller = new AbortController()
    const client = await connectRelayHostedClient({ ...options, ...(createWebSocket ? { createWebSocket } : {}), name: 'private actual Hosted Relay', signal: controller.signal })
    cleanups.push(async () => { await client.dispose(); controller.abort() })
    return client
  }
  const authority = await host.deviceAuthority()
  return { ...original, original, host, local, rpc, hosted, options, authority, requests, replies,
    inFlight: () => inFlight, sockets, handshakes: () => handshakes, activeSockets: () => sockets.filter(socket => socket.readyState < WebSocket.CLOSING),
    connections: () => connections, reply: (hook: typeof sendReply) => { sendReply = hook },
    cleanup: (close: () => unknown | Promise<unknown>) => cleanups.push(close) }
}
