import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.AGENTMUX_CONNECTION_LINK_MUTANT, report = process.env.AGENTMUX_CONNECTION_LINK_LOADED
const codec = 'packages/relay/src/connection-offer.ts', labels = 'apps/host/src/mobile-link-candidates.ts'
const variants: Record<string, { file: string; before: string; after: string }> = {
  'offer-damage-as-absent': { file: codec, before: '/^A[g-z0-9_-]/.test(fragment)', after: '/^A[A-Za-z0-9_-]{40,}$/.test(fragment)' },
  'legacy-as-absent': { file: codec, before: "fragment.startsWith('offer=') || ", after: '' },
  'offer-frame-too-short': { file: codec, before: 'const MAX_FRAGMENT = Math.ceil((1 + KEY_BYTES + 1 + 160 + 1 + 255) / 3) * 4', after: 'const MAX_FRAGMENT = 512' },
  'offer-ascii-only': { file: codec, before: "const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)", after: "if (bytes.some(byte => byte > 0x7e)) throw new Error('Invalid connection link.'); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)" },
  'query-absent-label-again': { file: labels, before: 'known!.has(name) || checked.has(name)', after: 'known!.has(name)' }
}
if (mutant && !variants[mutant]) throw new Error('Unknown connection-link mutation')
const aliases = Object.fromEntries(['core', 'relay', 'identity'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), 'utf8'))
  return Object.entries(manifest.exports).flatMap(([key, value]: [string, any]) => key.includes('*') ? [] :
    [[`@agentmux/${name}${key === '.' ? '' : key.slice(1)}`, resolve(root, `packages/${name}/src`, value.import.slice(7).replace(/\.js$/u, '.ts'))]])
}))
aliases['@agentmux/identity/runtime-source'] = resolve(root, 'packages/identity/dist/runtime-source.js')
aliases.react = resolve(root, 'apps/mobile/node_modules/react')
aliases['react-dom'] = resolve(root, 'apps/mobile/node_modules/react-dom')
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/connection-link', mutant ?? 'normal'),
  resolve: { alias: Object.entries(aliases).sort(([left], [right]) => right.length - left.length).map(([find, replacement]) => ({ find, replacement })),
    conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  plugins: [react(), { name: 'loaded-connection-link-source', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (![codec, labels, 'apps/host/src/host.ts', 'packages/core/src/device-administration.ts', 'packages/core/src/public-rpc-client.ts',
      'apps/mobile/src/main.tsx', 'apps/mobile/src/connection/MobileConnectionRoot.tsx'].includes(file)) return
    const variant = mutant ? variants[mutant] : undefined
    let loaded = original
    if (variant?.file === file) {
      if (original.split(variant.before).length !== 2) throw new Error('Connection-link mutation anchor must occur once: ' + mutant)
      loaded = original.replace(variant.before, variant.after)
    }
    if (report) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(report, JSON.stringify({ file, sourceSHA256: sha(original), loadedSHA256: sha(loaded), mutation: variant?.file === file ? mutant : null }) + '\n')
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  } }],
  test: { include: ['packages/relay/test/connection-offer.test.ts', 'apps/host/test/mobile-link-label-cache.test.ts', 'apps/mobile/test/connection-link-entry.test.tsx'],
    setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts')], environment: 'happy-dom',
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, restoreMocks: true }
})
