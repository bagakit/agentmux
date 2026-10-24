import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutation = process.env.AGENTMUX_TEST_INPUT_WAIT_MUTATION
const proof = process.env.AGENTMUX_TEST_INPUT_WAIT_LOADED
export default defineConfig({ ...base, cacheDir: '.cache/input-mailbox-consumers', plugins: [{
  name: 'original-mailbox-node-owners', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return
    const path = resolve(dirname(importer),source), match = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(import.meta.dirname,'../../../packages',match[1]!,'src',match[2]!+'.ts')
  }, transform(source, id) {
    if (id.split('?')[0] !== resolve(import.meta.dirname, '../src/renderer/src/components/OriginalInputWaitingControl.tsx')) return
    let code = source
    if (mutation) {
      const original = 'const result = await api.sessions.stopInputWaiting(control, ref, cancelOperationId)'
      if (mutation !== 'disconnect-stop' || source.split(original).length !== 2) throw Error('Unknown or non-unique original input stop mutation')
      code = source.replace(original, "const result = { ref, cancelOperationId, outcome: 'stopped-before-dispatch' as const, at: 0 }")
    }
    if (proof) appendFileSync(proof, JSON.stringify({ path: 'apps/desktop/src/renderer/src/components/OriginalInputWaitingControl.tsx',
      sha256: createHash('sha256').update(code).digest('hex'), originalSHA256: createHash('sha256').update(source).digest('hex'), mutation: mutation ?? null }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}, ...base.plugins!], test: { ...base.test, include: ['apps/desktop/test/input-mailbox-consumers.test.tsx'] } })
