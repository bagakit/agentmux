import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mobile-web.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'disable-compression': ['const compress = file.bytes.length >= 1024', 'const compress = false && file.bytes.length >= 1024'],
  'disable-cache': ["'Cache-Control': entry ? 'no-store' : 'private, max-age=31536000, immutable'", "'Cache-Control': 'no-store'"]
} as const
const mutation = process.env.MOBILE_ASSET_TRANSFER_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown mobile asset transfer mutation')
const owner = 'apps/host/src/mobile-assets-owner.ts'
const observed = new Set([owner, 'apps/host/src/mobile-assets.ts', 'apps/host/src/mobile-page-response.ts', 'apps/host/test/mobile-asset-transfer.test.ts'])
export default defineConfig({ ...original, cacheDir: resolve(root, '.tmp/mobile-asset-transfer-cache', mutation ?? 'baseline'),
  resolve: { alias: [{ find: '@agentmux/core/mobile-web-codec', replacement: resolve(root, 'packages/core/src/mobile-web-codec.ts') }] },
  plugins: [{ name: 'actual-mobile-asset-transfer', enforce: 'pre', transform(before, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!observed.has(file)) return
    let source = before
    if (file === owner && mutation) {
      const [anchor, replacement] = variants[mutation]
      if (source.split(anchor).length !== 2) throw Error('A transfer mutation must target exactly one original owner fence')
      source = source.replace(anchor, replacement)
    }
    const report = process.env.MOBILE_ASSET_TRANSFER_LOADED
    if (!report) throw Error('Original evaluated owner/test proof is required')
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const proof = { file, originalSHA256: sha(before), loadedSHA256: sha(source), mutation: mutation ?? null }
    return `import { appendFileSync as __transferLoaded } from 'node:fs'; __transferLoaded(${JSON.stringify(report)},JSON.stringify({...${JSON.stringify(proof)},pid:process.pid})+'\\n');\n` + source
  } }], test: { ...original.test, include: ['apps/host/test/mobile-asset-transfer.test.ts'], testTimeout: 30000, hookTimeout: 10000 } })
