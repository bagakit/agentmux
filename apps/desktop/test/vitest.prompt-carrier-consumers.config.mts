import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const store = 'apps/desktop/src/renderer/src/store.ts'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base, cacheDir: '.cache/prompt-carrier-consumers',
  resolve: { ...base.resolve, alias: [{ find: /^@agentmux\/host\/(.+)$/, replacement: resolve(root, 'apps/host/src/$1.ts') }, ...(base.resolve?.alias as [])] }, plugins: [{
  name: 'actual-renderer-prompt-carrier-consumer', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, store)) return
    let code = source
    const mutation = process.env.AGENTMUX_PROMPT_CARRIER_UI_MUTATION
    if (mutation) {
      const anchor = '  const entry: AgentSteerQueueEntry = {'
      if (mutation !== 'restore-global-cap' || source.split(anchor).length !== 2) throw Error('Unknown or non-unique prompt carrier mutation')
      code = source.replace(anchor, `  if (new TextEncoder().encode(composeAgentPrompt(text, agentMuxNote, browserInput?.capture.record.inputContext).text).length > 65536) return false\n${anchor}`)
    }
    const proof = process.env.AGENTMUX_PROMPT_CARRIER_UI_LOADED
    if (proof) appendFileSync(proof, JSON.stringify({ path: store, mutation: mutation ?? null,
      sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}, ...base.plugins!], test: { ...base.test, environment: 'happy-dom', maxWorkers: 1,
  include: ['apps/desktop/test/agent-steer-queue.test.ts', 'apps/desktop/test/agent-steer-queue-management.test.tsx',
    'apps/desktop/test/composer-local-feedback.test.tsx', 'apps/desktop/test/demand-pmo-tab-context.test.ts'],
  testNamePattern: /complete inputs use the actual Core carrier boundary|mounted composer sends a complete|records the actual first accepted time|admits a context-only message|keeps complete context above the old cap/
} })
