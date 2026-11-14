import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from '../../../apps/desktop/test/vitest.mote-context.config.mts'

const target = 'packages/core/src/public-rpc-service.ts'
const mutation = process.env.AGENTMUX_READER_START_MUTATION
if (mutation) assert.equal(mutation, 'unscoped-start', 'Known reader startup rollback')
export default defineConfig({
  root: source.root, resolve: source.resolve,
  cacheDir: resolve(source.root!, '.tmp/rpc-reader-start-isolation-' + (mutation ?? 'baseline')),
  plugins: [{ name: 'original-reader-start-loaded-proof', enforce: 'pre', transform(original, id) {
    if (relative(source.root!, id.split('?')[0]!) !== target) return
    let code = original
    if (mutation) {
      const anchor = '...(start ? { start: startReader } : {})'
      assert.equal(code.split(anchor).length - 1, 1, 'Unique current subscription start owner')
      code = code.replace(anchor, '...(start ? { start } : {})')
    }
    if (process.env.AGENTMUX_READER_START_LOADED) appendFileSync(process.env.AGENTMUX_READER_START_LOADED,
      JSON.stringify({ path: target, originalSHA256: createHash('sha256').update(original).digest('hex'),
        loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === original ? null : mutation }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { include: ['packages/core/test/rpc-reader-start-isolation.test.ts'], setupFiles: [], globalSetup: [],
    environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
