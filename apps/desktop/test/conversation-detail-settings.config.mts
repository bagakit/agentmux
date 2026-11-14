import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import base from './vitest.app-icon.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-detail-settings',
  plugins: [...base.plugins!, { name: 'detail-observation-mutation', enforce: 'pre', transform(source, file) {
    if (!file.includes('/src/')) return
    let loaded = source
    const mutation = process.env.AGENTMUX_DETAIL_WATCH_MUTANT === '1' && file.endsWith('/apps/host/src/theme-observation.ts')
    if (mutation) {
      const before = ' || !isDeepStrictEqual(a.conversationDetailLevel, b.conversationDetailLevel)'
      assert.equal(source.split(before).length, 2); loaded = source.replace(before, '')
      appendFileSync(process.env.AGENTMUX_DETAIL_MUTATION_LOG!, file + '\n')
    }
    if (process.env.AGENTMUX_DETAIL_LOAD_LOG) appendFileSync(process.env.AGENTMUX_DETAIL_LOAD_LOG, JSON.stringify({
      file, originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'), mutation }) + '\n')
    if (mutation) return { code: loaded, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/conversation-detail-settings.test.ts'], testTimeout: 30000, passWithNoTests: false } })
