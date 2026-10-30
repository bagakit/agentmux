import { afterEach, vi } from 'vitest'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDaemonChannel, exportPublicKey, generateKeyPair, type Transport } from '@agentmux/relay/e2ee'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { connectRelayHostedClient } from '../../src/relay-hosted.js'
import { createMobileTerminalControl, type MobileTerminalControlState } from '../../../../apps/mobile/src/terminal/control.js'
import { DeviceAuthority } from '../../../../apps/host/src/device-authority.js'
import { createDeviceAdministration } from '../../../../apps/host/src/device-administration.js'
import { rpcOwnerFixture } from './public-rpc-owner.js'

const close: Array<() => unknown | Promise<unknown>> = []
const roots: string[] = []
const witnessPath = process.env.AGENTMUX_RELAY_INPUT_FACTS

export function relayInputWitness(value: unknown): void {
  if (witnessPath) appendFileSync(witnessPath, JSON.stringify(value) + '\n')
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const release of close.splice(0).reverse()) {
    try { await release() } catch (error) { failures.push(error) }
  }
  for (const root of roots.splice(0)) {
    if (existsSync(root)) failures.push(Error('Private relay root remains: ' + root))
    else relayInputWitness({ kind: 'cleanup', rootRemoved: root })
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private Mobile relay cleanup failed')
})

function transport(socket: WebSocket, delay: number): Transport {
  const port: Transport = {
    send: data => new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        if (socket.readyState !== socket.OPEN) { reject(Error('private socket closed')); return }
        socket.send(data, error => error ? reject(error) : resolve())
      }, delay)
    }),
    close: (code, reason) => socket.close(code === 1011 ? 4011 : code, reason),
    onmessage: null, onclose: null, onerror: null
  }
  socket.on('message', (data, isBinary) => port.onmessage?.({
    data: isBinary ? Uint8Array.from(data as Buffer).buffer : data.toString(), isBinary
  }))
  socket.on('close', (code, reason) => port.onclose?.(code, reason.toString()))
  socket.on('error', error => port.onerror?.(error))
  return port
}

export async function mobileRelayOwner(delay = 0) {
  const f = await rpcOwnerFixture(['caller'])
  close.push(f.close)
  roots.push(f.root)
  const journal = (f.client as unknown as {
    messageQueue: { messageChanges(): Promise<unknown> }
  }).messageQueue
  const dispose = f.client.dispose.bind(f.client)
  vi.spyOn(f.client, 'dispose').mockImplementation(async () => {
    await dispose()
    // The original journal's FIFO transaction observes every preceding write.
    // Await that owner after producers stop, before the fixture removes its root.
    await journal.messageChanges()
  })
  vi.spyOn(f.client, 'connect').mockResolvedValue()

  const owner = {
    runtimeId: 'r20-private-runtime', ownerInstanceId: 'r20-private-owner',
    protocolVersion: 2, processId: process.pid, availability: 'connected' as const,
    ctxmux: f.client.runtimeIdentity()
  }
  const hosted = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => owner)
  close.push(() => hosted.dispose())
  const authority = await DeviceAuthority.open(join(f.root, 'r20-devices.json'))
  close.push(() => authority.flush())
  const administration = createDeviceAdministration(async () => authority,
    () => ({ state: 'connected', message: 'private' }), () => 'http://127.0.0.1/')
  const server = new AgentMuxControlServer({
    coreClients: f.coreClients, hostedRuntime: () => hosted, deviceAdministration: administration
  })
  close.push(() => server.stop())

  const key = generateKeyPair(), deviceKey = generateKeyPair()
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => relay.once('listening', resolve))
  close.push(async () => {
    for (const socket of relay.clients) socket.terminate()
    await new Promise<void>(resolve => relay.close(() => resolve()))
  })
  let connections = 0
  const requests: Array<{ connection: number; id: unknown; method: string; invocation?: string; at: number }> = []
  relay.on('connection', socket => {
    const connection = ++connections
    let rpc: ReturnType<AgentMuxControlServer['openAuthenticatedFrames']> | undefined
    let queue = Promise.resolve()
    const channel = createDaemonChannel(transport(socket, delay), key, {
      onmessage: data => {
        // T001 injects the current Host queue shape; it does not qualify the
        // production Host attachment or any later carrier implementation.
        queue = queue.then(async () => {
          const encrypted = await channel
          const publicKey = encrypted.peerPublicKeyB64!
          if (publicKey !== exportPublicKey(deviceKey.publicKey)) throw Error('private peer differs')
          const device = await authority.authorizeKey(publicKey)
          const author = { deviceId: device.deviceId, createdAt: device.createdAt }
          rpc ??= server.openAuthenticatedFrames({
            authorization: {
              principal: { kind: 'device', id: authority.hostId + ':' + device.deviceId },
              assertCurrent: () => authority.assertCurrentKey(author, publicKey)
            },
            send: async frame => { await encrypted.send(JSON.stringify(frame)) },
            close: () => socket.close()
          })
          const frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
          requests.push({ connection, id: frame.id, method: frame.method,
            invocation: frame.params?.invocation?.method, at: performance.now() })
          await rpc.receive(frame)
        }).catch(() => socket.close(4002, 'private probe failure'))
      }
    })
    socket.once('close', () => rpc?.dispose())
    void channel.catch(() => socket.close())
  })
  const address = relay.address()
  if (!address || typeof address === 'string') throw Error('private relay did not bind')
  const resize = vi.fn(async (runId: string, cols: number, rows: number) => ({
    run: { ...f.run(runId), cols, rows }, cols, rows
  }))
  f.inner.kernel.resize = resize
  const controller = new AbortController()
  const client = await connectRelayHostedClient({
    name: 'r20 private causal probe', signal: controller.signal, keyPair: deviceKey,
    offer: {
      v: 2, serverId: 'r20-private-host', daemonPublicKeyB64: exportPublicKey(key.publicKey),
      relay: { endpoint: `127.0.0.1:${address.port}`, useTls: false }
    }
  })
  close.push(async () => { await client.dispose(); controller.abort() })

  const backing = new Map<string, string>(), reports: MobileTerminalControlState[] = []
  const control = createMobileTerminalControl({
    client, agentSessionId: 'caller', report: state => reports.push(state),
    storage: () => ({
      getItem: key => backing.get(key) ?? null,
      setItem: (key, value) => { backing.set(key, value) },
      removeItem: key => { backing.delete(key) }
    })
  })
  close.push(() => control.dispose())
  return { ...f, client, control, reports, backing, requests, resize, connections: () => connections }
}
