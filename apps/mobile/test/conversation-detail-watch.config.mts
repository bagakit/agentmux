import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

export default defineConfig({ ...base, cacheDir: '.cache/mobile-conversation-detail-watch',
  plugins: [...base.plugins!, { name: 'mobile-detail-watch-source', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!/^(?:apps\/(?:mobile|desktop|host)\/(?:src|test)\/|packages\/(?:client-ui|core)\/src\/)/u.test(file)) return
    const log = process.env.AGENTMUX_MOBILE_DETAIL_LOADS
    if (log) appendFileSync(log, JSON.stringify({ file, sha256: createHash('sha256').update(source).digest('hex'),
      sourceSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex') }) + '\n')
  } }], test: { ...base.test, include: ['apps/mobile/test/conversation-detail-watch.test.tsx'],
    setupFiles: ['apps/mobile/test/device-locks.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
