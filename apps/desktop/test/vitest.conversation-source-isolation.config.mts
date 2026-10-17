import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base, cacheDir: '.cache/conversation-source-isolation-consumer', plugins: [...base.plugins ?? [], {
  name: 'source-isolation-consumer-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/conversation-reader.ts','packages/client-ui/src/lib/use-conversation-view.ts','apps/desktop/src/renderer/src/components/ActivityView.tsx',
      'apps/desktop/src/main/conversation-read-ipc.ts','apps/desktop/src/preload/conversation-read.ts','apps/desktop/src/renderer/src/lib/conversation-read-api.ts'].includes(path)) return
    if (process.env.AGENTMUX_ISOLATION_CONSUMER_LOADED) appendFileSync(process.env.AGENTMUX_ISOLATION_CONSUMER_LOADED,
      JSON.stringify({path, sha256: createHash('sha256').update(source).digest('hex')}) + '\n')
  }
}], test: { ...base.test,
  include: ['apps/desktop/test/conversation-source-isolation-consumer.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
