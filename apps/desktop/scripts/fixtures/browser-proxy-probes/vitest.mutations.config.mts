import { fileURLToPath } from 'node:url'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import assert from 'node:assert/strict'
import { mergeConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const rootUrl = new URL('../../../../../', import.meta.url), root = fileURLToPath(rootUrl)
const manifest = JSON.parse(readFileSync(new URL('packages/core/package.json', rootUrl), 'utf8'))
const aliases = Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({ find: '@agentmux/core' + (key === '.' ? '' : key.slice(1)), replacement: fileURLToPath(new URL('packages/core/' + value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'), rootUrl)) })).sort((a, b) => b.find.length - a.find.length)
const mutations: Record<string, [string, string, string]> = {
  'omit-webrtc-readback': ['apps/desktop/src/main/browser-profile-network-control.ts', 'ports.profiles.sessions?.observeWebRtc?.(profileId)', 'undefined'],
  'authentication-reply': ['apps/desktop/src/main/browser-proxy-probe.ts', "return result[1] === 0 ? { status: 'authenticated'", "return true ? { status: 'authenticated'"],
  'credential-generation': ['apps/desktop/src/main/browser-profile-proxy-auth.ts', "sameProxy(ports.proxyOf(profileId), expected) && ports.configurationRevision?.(profileId) === expected.configurationRevision", "sameProxy(ports.proxyOf(profileId), expected)"],
  'configuration-token': ['apps/desktop/src/main/browser-profile-store.ts', "networkDiagnostics: original ? records.map(item => item.id === original.id ? diagnostic : item) : [...records, diagnostic] }, false)", "networkDiagnostics: original ? records.map(item => item.id === original.id ? diagnostic : item) : [...records, diagnostic] }, true)"],
  'gui-dispatch': ['apps/desktop/src/renderer/src/components/settings/ProfileNetworkDiagnostics.tsx', 'ports.probeProfileNetwork(profile.id, operationId)', "Promise.reject(new Error('Mutated production dispatch'))"],
  'bounded-exit-body': ['apps/desktop/src/main/browser-profile-exit-check.ts', 'if (bytes > BODY_LIMIT) { void reader.cancel().catch(() => {}); return undefined }', "if (bytes > BODY_LIMIT) { void reader.cancel().catch(() => {}); return plainAddress(new TextDecoder().decode(next.value.subarray(0, BODY_LIMIT))) }"]
}
export default mergeConfig(base, { root, resolve: { alias: aliases }, plugins: [{ name: 'proxy-probe-production-mutations', enforce: 'pre', transform(source, id) {
  const rel = relative(root, id.split('?')[0]), key = process.env.PROXY_PROBE_MUTATION, edit = key ? mutations[key] : undefined
  if (key) assert.ok(edit, 'Known production mutation')
  if (!edit || rel !== edit[0]) return
  assert.equal(source.split(edit[1]).length - 1, 1, 'Exactly one original production block')
  const code = source.replace(edit[1], edit[2])
  assert.ok(process.env.PROXY_PROBE_MUTATION_LOADED)
  appendFileSync(process.env.PROXY_PROBE_MUTATION_LOADED, JSON.stringify({ key, path: rel, originalSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex') }) + '\n')
  return { code, map: null }
} }], test: { cache: false, maxWorkers: 1, testTimeout: 20_000, hookTimeout: 30_000, passWithNoTests: false } })
