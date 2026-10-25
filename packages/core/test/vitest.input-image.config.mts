import { defineConfig } from 'vitest/config'
import { resolve, dirname, relative } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const root = resolve(import.meta.dirname, '../../..')
const packages = new Map<string, { exports: Record<string, any>; keys: string[] }>()
const changes: Record<string, [string, string, string]> = {
  'drop-host-owner': ['apps/host/src/host.ts', 'inputResources: { inspect: identity => fileUploads.inspect(identity), read: (identity, maxBytes) => fileUploads.read?.(identity, maxBytes) ?? Promise.resolve(null) }, ', ''],
  'raw-publication': ['packages/connectors/src/publication-content.ts', "if (resolved?.kind === 'markdown') { value = resolved.text;", "if (false && resolved?.kind === 'markdown') { value = resolved.text;"],
  'replay-observed-image': ['packages/connectors/src/publication-store.ts', ' || sameImageEffect(prior.payload, body)', ''],
  'ignore-membership': ['packages/core/src/client.ts', "image.upload.revision !== input.revision || !inputImageMatches(image, key, body)", 'false'],
  'freeze-unavailable': ['packages/core/src/client.ts', "if (!this.inputResources || image.upload.byteLength > input.maxBytes)", "if (image.observation !== 'confirmed' || !this.inputResources || image.upload.byteLength > input.maxBytes)"],
  'drop-image-input': ['apps/desktop/src/renderer/src/store.ts', 'entry.browserInput?.capture.reference, entry.inputImages)', 'entry.browserInput?.capture.reference)']
}
export default defineConfig({ root, cacheDir: '.cache/pasted-image-sharing', define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, plugins: [{ name: 'input-image-source', enforce: 'pre',
  resolveId(source, importer) {
    if (source === '@discordjs/rest') return createRequire(resolve(root, 'packages/connectors/package.json')).resolve(source)
    if (source.startsWith('@agentmux/core') || source.startsWith('@agentmux/host') || source.startsWith('@agentmux/client-ui') || source.startsWith('@agentmux/connectors')) {
      const name = source.split('/')[1]!, base = name === 'host' ? 'apps/host' : 'packages/' + name
      let cached = packages.get(base)
      if (!cached) { const exports = JSON.parse(readFileSync(resolve(root, base, 'package.json'), 'utf8')).exports; cached = { exports, keys: Object.keys(exports).sort((a, b) => b.length - a.length) }; packages.set(base, cached) }
      const { exports } = cached
      const suffix = source.split('/').slice(2).join('/'), key = suffix ? './' + suffix : '.'
      const pattern = cached.keys.find(key => key.includes('*') && ('./' + suffix).startsWith(key.split('*')[0]!))
      const target = exports[key] ?? (pattern ? exports[pattern] : undefined)
      let entry = typeof target === 'string' ? target : name === 'client-ui' ? target?.browser ?? target?.import : target?.import ?? target?.default
      if (pattern && !exports[key] && entry) entry = entry.replace('*', key.slice(pattern.indexOf('*')))
      if (entry?.startsWith('./dist/')) return resolve(root, base, 'src', entry.slice(7).replace(/\.js$/u, '.ts'))
      if (entry?.startsWith('./src/')) return resolve(root, base, entry)
    }
    if (importer && source.startsWith('.')) { const path = resolve(dirname(importer), source); const m = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u); if (m) return resolve(root, 'packages/' + m[1] + '/src', m[2]! + '.ts') }
  },
  transform(code, id) {
    const path = relative(root, id.split('?')[0]!), mutation = process.env.AGENTMUX_TEST_IMAGE_MUTATION, change = mutation && changes[mutation]
    if (mutation && !change) throw Error('Unknown image mutation')
    if (!path.startsWith('packages/') && !path.startsWith('apps/')) return
    const original = code
    if (change && path === change[0]) { if (code.split(change[1]).length !== 2) throw Error('Image mutation anchor must be unique'); code = code.replace(change[1], change[2]) }
    if (process.env.AGENTMUX_TEST_IMAGE_LOADED) appendFileSync(process.env.AGENTMUX_TEST_IMAGE_LOADED, JSON.stringify({ path, sourceSHA: createHash('sha256').update(original).digest('hex'), loadedSHA: createHash('sha256').update(code).digest('hex'), transformed: original !== code }) + '\n')
    if (code !== original) return { code, map: null }
  }
}], test: { include: process.env.AGENTMUX_TEST_IMAGE_PUBLICATION === '1' ? ['apps/host/test/input-image-publication-consumer.test.ts'] : process.env.AGENTMUX_TEST_IMAGE_APP === '1' ? ['apps/desktop/test/agent-explicit-steer.test.tsx'] : process.env.AGENTMUX_TEST_IMAGE_HOST === '1' ? ['apps/host/test/input-image-consumer.test.ts'] : ['packages/core/test/agent-input-image.test.ts'], environment: 'node', globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 } })
