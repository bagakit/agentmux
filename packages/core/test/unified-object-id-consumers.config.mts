import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'message-owner': ['packages/core/src/agent-global-message-queue.ts', 'input.messageId ?? mintObjectId()', "input.messageId ?? 'legacy-message-identity'"],
  'demand-owner': ['packages/demand/src/demand-store.ts', 'const id = input.id ?? mintObjectId()', "const id = input.id ?? 'legacy-demand-identity'"],
  'delivery-legacy-reader': ['packages/core/src/delivery-attempt.ts', "return isObjectId(value) || typeof value === 'string'", "return isObjectId(value) || false && typeof value === 'string'"],
  'loop-owner': ['packages/core/src/continuous-progress-scheduler.ts', 'options.id ?? mintObjectId', "options.id ?? (() => 'legacy-loop-identity')"]
}
export default defineConfig({ root,
  resolve: { alias: { '@agentmux/identity': resolve(root, 'packages/identity/src/index.ts') } },
  plugins: [{ name: 'actual-object-id-consumer-mutation', enforce: 'pre', transform(source, id) {
    if (id.includes('?')) return
    const path = relative(root, id), selected = process.env.AMUX_OBJECT_CONSUMER_MUTATION
    if (!/^packages\/(core|demand|identity)\/(src|test)\//.test(path)) return
    if (selected && !mutations[selected]) throw new Error('Unknown object consumer mutation')
    const change = selected && mutations[selected]
    let code = source
    if (change && path === change[0]) {
      if (source.split(change[1]).length !== 2) throw new Error('Object consumer mutation anchor not unique')
      code = source.replace(change[1], change[2])
    }
    if (process.env.AMUX_OBJECT_CONSUMER_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AMUX_OBJECT_CONSUMER_LOADED, JSON.stringify({ path, sourceSHA: hash(source), loadedSHA: hash(code), mutation: code === source ? null : selected }) + '\n')
    }
    if (code !== source) return { code, map: null }
  } }],
  test: { include: ['packages/core/test/unified-object-id-consumers.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 30000 }
})
