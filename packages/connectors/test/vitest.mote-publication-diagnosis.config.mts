import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'

const root = native.root!, mutation = process.env.MOTE_PUBLICATION_DIAGNOSIS_MUTANT
if (mutation && mutation !== 'drop-publications') throw Error('Unknown private publication diagnosis mutation')
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/mote-publication-diagnosis'), plugins: [{
  name: 'private-publication-diagnosis-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:packages\/(?:core|connectors)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(path)) return
    let loaded = original
    if (mutation && path === 'packages/connectors/src/mote-chat-diagnosis.ts') {
      const from = 'report.publications = await Promise.all([...generations.values()].map(generation => publication(target, generation.row, generation.intakeKeys, owner.connections)))'
      if (original.split(from).length !== 2) throw Error('Expected the original generation publication projection')
      loaded = original.replace(from, 'report.publications = []')
    }
    const trace = process.env.MOTE_PUBLICATION_DIAGNOSIS_LOADED, sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (trace) appendFileSync(trace, JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : mutation }) + '\n')
    return loaded === original ? undefined : { code: loaded, map: null }
  }
}, ...native.plugins!], test: { ...native.test, include: [
  'packages/core/test/mote-chat-diagnosis.test.ts', 'packages/connectors/test/mote-chat-diagnosis.integration.test.ts',
  'packages/connectors/test/mote-chat-waiting.integration.test.ts'
] } })
