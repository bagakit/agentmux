import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'receipt-origin': ['packages/core/src/browser-profile-storage.ts', 'site.origin !== request.sites[index]!.origin ||', 'false ||'],
  'completed-ack': ['packages/core/src/browser-profile-storage.ts', "if (receipt.status === 'completed' && receipt.results.some(item => item.status !== 'acknowledged')) invalid()", '/* native ACK check removed */'],
  'operation-id': ['packages/core/src/rpc-business-codec.ts', 'isBrowserProfileStorageOperation(operation) || isBrowserProfileExtensionOperation(operation)', 'isBrowserProfileExtensionOperation(operation)']
}
const selected = process.env.AGENTMUX_STORAGE_PROTOCOL_MUTANT
if (selected && !mutations[selected]) throw new Error('Unknown storage protocol mutation')
let applied = false
export default defineConfig({ root, cacheDir: resolve(root, '.bagakit/feature-tracker/browser-offline-cache-management/protocol-cache', selected ?? 'baseline'),
  plugins: [{ name: 'storage-protocol-source-mutation', enforce: 'pre', transform(code, id) {
    if (!selected || relative(root, id.split('?')[0]!) !== mutations[selected]![0]) return
    const [, before, after] = mutations[selected]!
    if (code.split(before).length !== 2) throw new Error('Exact original protocol mutation anchor required')
    applied = true
    return { code: code.replace(before, after), map: null }
  }, buildEnd() { if (selected && !applied) throw new Error('Protocol mutation was not loaded') } }],
  test: { include: ['packages/core/test/browser-profile-storage.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
