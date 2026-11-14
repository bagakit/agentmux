import base from './conversation-history-grouping.config.mts'
import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-detail-level', plugins: [...base.plugins!, {
  name: 'detail-level-actual-source', enforce: 'pre', transform(source, file) {
    if (!file.includes('/packages/client-ui/src/')) return
    let loaded = source
    const mutation = process.env.AGENTMUX_DETAIL_LEVEL_MUTANT === '1' && file.endsWith('/lib/conversation-detail-level.ts')
    if (mutation) {
      const before = "native?.item.recordPurpose === 'system-event'"
      assert.equal(source.split(before).length, 2); loaded = source.replace(before, 'false')
    }
    if (process.env.AGENTMUX_DETAIL_LOAD_LOG) appendFileSync(process.env.AGENTMUX_DETAIL_LOAD_LOG, JSON.stringify({
      file, originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'), mutation }) + '\n')
    if (mutation) return { code: loaded, map: null }
  }
}], test: { ...base.test,
  include: ['packages/client-ui/test/conversation-detail-level.test.tsx'], passWithNoTests: false } })
