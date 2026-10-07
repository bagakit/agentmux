import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/components/ComposerPendingDelivery.tsx'
export default defineConfig({
  root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { conditions: ['browser'] },
  plugins: [{ name: 'pending-layout-actual-source', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, owner)) return
    const before = '}, [orderedOperationIds, currentIndex, editingId, suppressed, Boolean(notice)])'
    let loaded = process.env.AGENTMUX_PENDING_LAYOUT_BASELINE ? readFileSync(process.env.AGENTMUX_PENDING_LAYOUT_BASELINE, 'utf8') : source
    if (process.env.AGENTMUX_PENDING_LAYOUT_MUTANT === 'whole-queue') {
      assert.equal(source.split(before).length, 2, 'Unique actual geometry effect mutation')
      loaded = source.replace(before, '}, [queued, currentIndex, editingId, suppressed, Boolean(notice)])')
    }
    if (process.env.AGENTMUX_PENDING_LAYOUT_LOADS) appendFileSync(process.env.AGENTMUX_PENDING_LAYOUT_LOADS, JSON.stringify({ path: relative(root, id), sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'), transformed: source !== loaded }) + '\n')
    if (source !== loaded) return { code: loaded, map: null }
  } }],
  test: {
    include: [...(process.env.AGENTMUX_PENDING_LAYOUT_BASELINE ? [] : ['apps/desktop/test/composer-pending-layout-cost.test.tsx']), ...(process.env.AGENTMUX_PENDING_LAYOUT_MUTANT || process.env.AGENTMUX_PENDING_LAYOUT_OWNING_ONLY ? [] : ['apps/desktop/test/composer-pending-delivery.integration.test.tsx', 'apps/desktop/test/composer-pending-interaction-geometry.test.tsx'])],
    globalSetup: [resolve(root, 'vitest.dist-freshness.ts')], setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000
  }
})
