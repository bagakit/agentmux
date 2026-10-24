import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { MobileAssetsOwner } from '../src/mobile-assets-owner.js'
import { mobileHash, mobileRelease, mobileWebFixture } from './helpers/mobile-web-fixture.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-mobile-entry-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owner = new MobileAssetsOwner(), sockets = new Set<Socket>()
  // Turn a synchronous route regression into a bounded consumer assertion.
  const server = createServer((request, response) => {
    try { owner.route(request, response) }
    catch { response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end('Private route threw') }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Private HTTP address unavailable')
  const origin = 'http://127.0.0.1:' + address.port
  const authority = { hostId: 'local', agentSessionId: 'original-author', runId: 'original-run', workspacePath: root, assertCurrent: async () => {} }
  const publish = async (name: string, revision: number) => {
    const manifest = await mobileRelease(join(root, name), name, `document.body.dataset.build=${JSON.stringify(name)}`)
    expect((await owner.activate({ hostId: 'local', operationId: name, candidatePath: name, candidateDigest: manifest.digest,
      expectedActiveRevision: revision }, authority)).status).toBe('active')
    return manifest
  }
  return { owner, root, origin, port: address.port, publish }
}

it('recovers only an unretained namespace document while preserving current/previous bytes and resource failures', async () => {
  const f = await fixture()
  await f.publish('release-a', 0)
  const original = await fetch(f.origin), oldURL = original.url, oldAsset = new URL('./assets/app.js', oldURL).href
  await f.publish('release-b', 1)
  expect((await fetch(oldURL, { redirect: 'manual' })).status).toBe(200)
  const previous = await fetch(f.origin)
  await f.publish('release-c', 2)
  const current = await fetch(f.origin)
  expect((await fetch(previous.url, { redirect: 'manual' })).status).toBe(200)
  for (const method of ['GET', 'HEAD']) {
    const moved = await fetch(oldURL + '?view=conversation&keep=original', { method, redirect: 'manual' })
    expect(moved.status).toBe(302)
    expect(moved.headers.get('location')).toBe(new URL(current.url).pathname + '?view=conversation&keep=original')
    expect(moved.headers.get('cache-control')).toBe('no-store')
    expect(moved.headers.get('content-disposition')).toBeNull()
  }
  const unknownEntry = f.origin + '/mobile/never-published/' + 'a'.repeat(64) + '/index.html'
  expect((await fetch(unknownEntry, { redirect: 'manual' })).status).toBe(302)
  for (const build of ['%', '%00', 'a'.repeat(200), '%61', '%E4%ZZ']) {
    const malformed = await fetch(f.origin + '/mobile/' + build + '/' + 'a'.repeat(64) + '/index.html', { redirect: 'manual' })
    expect(malformed.status).toBe(410); expect(malformed.headers.get('location')).toBeNull()
  }
  for (const target of [oldAsset, oldURL.replace('/index.html', '/assets/style.css'), oldURL.replace('/index.html', '/other.html'), oldURL.replace('release-a', 'nested/build')]) {
    const result = await fetch(target, { redirect: 'manual' })
    expect(result.status).toBe(410); expect(result.headers.get('location')).toBeNull()
    expect(result.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
  }
  expect((await fetch(oldURL, { method: 'POST', redirect: 'manual' })).status).toBe(410)
  expect((await fetch(current.url)).headers.get('x-agentmux-mobile-build')).toBe('release-c')
  expect((await fetch(new URL('./assets/app.js', previous.url))).headers.get('x-agentmux-mobile-build')).toBe('release-b')
  const escaped = await f.publish('构建 /%标识', 3)
  const escapedURL = f.origin + '/mobile/' + encodeURIComponent(escaped.buildId) + '/' + escaped.digest.slice(7) + '/index.html'
  const encoded = await fetch(escapedURL, { redirect: 'manual' })
  expect(encoded.status).toBe(200)
  expect(encoded.headers.get('x-agentmux-mobile-build')).toBe(encodeURIComponent(escaped.buildId))
  const unknownEscaped = escapedURL.replace(escaped.digest.slice(7), 'a'.repeat(64))
  expect((await fetch(unknownEscaped, { redirect: 'manual' })).status).toBe(302)
  for (const [index, buildId] of ['x.y', '%', '...'].entries()) {
    const manifest = await mobileRelease(join(f.root, 'valid-' + index), buildId)
    expect((await f.owner.activate({ hostId: 'local', operationId: 'valid-' + index, candidatePath: 'valid-' + index,
      candidateDigest: manifest.digest, expectedActiveRevision: 4 + index }, { hostId: 'local', agentSessionId: 'original-author', runId: 'original-run', workspacePath: f.root, assertCurrent: async () => {} })).status).toBe('active')
    expect((await fetch(f.origin)).headers.get('x-agentmux-mobile-build')).toBe(encodeURIComponent(buildId))
  }
})

it('returns typed retryable HTML for an unavailable document without inventing an active release', async () => {
  const f = await fixture()
  for (const target of ['/', '/index.html', '/mobile/unknown/' + '0'.repeat(64) + '/index.html']) {
    const response = await fetch(f.origin + target, { redirect: 'manual' })
    expect(response.status).toBe(target.startsWith('/mobile/') ? 410 : 503)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("script-src 'sha256-")
    expect(await response.text()).toContain('id="retry"')
    expect(await (await fetch(f.origin + target, { method: 'HEAD' })).text()).toBe('')
  }
  expect(f.owner.inspect({ hostId: 'local' }).active).toBeNull()
  const unknown = await fetch(f.origin + '/unknown')
  expect(unknown.status).toBe(404); expect(unknown.headers.get('content-type')).toBe('text/plain; charset=utf-8')
})

it('rejects only an unaddressable candidate while keeping the original HTTP entry and candidate data', async () => {
  const f = await fixture(); await f.publish('original-valid', 0)
  for (const [index, buildId] of ['\ud800', '.', '..'].entries()) {
    const manifest = await mobileRelease(join(f.root, 'invalid-' + index), buildId)
    const result = await f.owner.activate({ hostId: 'local', operationId: 'invalid-' + index, candidatePath: 'invalid-' + index,
      candidateDigest: manifest.digest, expectedActiveRevision: 1 }, { hostId: 'local', agentSessionId: 'original-author', runId: 'original-run', workspacePath: f.root, assertCurrent: async () => {} })
    expect(result).toMatchObject({ status: 'rejected', reason: 'candidate-invalid', activeRevision: 1 })
    expect((await fetch(f.origin)).headers.get('x-agentmux-mobile-build')).toBe('original-valid')
    expect(JSON.parse(await readFile(join(f.root, 'invalid-' + index, 'mobile-release.json'), 'utf8')).buildId).toBe(buildId)
    const cold = new MobileAssetsOwner()
    await expect(cold.initialize(join(f.root, 'invalid-' + index))).rejects.toThrow()
    expect(cold.inspect({ hostId: 'local' }).active).toBeNull()
  }
})

it('keeps response saturation typed and retryable without replacing immutable script bytes', async () => {
  const f = await fixture(), dir = join(f.root, 'large')
  await mobileRelease(dir, 'large')
  const bytes = Buffer.alloc(8 * 1024 * 1024, 97)
  await writeFile(join(dir, 'assets/app.js'), bytes)
  const html = await readFile(join(dir, 'index.html'))
  const body = { schema: 'agentmux.mobile-web-release.v1', buildId: 'large', files: [
    { path: 'assets/app.js', bytes: bytes.length, digest: mobileHash(bytes) },
    { path: 'index.html', bytes: html.length, digest: mobileHash(html) }] }
  await writeFile(join(dir, 'mobile-release.json'), JSON.stringify({ ...body, digest: mobileHash(JSON.stringify(body)) }))
  await f.owner.initialize(dir)
  const document = await fetch(f.origin), resource = new URL('./assets/app.js', document.url)
  for (let index = 0; index < 8; index++) {
    const socket = createConnection({ host: '127.0.0.1', port: f.port }); socket.pause()
    cleanup.push(async () => { socket.destroy() })
    await new Promise<void>(done => socket.once('connect', done))
    socket.write('GET ' + resource.pathname + ' HTTP/1.1\r\nHost: localhost\r\n\r\n')
  }
  await expect.poll(() => (f.owner as any).responseCount).toBe(8)
  const page = await fetch(document.url), script = await fetch(resource)
  expect(page.status).toBe(503); expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(page.headers.get('retry-after')).toBe('1'); expect(await page.text()).toContain('重新尝试')
  expect(script.status).toBe(503); expect(script.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(script.headers.get('location')).toBeNull()
})

it('uses the real managed CLI and original Host HTTP route without changing the original healthy Run', async () => {
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const before = await f.client.statusAgent(f.session.agentSessionId), original = await fetch(f.info.origin)
  const env = { ...f.native.env, ...f.managedEnv }
  for (const [name, revision] of [['entry-one', 0], ['entry-two', 1]] as const) {
    const manifest = await mobileRelease(join(f.native.root, name), name)
    const result = await runCompiledObjectCli(['app', 'mobile', 'assets', 'activate', '--input', '-'], env, JSON.stringify({ hostId: 'local',
      operationId: name, candidatePath: name, candidateDigest: manifest.digest, expectedActiveRevision: revision }))
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result.status).toBe('active')
  }
  const recovered = await fetch(original.url)
  expect(recovered.status).toBe(200); expect(recovered.headers.get('x-agentmux-mobile-build')).toBe('entry-two')
  expect((await fetch(new URL('./assets/app.js', original.url))).status).toBe(410)
  const after = await f.client.statusAgent(f.session.agentSessionId)
  expect(after.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  for (const [index, buildId] of ['\ud800', '.', '..'].entries()) {
    const manifest = await mobileRelease(join(f.native.root, 'invalid-' + index), buildId)
    const result = await runCompiledObjectCli(['app', 'mobile', 'assets', 'activate', '--input', '-'], env, JSON.stringify({ hostId: 'local',
      operationId: 'invalid-' + index, candidatePath: 'invalid-' + index, candidateDigest: manifest.digest, expectedActiveRevision: 2 }))
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result).toMatchObject({ status: 'rejected', reason: 'candidate-invalid', activeRevision: 2 })
    expect(JSON.parse(await readFile(join(f.native.root, 'invalid-' + index, 'mobile-release.json'), 'utf8')).buildId).toBe(buildId)
    expect((await fetch(f.info.origin)).headers.get('x-agentmux-mobile-build')).toBe('entry-two')
    expect((await f.client.statusAgent(f.session.agentSessionId)).run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  }
})

it('keeps the actual cold Host and healthy Agent usable when the original mobile candidate cannot be addressed', async () => {
  const f = await mobileWebFixture({ initialBuildId: '\ud800' }); cleanup.push(f.close)
  expect(f.info.access).toMatchObject({ state: 'unavailable' })
  expect(f.info.access.message).toContain('原 Agent 会话可继续使用')
  expect((await f.client.statusAgent(f.session.agentSessionId)).run).toMatchObject({ runId: f.session.run.runId, state: 'running' })
  expect(JSON.parse(await readFile(join(f.native.env.AGENTMUX_STATE_DIRECTORY!, 'initial-mobile/mobile-release.json'), 'utf8')).buildId).toBe('\ud800')
  const result = await runCompiledObjectCli(['app', 'mobile', 'assets', 'inspect', '--input', '-'], { ...f.native.env, ...f.managedEnv }, JSON.stringify({ hostId: 'local' }))
  expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result.active).toBeNull()
})

it('retries the original browser URL and inherits fragments and same-Tab handoff storage through entry recovery', async () => {
  const f = await fixture(), output = process.env.MOBILE_ENTRY_BROWSER_EVIDENCE ?? join(f.root, 'browser')
  const env = { ...process.env, MOBILE_ENTRY_BROWSER_INPUT: JSON.stringify({ origin: f.origin, evidence: output }) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [resolve('apps/desktop/node_modules/electron/cli.js'), resolve('apps/host/test/fixtures/mobile-page-browser.cjs')],
    { env, stdio: ['pipe', 'pipe', 'pipe'] })
  cleanup.push(async () => { if (child.exitCode === null) child.kill('SIGTERM') })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  await expect.poll(() => stdout, { timeout: 15000 }).toContain('RECOVERY_READY')
  await f.publish('browser-a', 0); child.stdin.write('continue\n')
  await expect.poll(() => stdout, { timeout: 15000 }).toContain('ORIGINAL_LOADED')
  await f.publish('browser-b', 1); await f.publish('browser-c', 2); child.stdin.write('continue\n')
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done) })
  expect(code, stdout + '\n' + stderr).toBe(0)
  const result = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'))
  expect(result.passed).toBe(true); expect(result.downloads).toEqual([])
  expect(result.cases).toEqual(['retry-original-fragment', 'original-document-not-reloaded-by-publish', 'unretained-offer', 'unretained-update-handoff'])
})
