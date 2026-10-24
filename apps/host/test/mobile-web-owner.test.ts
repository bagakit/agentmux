import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MobileAssetsOwner } from '../src/mobile-assets-owner.js'
import { loadMobileSnapshot } from '../src/mobile-assets.js'
import { mobileHash, mobileRelease } from './helpers/mobile-web-fixture.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'amux-mobile-owner-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root }
function author(root: string) { return { hostId: 'local', agentSessionId: 'original-author', runId: 'original-run', workspacePath: root, assertCurrent: async () => {} } }
async function http(owner: MobileAssetsOwner) {
  const server = createServer(owner.route), sockets = new Set<Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address()
  if (!address || typeof address === 'string') throw Error('Private HTTP address unavailable')
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())) })
  return { port: address.port, origin: 'http://127.0.0.1:' + address.port }
}
it('shares one original in-flight operation while real candidate IO is pending, and never lets initialization overwrite an activation', async () => {
  const root = await directory(), manifest = await mobileRelease(join(root, 'candidate'), 'first-build'), owner = new MobileAssetsOwner()
  const input = { hostId: 'local', operationId: 'same-original', candidatePath: 'candidate', candidateDigest: manifest.digest, expectedActiveRevision: 0 }
  const first = owner.activate(input, author(root))
  await Promise.resolve() // assertCurrent settled; original candidate realpath/read IO has started.
  expect((owner as any).busy).toBe(true)
  expect(owner.inspect({ hostId: 'local', operationId: input.operationId }).operation).toMatchObject({ availability: 'in-flight', receipt: null })
  const same = owner.activate(Object.fromEntries(Object.entries(input).reverse()) as typeof input, author(root))
  await expect(owner.activate({ ...input, candidatePath: 'another-candidate' }, author(root))).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(owner.initialize(join(root, 'candidate'))).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const second = await owner.activate({ ...input, operationId: 'different-original' }, author(root))
  expect(second).toMatchObject({ status: 'not-admitted', reason: 'busy' })
  const [a, b] = await Promise.all([first, same]); expect(a).toEqual(b); expect(a.status).toBe('active')
  await owner.initialize(join(root, 'missing-initial-directory'))
  expect(owner.inspect({ hostId: 'local' }).active).toMatchObject({ buildId: 'first-build', revision: 1 })
})
it('content namespaces cannot revive old URLs or exact loaded observations when an evicted buildId is reused', async () => {
  const root = await directory(), owner = new MobileAssetsOwner(), server = await http(owner), auth = author(root)
  const publish = async (name: string, build: string, revision: number) => {
    const manifest = await mobileRelease(join(root, name), build, JSON.stringify(name))
    const result = await owner.activate({ hostId: 'local', operationId: name, candidatePath: name, candidateDigest: manifest.digest, expectedActiveRevision: revision }, auth)
    expect(result.status).toBe('active'); return manifest
  }
  const a = await publish('candidate-a', 'reused-build', 0), old = await fetch(server.origin)
  const oldAsset = new URL('./assets/app.js', old.url).href
  owner.loaded({ documentId: 'old-document', buildId: a.buildId, namespaceDigest: a.digest, occurrenceId: 'old-observation', observedAt: 1 }, 'original-device')
  await publish('candidate-b', 'build-b', 1); await publish('candidate-c', 'build-c', 2)
  const replacement = await publish('candidate-a-prime', 'reused-build', 3), current = await fetch(server.origin)
  expect(replacement.digest).not.toBe(a.digest); expect(current.url).not.toBe(old.url)
  expect((await fetch(oldAsset)).status).toBe(410)
  expect(await (await fetch(new URL('./assets/app.js', current.url))).text()).toBe(JSON.stringify('candidate-a-prime'))
  expect(owner.inspect({ hostId: 'local', client: { devicePrincipalId: 'original-device', documentId: 'old-document' } }).client?.namespace).toBe('not-retained')
})
it('bounds retained operations and loaded scopes without allowing same-release receipts to pin the finite archive', async () => {
  const root = await directory(), manifest = await mobileRelease(join(root, 'candidate'), 'same-release'), owner = new MobileAssetsOwner(), auth = author(root)
  for (let index = 0; index < 70; index++) await owner.activate({ hostId: 'local', operationId: 'operation-' + index,
    candidatePath: 'candidate', candidateDigest: manifest.digest, expectedActiveRevision: index }, auth)
  for (let index = 0; index < 32; index++) expect(owner.loaded({ documentId: 'document-' + index, buildId: null, namespaceDigest: null,
    occurrenceId: 'loaded-' + index, observedAt: index }, 'original-device').accepted).toBe(true)
  expect(owner.loaded({ documentId: 'overflow-document', buildId: null, namespaceDigest: null, occurrenceId: 'overflow', observedAt: 33 }, 'original-device')).toMatchObject({ accepted: false, reason: 'capacity' })
  const state = owner.inspect({ hostId: 'local', operationId: 'operation-0' })
  expect(state.coverage).toMatchObject({ operationsRetained: 64, operationsEvicted: 6, loadedRetained: 32, loadedRejected: 1 })
  expect(state.operation?.availability).toBe('not-retained')
  expect(owner.inspect({ hostId: 'local', operationId: 'operation-69' }).operation?.availability).toBe('found')
})
it('uses actual candidate bytes with bounded old HTTP payloads and backpressure, refusing only the current excess', async () => {
  const root = await directory(), owner = new MobileAssetsOwner(), auth = author(root), server = await http(owner)
  const large = async (name: string, each: number) => {
    const dir = join(root, name); await mkdir(join(dir, 'assets'), { recursive: true })
    const files = [{ path: 'assets/a.js', bytes: each, digest: mobileHash(Buffer.alloc(each, 97)) },
      { path: 'assets/b.js', bytes: each, digest: mobileHash(Buffer.alloc(each, 98)) },
      { path: 'index.html', bytes: 15, digest: mobileHash('<!doctype html>') }]
    await writeFile(join(dir, 'assets/a.js'), Buffer.alloc(each, 97)); await writeFile(join(dir, 'assets/b.js'), Buffer.alloc(each, 98)); await writeFile(join(dir, 'index.html'), '<!doctype html>')
    const body = { schema: 'agentmux.mobile-web-release.v1', buildId: name, files }, manifest = { ...body, digest: mobileHash(JSON.stringify(body)) }
    await writeFile(join(dir, 'mobile-release.json'), JSON.stringify(manifest)); return manifest
  }
  let revision = 0
  const publish = async (manifest: Awaited<ReturnType<typeof large>>) => {
    const result = await owner.activate({ hostId: 'local', operationId: manifest.buildId, candidatePath: manifest.buildId, candidateDigest: manifest.digest, expectedActiveRevision: revision }, auth)
    if (result.status === 'active') revision++; return result
  }
  const hold = async (buildId: string, digest: string) => {
    const before = (owner as any).responseCount
    const socket = createConnection({ host: '127.0.0.1', port: server.port }); socket.pause()
    await new Promise<void>(done => socket.once('connect', done)); socket.write('GET /mobile/' + buildId + '/' + digest.slice(7) + '/assets/a.js HTTP/1.1\r\nHost: localhost\r\n\r\n')
    cleanup.push(async () => { socket.destroy() })
    const deadline = Date.now() + 3000
    while ((owner as any).responseCount !== before + 1) { if (Date.now() > deadline) throw Error('Private HTTP never retained actual pending response'); await new Promise(done => setTimeout(done, 5)) }
  }
  const a = await large('large-a', 15 * 1024 * 1024); expect((await publish(a)).status).toBe('active'); await hold(a.buildId, a.digest)
  const b = await large('large-b', 15 * 1024 * 1024); expect((await publish(b)).status).toBe('active'); await hold(b.buildId, b.digest)
  const c = await large('large-c', 10 * 1024 * 1024); expect((await publish(c)).status).toBe('active')
  expect((owner as any).payloadBytes()).toBeGreaterThan(80 * 1024 * 1024)
  const d = await large('small-d', 512 * 1024); expect((await publish(d)).status).toBe('active')
  for (let index = 0; index < 6; index++) await hold(c.buildId, c.digest)
  expect((owner as any).responseCount).toBe(8)
  expect((await fetch(server.origin + '/mobile/' + c.buildId + '/' + c.digest.slice(7) + '/assets/a.js')).status).toBe(503)
  // The same complete loader enforces remaining capacity before allocating file payloads.
  await expect(loadMobileSnapshot(join(root, 'large-a'), a.digest, 1024)).rejects.toThrow('remaining payload budget')
  expect((owner as any).payloadBytes()).toBeLessThanOrEqual(96 * 1024 * 1024)
})
