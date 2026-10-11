import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const changes: Record<string, [string, string, string]> = {
  'drop-consumer': ['apps/desktop/src/renderer/src/lib/conversation-consumer-observation.ts', 'consumers.set(id, read)', 'void read'],
  'drop-pending-frame': ['packages/client-ui/src/lib/use-conversation-view.ts', 'pending: current?.held ? current.snapshot : null', 'pending: null']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-consumer-observation', plugins: [...base.plugins ?? [], {
  name: 'conversation-consumer-observation-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!), mutation = process.env.AGENTMUX_CONSUMER_OBSERVATION_MUTATION
    let code = source
    const change = mutation ? changes[mutation] : null
    if (mutation && !change) throw Error('Unknown consumer observation mutation')
    if (change && path === change[0]) {
      if (source.split(change[1]).length !== 2) throw Error('Consumer mutation anchor must be unique')
      code = source.replace(change[1], change[2])
    }
    if (process.env.AGENTMUX_CONSUMER_OBSERVATION_LOADED && /(?:use-conversation-view|conversation-consumer-(?:observation|query)|control-api|client-observation)\.(?:ts|tsx)$/.test(path)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_CONSUMER_OBSERVATION_LOADED, JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code !== source ? { mutation } : {}) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-consumer-observation.test.tsx'], testTimeout: 20000, passWithNoTests: false } })
