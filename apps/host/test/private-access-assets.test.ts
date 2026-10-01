import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPrivateMobileAssets } from '../src/private-access-assets.js'

const origin = 'https://192.168.1.20:7443', roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function build() {
  const path = await mkdtemp(join(tmpdir(), 'agentmux-private-assets-')); roots.push(path)
  await mkdir(join(path, 'assets'))
  await writeFile(join(path, 'index.html'), '<html><link href="./assets/index-candidate.css"><script type="module" src="./assets/index-candidate.js"></script></html>')
  await writeFile(join(path, 'assets/index-candidate.js'), 'globalThis.actualCandidate = true')
  await writeFile(join(path, 'assets/index-candidate.css'), 'body { color: white }')
  return path
}
const request = (path: string, method = 'GET', target = origin, host = new URL(target).host) =>
  new Request(`${target}${path}`, { method, headers: { Host: host } })

it('serves only the complete explicit build bytes at its real HTTPS origin and leaves RPC and unknown routes untouched', async () => {
  const path = await build(), assets = await loadPrivateMobileAssets(path, origin)
  expect(assets.buildDigest).toMatch(/^[a-f0-9]{64}$/u)
  expect((await loadPrivateMobileAssets(path, origin)).buildDigest).toBe(assets.buildDigest)
  const index = assets.route(request('/'))!
  expect(index.status).toBe(200); expect(index.headers.get('content-type')).toContain('text/html')
  expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(index.headers.get('cache-control')).toBe('no-store')
  expect(await index.text()).toContain('./assets/index-candidate.js')
  expect(await assets.route(request('/assets/index-candidate.js'))!.text()).toBe('globalThis.actualCandidate = true')
  expect(assets.route(request('/assets/index-candidate.css'))!.headers.get('content-type')).toContain('text/css')
  expect(assets.route(request('/index.html', 'HEAD'))!.body).toBeNull()
  for (const path of ['/src/main.tsx', '/.env', '/assets/index-candidate.js.map', '/unknown', '/_agentmux/device']) {
    expect(assets.route(request(path))).toBeNull()
  }
  expect(assets.route(request('/', 'POST'))).toBeNull()
  expect(assets.route(request('/assets/index-candidate.js?secret=forbidden'))).toBeNull()
  expect(assets.route(request('/', 'GET', 'https://192.168.1.21:7443'))).toBeNull()
  expect(assets.route(request('/', 'GET', origin, 'attacker.example'))).toBeNull()
})

it('keeps its selected immutable build and digest after disk edits instead of serving a mixed source candidate', async () => {
  const path = await build(), original = await loadPrivateMobileAssets(path, origin)
  await writeFile(join(path, 'assets/index-candidate.js'), 'globalThis.changedCandidate = true')
  const changed = await loadPrivateMobileAssets(path, origin)
  expect(changed.buildDigest).not.toBe(original.buildDigest)
  expect(await original.route(request('/assets/index-candidate.js'))!.text()).toBe('globalThis.actualCandidate = true')
  expect(await changed.route(request('/assets/index-candidate.js'))!.text()).toBe('globalThis.changedCandidate = true')
})

it('refuses missing, incomplete or development indexes and never exposes neighboring or symbolic files', async () => {
  const path = await build()
  await writeFile(join(path, 'index.html'), '<script type="module" src="/src/main.tsx"></script>')
  await expect(loadPrivateMobileAssets(path, origin)).rejects.toThrow('complete built assets')
  await writeFile(join(path, 'index.html'), '<script src="./assets/missing.js"></script>')
  await expect(loadPrivateMobileAssets(path, origin)).rejects.toThrow('complete built assets')
  await writeFile(join(path, 'index.html'), '<script src="./assets/index-candidate.js"></script>')
  const secret = join(path, 'neighbor-secret.key'); await writeFile(secret, 'never served')
  await rm(join(path, 'assets/index-candidate.js')); await symlink(secret, join(path, 'assets/index-candidate.js'))
  await expect(loadPrivateMobileAssets(path, origin)).rejects.toThrow('symbolic')
  await expect(loadPrivateMobileAssets(path, 'http://192.168.1.20:7443')).rejects.toThrow('HTTPS')
})
