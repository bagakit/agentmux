import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { attachRelayGateway, hashPublisherToken, parseRelayGatewayConfiguration } from '../src/gateway.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('the public configuration parser rejects non-string credential hashes before listener admission', () => {
  const tokenHash = hashPublisherToken('private typed fixture')
  for (const value of [[tokenHash], 17, true, null, {}, undefined]) {
    expect(() => parseRelayGatewayConfiguration({ port: 0, publishers: [{ serverId: 'original', tokenHash: value }] })).toThrow('SHA-256')
  }
})

it('the embedded gateway borrows its listener and preserves another HTTP/WebSocket service on release', async () => {
  const server = createServer((_request, response) => response.end('original Core service'))
  const peers = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/original') return
    peers.handleUpgrade(request, socket, head, ws => { ws.on('message', data => ws.send(data)) })
  })
  const gateway = attachRelayGateway(server, { publishers: [{ serverId: 'original', tokenHash: hashPublisherToken('private publisher') }] })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    await gateway.stop(); for (const peer of peers.clients) peer.terminate()
    await new Promise<void>(resolve => peers.close(() => resolve()))
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Private listener did not bind')
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}/original`)
  cleanup.push(() => peer.terminate()); await once(peer, 'open')
  const before = once(peer, 'message'); peer.send('before relay release'); expect(String((await before)[0])).toBe('before relay release')
  await gateway.stop()
  const after = once(peer, 'message'); peer.send('after relay release'); expect(String((await after)[0])).toBe('after relay release')
  expect(await (await fetch(`http://127.0.0.1:${address.port}/original`)).text()).toBe('original Core service')
})

it('the independent package executable reads explicit grants, serves safe health and shuts down its own process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-relay-cli-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const config = join(root, 'gateway.json'), token = 'private-publisher-do-not-log'
  await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 0, publishers: [{ serverId: 'original', tokenHash: hashPublisherToken(token) }] }), { mode: 0o600 })
  const executable = resolve('packages/relay/bin/agentmux-relay')
  expect((await stat(executable)).mode & 0o111).not.toBe(0)
  const child = spawn(process.execPath, [executable, 'serve', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += String(bytes) })
  cleanup.push(async () => {
    if (child.exitCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
  })
  const lines = createInterface({ input: child.stdout })
  cleanup.push(() => lines.close())
  const [line] = await once(lines, 'line'), receipt = JSON.parse(line)
  expect(receipt).toMatchObject({ operation: 'serve', service: 'agentmux-relay', protocol: 2, host: '127.0.0.1' })
  expect(line).not.toContain(token)
  const health = await fetch(`http://127.0.0.1:${receipt.port}/healthz`)
  expect(await health.json()).toEqual({ service: 'agentmux-relay', protocol: 2 })
  const control = new WebSocket(`ws://127.0.0.1:${receipt.port}/ws?v=2&serverId=original&role=server`, { headers: { Authorization: 'Bearer ' + token } })
  cleanup.push(() => control.terminate())
  const sync = once(control, 'message'); await once(control, 'open')
  expect(JSON.parse(String((await sync)[0]))).toEqual({ type: 'sync', connectionIds: [] })
  const ended = once(child, 'exit'); child.kill('SIGTERM')
  expect(await ended).toEqual([0, null]); expect(stderr).toBe('')
})

it('the built package exports gateway composition without importing Core or Desktop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-relay-consumer-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules', '@agentmux'), { recursive: true })
  await symlink(resolve('packages/relay'), join(root, 'node_modules', '@agentmux', 'relay'))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const p=await import('@agentmux/relay/gateway'); console.log(JSON.stringify({attach:typeof p.attachRelayGateway,start:typeof p.startRelayGateway}));"], { cwd: root, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ attach: 'function', start: 'function' })
})

it('configuration errors never print publisher secrets, including malformed JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-relay-invalid-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'private.json'), secret = 'never-log-this-private-publisher-credential'
  await writeFile(path, `{"publishers":[{"token":"${secret}"},]}`)
  const result = spawnSync(process.execPath, [resolve('packages/relay/bin/agentmux-relay'), 'serve', '--config', path], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('not valid JSON')
  expect(result.stdout + result.stderr).not.toContain(secret)
  expect(() => parseRelayGatewayConfiguration({ port: 0, publishers: [], unrecognized: secret })).toThrow('requires')
})
