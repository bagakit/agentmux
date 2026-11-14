import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-send-receipt-settings',
  plugins: [...base.plugins!, { name: 'actual-send-receipt-preferences', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!/^(apps\/(desktop|host|mobile)\/(src|test)\/|packages\/(client-ui|core)\/src\/)/u.test(file)) return
    let code = source
    const mutation = process.env.AGENTMUX_RECEIPTS_MUTATION === 'omit-confirmed-watch' && file === 'apps/host/src/theme-observation.ts'
    if (mutation) {
      const anchor = '\n    || !isDeepStrictEqual(a.conversationConfirmedSendReceipt, b.conversationConfirmedSendReceipt)'
      assert.equal(source.split(anchor).length, 2); code = source.replace(anchor, '')
    }
    if (process.env.AGENTMUX_RECEIPTS_LOADS) appendFileSync(process.env.AGENTMUX_RECEIPTS_LOADS, JSON.stringify({ file,
      sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation }) + '\n')
    if (mutation) return { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/conversation-send-receipt-settings.test.tsx'],
    setupFiles: ['apps/mobile/test/device-locks.ts'], testTimeout: 30000, passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
