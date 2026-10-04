import { fixturePath } from './helpers/fixture-values.js'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const aliases = ['core', 'demand', 'relay'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: resolve(root, 'packages', name, value.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
  }))
})
const changes: Record<string, [string, string, string]> = {
  'lose-prepared': ['packages/core/src/agent-session-store.ts', "reservation.kind === 'create' && (reservation.preparedCreation", "false && (reservation.preparedCreation"],
  'lose-queued': ['packages/core/src/agent-global-message-queue.ts', 'return messageId ? structuredClone(this.messages.get(messageId)!) : null', 'return null'],
  'skip-core-resolution': ['packages/core/src/client.ts', '? await this.resolveAgentCreationSessionId(createOperationId)', '? await deriveAgentSessionId(createOperationId)'],
  'skip-hosted-offline': ['packages/core/src/hosted-runtime-service.ts', "'readDeliveryAttempt', 'resolveAgentCreationSessionId',", "'readDeliveryAttempt',"],
  'skip-desktop-resolution': ['apps/desktop/src/main/runtime-controller.ts', 'await client.resolveAgentCreationSessionId(hostIntent.createOperationId!)', "'mutated-new-session'"]
}
function loaded(source: string, path: string): string {
  let code = source
  const mutation = process.env.AMX_CREATION_ID_MUTATION, change = mutation && changes[mutation]
  if (mutation && !change) throw new Error('Unknown creation identity mutant')
  if (change && path === change[0]) {
    if (source.split(change[1]).length !== 2) throw new Error('Creation identity mutation anchor is not unique: ' + mutation)
    code = source.replace(change[1], change[2])
  }
  if (process.env.AMX_CREATION_ID_LOADED) appendFileSync(process.env.AMX_CREATION_ID_LOADED, JSON.stringify({ path,
    originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'),
    ...(code !== source ? { mutation } : {}) }) + '\n')
  return code
}
export default defineConfig({ root, resolve: { alias: aliases }, plugins: [{ name: 'actual-creation-identity-source', enforce: 'pre',
  load(id) {
    if (id.endsWith("/apps/desktop/src/main/runtime-controller.ts?raw")) {
      const path = relative(root, id.slice(0, -4))
      return `export default ${JSON.stringify(loaded(readFileSync(id.slice(0, -4), 'utf8'), path))}`
    }
  },
  transform(source, id) {
    if (id.includes('?')) return
    const path = relative(root, id)
    if (!/^packages\/(?:core|demand|relay)\/src\//.test(path) && path !== 'packages/core/test/agent-creation-operation-identity.test.ts') return
    const code = loaded(source, path)
    if (code !== source) return { code, map: null }
  }
}], test: { include: ['packages/core/test/agent-creation-operation-identity.test.ts'], passWithNoTests: false,
  fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 } })
