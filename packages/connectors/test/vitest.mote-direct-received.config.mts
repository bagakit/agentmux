import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = native.root!
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/mote-direct-received'), plugins: [{
  name: 'direct-received-runtime-source', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let loaded = original, mutation: string | undefined
    if (process.env.DIRECT_RECEIVED_MUTANT && path === 'packages/connectors/src/connection-services.ts') {
      if (process.env.DIRECT_RECEIVED_MUTANT !== 'direct-callback') throw Error('Unknown direct received mutation')
      const before = 'publication?.receiveQuery(binding, record, () => moteChat.hasAdmission(record.ingressId, binding.bindingId, record.actor))'
      if (original.split(before).length !== 2) throw Error('Exact original direct callback must occur once')
      loaded = original.replace(before, 'void 0'); mutation = 'direct-callback'
    }
    if (process.env.DIRECT_RECEIVED_LOADED && path.endsWith('.ts') && /^(packages\/(core|connectors)\/src|apps\/host\/src)\//u.test(path)) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(mutation ? { mutation } : {}) }
      return { code: "import { appendFileSync as __directReceivedLoaded } from 'node:fs'; __directReceivedLoaded(" + JSON.stringify(process.env.DIRECT_RECEIVED_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (mutation) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: ['packages/connectors/test/mote-chat-received.integration.test.ts'] } })
