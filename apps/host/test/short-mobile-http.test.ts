// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { MobileAssetsOwner } from '../src/mobile-assets-owner.js'
import { mobileHash } from './helpers/mobile-web-fixture.js'
import { mobileAssetNamespace, mobilePageNamespaceDigest } from '../../../packages/core/src/mobile-web-codec.js'
import { parseAgentMuxRpcDeviceParams } from '../../../packages/core/src/public-rpc-device.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('short immutable HTTP keeps the original full digest bytes and relative resources after another release becomes active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-short-http-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owner = new MobileAssetsOwner(), server = createServer(owner.route)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Private HTTP listener unavailable')
  const origin = 'http://127.0.0.1:' + address.port
  async function publish(name: string, revision: number) {
    const path = join(root, name); await mkdir(join(path, 'assets'), { recursive: true })
    const values = { 'index.html': '<!doctype html><link rel="stylesheet" href="./assets/app.css"><script type="module" src="./assets/app.js"></script>',
      'assets/app.js': 'new Worker(new URL("./worker.js",import.meta.url),{type:"module"});export default ' + JSON.stringify(name.repeat(1200)), 'assets/app.css': 'body{color:' + (name === 'A' ? 'red' : 'blue') + '}', 'assets/worker.js': 'postMessage(' + JSON.stringify(name) + ')' }
    const files = []
    for (const [file, bytes] of Object.entries(values)) { await writeFile(join(path, file), bytes); files.push({ path: file, bytes: Buffer.byteLength(bytes), digest: mobileHash(bytes) }) }
    files.sort((a,b) => a.path.localeCompare(b.path)); const body = { schema: 'agentmux.mobile-web-release.v1', buildId: 'build-' + name, files }, digest = mobileHash(JSON.stringify(body))
    await writeFile(join(path, 'mobile-release.json'), JSON.stringify({ ...body, digest }))
    expect((await owner.activate({ hostId: 'local', operationId: name, candidatePath: name, candidateDigest: digest, expectedActiveRevision: revision }, { hostId: 'local', agentSessionId: 'author', runId: 'original', workspacePath: root, assertCurrent: async () => {} })).status).toBe('active')
    return { digest, values }
  }
  const a = await publish('A',0), entry = await fetch(origin), page = new URL(entry.url)
  expect(page.pathname).toBe(mobileAssetNamespace(a.digest)); expect(page.pathname).toHaveLength(47)
  expect(entry.headers.get('cache-control')).toBe('no-store'); expect(mobilePageNamespaceDigest(page.pathname, 'build-A')).toBe(a.digest)
  const b = await publish('B',1); expect(b.digest).not.toBe(a.digest)
  for (const method of ['GET', 'HEAD']) {
    const alias = new URL('index.html?original=1', page), redirect = await fetch(alias, { method, redirect: 'manual' })
    expect(redirect.status).toBe(302); expect(redirect.headers.get('cache-control')).toBe('no-store')
    expect(redirect.headers.get('location')).toBe(page.pathname + '?original=1')
    const canonical = await fetch(alias, { method })
    expect(new URL(canonical.url).pathname).toBe(page.pathname)
    expect(canonical.headers.get('cache-control')).toBe('no-store')
    if (method === 'GET') expect(await canonical.text()).toBe(a.values['index.html'])
    const unsupported = await fetch(origin + '/mobile/build-A/' + a.digest.slice(7) + '/', { method })
    expect(unsupported.status).toBe(410); expect(unsupported.headers.get('content-type')).not.toContain('text/html')
    expect(unsupported.headers.get('cache-control')).toBe('no-store')
  }
  for (const [file, original] of Object.entries(a.values)) {
    const url = file === 'index.html' ? page : new URL('./' + file, page)
    const response = await fetch(url); expect(response.status).toBe(200)
    expect(await response.text(), 'old short namespace must keep original released bytes').toBe(original)
    expect(response.headers.get('cache-control')).toBe(file === 'index.html' ? 'no-store' : 'private, max-age=31536000, immutable')
    const legacy = origin + '/mobile/build-A/' + a.digest.slice(7) + '/' + file
    expect(await (await fetch(legacy)).text()).toBe(original)
  }
  const worker = new URL('./worker.js', new URL('./assets/app.js', page)); expect(await (await fetch(worker)).text()).toBe(a.values['assets/worker.js'])
  expect((await fetch(new URL('./assets/app.js', page), { method: 'HEAD' })).headers.get('content-type')).toContain('javascript')
  expect((await fetch(origin)).url).not.toBe(page.href)
})
it('the browser-safe public IPv4 predicate retains the original Node codec decisions', () => {
  for (const address of ['0.0.0.0','127.0.0.1','255.255.255.255','10.69.59.116','8.8.8.8','01.2.3.4','1.2.3','256.1.1.1','1.2.3.04','::1','1.2.3.4\n','1.2.3.4/24','0x7f.0.0.1','1.2.3.-1']) {
    let valid = true; try { parseAgentMuxRpcDeviceParams('device.link', { address }) } catch { valid = false }
    expect(valid, address).toBe(isIP(address) === 4)
  }
})
