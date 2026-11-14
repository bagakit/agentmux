import { defineConfig } from 'vitest/config'
import original from './a2a-resumed-inbox.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const mutation = process.env.MOTE_ROLLOVER_MUTATION
export default defineConfig({ ...original, plugins: [{ name: 'mote-rollover-reliability-source', enforce: 'pre', resolveId(id) {
  if (id === '@ctxmux/sdk') return fileURLToPath(import.meta.resolve(id))
}, transform(source, id) {
  const path = relative(original.root!, id.split('?')[0]!)
  if (!path.startsWith('packages/core/src/') && !path.startsWith('apps/host/src/')) return
  let loaded = source
  if (mutation && path === 'packages/core/src/public-rpc-service.ts') {
    const variants: Record<string, [string, string]> = {
      'skip-recovered': ["if(latest) {", "if(latest&&!latest.recoveryOperationId) {"],
      'recovered-old-key': ['inputKey=recoveredKey', 'inputKey=latest.key'],
      'recovered-author': ['launch.input.authorHuman!==true', 'false'],
      'recovered-previous-run': ['recovery.previousRun.runId!==latest.key.expectedRun.runId', 'false']
    }
    const pair = variants[mutation]; if (!pair) throw Error('Unknown exact rollover mutation')
    if (source.split(pair[0]).length !== 2) throw Error('Exact rollover production mutation missing or not unique: ' + mutation)
    loaded = source.replace(pair[0], pair[1])
  }
  if (process.env.MOTE_ROLLOVER_LOADED) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOTE_ROLLOVER_LOADED, JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(loaded !== source ? { mutation } : {}) }) + '\n')
  }
  return loaded === source ? null : { code: loaded, map: null }
} }, ...(original.plugins ?? [])], test: { ...original.test, include: ['apps/host/test/mote-rollover-reliability.test.ts', 'apps/host/test/mote-conversation-start.test.ts'],
  testNamePattern: process.env.MOTE_ROLLOVER_TEST_PATTERN ?? 'recover|rollover|unknown activity|changed policy', testTimeout: 45_000, maxWorkers: 1, passWithNoTests: false } })
