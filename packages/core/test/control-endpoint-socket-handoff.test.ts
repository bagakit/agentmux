import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it } from 'vitest'
import { fork, execFile, type ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { createConnection, type Socket } from 'node:net'
import { mkdtemp, rm, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ControlEndpointPublication } from '../src/control-endpoint-publication.js'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean): Promise<boolean> {
  const end = Date.now() + 5000
  while (!predicate() && Date.now() < end) await delay(10)
  return predicate()
}
function barePipes(): object[] {
  return (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles().filter(handle => handle.constructor.name === 'Pipe')
}
function connect(path: string): Socket {
  const socket = createConnection(path); socket.on('error', () => {})
  disposals.push(async () => { socket.destroy() })
  return socket
}
async function echo(socket: Socket, text: string): Promise<string> {
  let received = ''
  const read = (bytes: Buffer) => { received += bytes.toString() }
  socket.on('data', read); socket.write(text)
  await until(() => received === text || socket.destroyed)
  socket.off('data', read)
  return received
}
function listenerChildren(): ChildProcess[] {
  return (process as unknown as { _getActiveHandles(): ChildProcess[] })._getActiveHandles()
    .filter(handle => handle.constructor.name === 'ChildProcess' && handle.spawnargs.some(arg => arg.endsWith('/control-endpoint-listener-worker.js')))
}
async function fixture(start = true) {
  const root = await mkdtemp(fixturePath("tmp/amch-")), path = join(root, 'rpc')
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const accepted = new Set<Socket>(), observed: string[] = []
  const publication = new ControlEndpointPublication(path, socket => {
    accepted.add(socket); socket.on('data', bytes => socket.write(bytes)); socket.on('error', () => {})
  }, state => observed.push(state.state))
  disposals.push(async () => { for (const socket of accepted) socket.destroy(); await publication.stop() })
  if (start) await publication.start()
  return { publication, path, accepted, observed }
}

it('coalesces concurrent startup into one real listener process', async () => {
  const before = new Set(listenerChildren()), scope = await fixture(false)
  await Promise.all([scope.publication.start(), scope.publication.start(), scope.publication.start()])
  expect(listenerChildren().filter(child => !before.has(child))).toHaveLength(1)
  expect(await echo(connect(scope.path), 'single-owner')).toBe('single-owner')
  await scope.publication.stop()
  expect(await until(() => listenerChildren().every(child => before.has(child)))).toBe(true)
}, 15000)

it('joins a real worker disconnect before ready without hanging startup or stop', async () => {
  const before = new Set(listenerChildren()), scope = await fixture(false)
  const spawning = channel('child_process')
  const interrupt = (event: unknown) => {
    const child = (event as { process: ChildProcess }).process
    child.once('spawn', () => { if (child.spawnargs.includes(join(scope.path, '..')) || child.spawnargs.some(arg => arg.startsWith(join(scope.path, '..') + '/'))) child.disconnect() })
  }
  spawning.subscribe(interrupt)
  try {
    let failure: unknown
    const starting = scope.publication.start().catch(error => { failure = error })
    expect(await until(() => failure !== undefined)).toBe(true)
    await starting; await scope.publication.stop()
    expect(failure).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(listenerChildren().filter(child => !before.has(child))).toEqual([])
    await expect(lstat(scope.path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { spawning.unsubscribe(interrupt) }
}, 15000)

it('removes only its failed publication inode when a worker dies immediately after link, then retries', async () => {
  const scope = await fixture(), socket = connect(scope.path)
  expect(await echo(socket, 'before-link-race')).toBe('before-link-race')
  const current = (scope.publication as unknown as { current: { path: string } }).current
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const originalLink = fs.link
  let interrupted = false
  fs.link = async (source, target) => {
    await originalLink(source, target)
    if (String(target) === scope.path && !interrupted) {
      interrupted = true
      const child = listenerChildren().find(child => child.spawnargs.includes(String(source)))!
      await new Promise<void>(done => { child.once('exit', () => done()); child.kill('SIGKILL') })
    }
  }
  syncBuiltinESMExports()
  try {
    await rm(scope.path); await rm(current.path)
    expect(await until(() => interrupted && scope.observed.includes('unavailable'))).toBe(true)
    expect(await echo(socket, 'during-retry')).toBe('during-retry')
    expect(await until(() => scope.observed.at(-1) === 'available')).toBe(true)
    expect(await echo(connect(scope.path), 'after-retry')).toBe('after-retry')
  } finally { fs.link = originalLink; syncBuiltinESMExports() }
}, 15000)

it('retires a missing in-transit Socket without killing healthy admission', async () => {
  const scope = await fixture(), socket = connect(scope.path)
  expect(await echo(socket, 'before-short-clients')).toBe('before-short-clients')
  const child = (scope.publication as unknown as { current: { child: ChildProcess } }).current.child
  // Exercise the documented absent-handle event separately from real quick clients.
  // The OS race is not deterministic, so the event is deliberately controlled here.
  child.emit('message', { connection: Number.MAX_SAFE_INTEGER }, undefined)
  const clients = Array.from({ length: 32 }, () => connect(scope.path))
  for (const client of clients) client.once('connect', () => client.destroy())
  await delay(50)
  expect(child.exitCode).toBe(null); expect(child.connected).toBe(true)
  expect(scope.observed).toEqual(['available'])
  expect(await echo(socket, 'existing-after-short-clients')).toBe('existing-after-short-clients')
  expect(await echo(connect(scope.path), 'new-after-short-clients')).toBe('new-after-short-clients')
}, 15000)

it('hands off immediate fragmented ingress and joins the only listener worker without orphan Pipes', async () => {
  const original = new Set(barePipes()), scope = await fixture()
  const socket = connect(scope.path)
  let received = ''; socket.on('data', bytes => { received += bytes.toString() })
  socket.write('first'); socket.write(':fragment\n')
  expect(await until(() => received === 'first:fragment\n')).toBe(true)
  // Transport retirement must not cut a Socket already owned by Core.
  await scope.publication.stop()
  expect(await echo(socket, 'after-listener-stop')).toBe('after-listener-stop')
  expect(barePipes().filter(handle => !original.has(handle))).toEqual([])
  await expect(lstat(scope.path)).rejects.toMatchObject({ code: 'ENOENT' })
}, 15000)

it.each(['crash', 'disconnect'] as const)('recovers %s while admitted connections remain usable', async failure => {
  const scope = await fixture(), socket = connect(scope.path)
  expect(await echo(socket, 'before')).toBe('before')
  const original = await lstat(scope.path)
  const child = (scope.publication as unknown as { current: { child: import('node:child_process').ChildProcess } }).current.child
  if (failure === 'crash') child.kill('SIGKILL'); else child.disconnect()
  expect(await until(() => scope.observed.includes('unavailable'))).toBe(true)
  expect(await echo(socket, 'existing')).toBe('existing')
  expect(await until(() => scope.observed.at(-1) === 'available')).toBe(true)
  expect((await lstat(scope.path)).ino).not.toBe(original.ino)
  expect(await echo(connect(scope.path), 'new-owner-same-core')).toBe('new-owner-same-core')
}, 15000)

it('bounds actual unacknowledged Socket transfers and recovers capacity without cutting admitted sockets', async () => {
  const root = await mkdtemp(fixturePath("tmp/amch-")), path = join(root, 'rpc')
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const child = fork(resolve(import.meta.dirname, '../dist/control-endpoint-listener-worker.js'), [path], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const closed = Promise.all([new Promise<void>(done => child.once('exit', () => done())),
    new Promise<void>(done => child.once('disconnect', () => done()))])
  disposals.push(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed })
  let ready = false
  const transfers: Array<{ id: number; socket: Socket; received: string }> = [], pressure: number[] = []
  child.on('message', (message: { identity?: unknown; connection?: number; pending?: number }, handle: Socket) => {
    if (message.identity) ready = true
    if (typeof message.pending === 'number') pressure.push(message.pending)
    if (typeof message.connection === 'number') {
      const entry = { id: message.connection, socket: handle, received: '' }; transfers.push(entry)
      handle.on('data', bytes => { entry.received += bytes.toString(); handle.write(bytes) }); handle.on('error', () => {})
      disposals.push(async () => { handle.destroy() })
    }
  })
  expect(await until(() => ready)).toBe(true)
  const rss = async () => Number((await promisify(execFile)('ps', ['-o', 'rss=', '-p', String(child.pid)])).stdout.trim())
  const idleRssKiB = await rss(), started = performance.now()
  const clients = Array.from({ length: 64 }, (_, index) => { const socket = connect(path); socket.resume(); socket.write('first-' + index); return socket })
  expect(await until(() => transfers.length === 64 && transfers.every(entry => entry.received.startsWith('first-')))).toBe(true)
  const burstMs = performance.now() - started, fullRssKiB = await rss()
  await delay(20)
  const refused = connect(path)
  expect(await until(() => refused.destroyed && pressure.includes(64))).toBe(true)
  expect(transfers).toHaveLength(64)
  expect(await echo(clients[0], ':still-admitted')).toBe(':still-admitted')
  child.send({ admitted: transfers[0].id })
  expect(await until(() => pressure.includes(63))).toBe(true)
  const recovered = connect(path); recovered.write('recovered')
  expect(await until(() => transfers.length === 65 && transfers.at(-1)!.received === 'recovered')).toBe(true)
  // Parent IPC loss ends only admission; transferred connections remain usable.
  child.disconnect(); await closed
  expect(await echo(clients[1], ':after-disconnect')).toBe(':after-disconnect')
  console.log(JSON.stringify({ socketHandoffBudget: 64, transferredAtCapacity: 64, overflowClosed: true,
    recovered: true, existingConnectionsPreserved: true, idleRssKiB, fullRssKiB, burstMs }))
}, 15000)

it('fences connections racing stop and leaves no late listener or child Pipe', async () => {
  const original = new Set(barePipes()), scope = await fixture()
  const clients = Array.from({ length: 32 }, () => connect(scope.path))
  await scope.publication.stop()
  for (const socket of clients) socket.destroy()
  for (const socket of scope.accepted) socket.destroy()
  await delay(20)
  expect(barePipes().filter(handle => !original.has(handle))).toEqual([])
  await expect(lstat(scope.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(scope.accepted.size).toBeLessThanOrEqual(32)
}, 15000)
