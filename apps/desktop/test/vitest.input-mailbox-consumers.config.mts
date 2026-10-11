import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
export default defineConfig({ ...base, cacheDir: '.cache/input-mailbox-consumers', plugins: [{
  name: 'original-mailbox-node-owners', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return
    const path = resolve(dirname(importer),source), match = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(import.meta.dirname,'../../../packages',match[1]!,'src',match[2]!+'.ts')
  }
}, ...base.plugins!], test: { ...base.test, include: ['apps/desktop/test/input-mailbox-consumers.test.tsx'] } })
