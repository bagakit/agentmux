import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mobile-web.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/host/src/mobile-assets-owner.ts', response = 'apps/host/src/mobile-page-response.ts'
const codec = 'packages/core/src/mobile-web-codec.ts'
const assets = 'apps/host/src/mobile-assets.ts'
const mutations = {
  'no-entry-recovery': [owner, 'if (this.active) openCurrent()', 'if (false) openCurrent()'],
  'redirect-resources': [owner, 'const entry = isMobilePageEntry(path)', "const entry = path.startsWith('/mobile/') || isMobilePageEntry(path)"],
  'drop-query': [owner, "'index.html' + target.search", "'index.html'"],
  'replace-fragment': [owner, "'index.html' + target.search", "'index.html' + target.search + '#replaced'"],
  'download-document': [response, "'Content-Type': 'text/html; charset=utf-8'", "'Content-Type': 'application/octet-stream'"],
  'untyped-resource': [response, "'Content-Type': 'text/plain; charset=utf-8', ", ''],
  'accept-malformed-entry': [response, 'return isMobileBuildId(buildId) && encodeURIComponent(buildId) === segment', 'return true'],
  'reject-escaped-build': [response, 'return isMobileBuildId(buildId) && encodeURIComponent(buildId) === segment', 'return /^[A-Za-z0-9_-]+$/.test(buildId) && encodeURIComponent(buildId) === segment'],
  'unsafe-build-header': [owner, "'X-AgentMux-Mobile-Build': encodeURIComponent(snapshot.release.buildId)", "'X-AgentMux-Mobile-Build': snapshot.release.buildId"],
  'admit-dot-build': [assets, "if (segment === '.' || segment === '..') throw Error('Mobile build identity cannot address its original document')", "if (false) throw Error('Mobile build identity cannot address its original document')"],
  'admit-unencodable-build': [assets, 'const segment = encodeURIComponent(manifest.buildId)', "const segment = manifest.buildId"],
} as const
const mutant = process.env.MOBILE_ENTRY_MUTANT
if (mutant && !Object.hasOwn(mutations, mutant)) throw Error('Unknown mobile entry mutation')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export default defineConfig({ ...original, cacheDir: resolve(root, '.tmp/mobile-page-entry', mutant ?? 'normal'),
  resolve: { alias: [{ find: '@agentmux/core/mobile-web-codec', replacement: resolve(root, codec) }] },
  plugins: [{ name: 'mobile-entry-proof', enforce: 'pre', transform(before, id) {
    const file = id.split('?')[0], relative = [owner, response, codec, assets].find(path => file === resolve(root, path))
    if (!relative) return
    let source = before
    if (mutant) {
      const [target, anchor, replacement] = mutations[mutant as keyof typeof mutations]
      if (target === relative) { if (source.split(anchor).length !== 2) throw Error('Mutation must target one actual entry source'); source = source.replace(anchor, replacement) }
    }
    const report = process.env.MOBILE_ENTRY_LOADED
    if (!report) throw Error('Actual source-loaded proof path is required')
    const row = { path: relative, originalSHA256: hash(before), loadedSHA256: hash(source), mutation: mutant ?? null }
    return "import { appendFileSync as __entryProof } from 'node:fs'; __entryProof(" + JSON.stringify(report) + ',JSON.stringify({... ' + JSON.stringify(row) + ',pid:process.pid})+"\\n");\n' + source
  } }], test: { ...original.test, include: ['apps/host/test/mobile-page-entry.test.ts'], testTimeout: 45000 } })
