import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MobileAssetsOwner } from '../src/mobile-assets-owner.js'
import { mobileRelease, mobileWebFixture } from './helpers/mobile-web-fixture.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function malformed(port: number) {
  const socket = createConnection({ host: '127.0.0.1', port }); let result = ''
  await new Promise<void>((done, reject) => {
    socket.once('error', reject); socket.on('data', value => { result += value })
    socket.once('connect', () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'))
    socket.once('close', () => done())
  })
  return result
}

it('rejects a parser-accepted malformed target inside the owner while retaining its exact active snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-mobile-http-target-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mobileRelease(root, 'http-target-build')
  const owner = new MobileAssetsOwner(); await owner.initialize(root)
  const before = owner.inspect({ hostId: 'local' }); let thrown: unknown = null
  const server = createServer((request, response) => {
    try { owner.route(request, response) }
    catch (error) { thrown = error; response.writeHead(500); response.end() }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Private HTTP port unavailable')
  const response = await malformed(address.port)
  expect(thrown).toBeNull(); expect(response).toMatch(/^HTTP\/1\.1 400 /u)
  const normal = await fetch('http://127.0.0.1:' + address.port)
  expect(normal.status).toBe(200); expect(await normal.text()).toContain('http-target-build')
  expect(owner.inspect({ hostId: 'local' }).active).toEqual(before.active)
})

it('keeps the original private Host identity and healthy original Run after rejecting the malformed request', async () => {
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const phone = await f.relay()
  const before = await f.client.statusAgent(f.session.agentSessionId)
  const response = await malformed(Number(new URL(f.info.origin).port))
  expect(response).toMatch(/^HTTP\/1\.1 400 /u)
  expect((await phone.call('runtime.owner.identity', {})).owner).toMatchObject({ runtimeId: f.native.owner.runtimeId,
    ownerInstanceId: f.native.owner.ownerInstanceId, processId: f.native.owner.processId })
  expect((await fetch(f.info.origin)).status).toBe(200)
  const after = await f.client.statusAgent(f.session.agentSessionId)
  expect(after.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
})
