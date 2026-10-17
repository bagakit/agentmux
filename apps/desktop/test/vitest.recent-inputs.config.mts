import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/recent-inputs-cache'),
  plugins: [...base.plugins ?? [], { name: 'recent-inputs-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/') && !path.startsWith('apps/desktop/test/')) return
    let code = source
    const mutation = process.env.AGENTMUX_RECENT_INPUTS_MUTATION
    if (mutation && path === 'apps/desktop/src/renderer/src/components/AgentInputRecap.tsx') {
      const pair = mutation === 'freeze-placeholder' ? ['Boolean(reader.conversation.snapshot) && !reader.loading', 'true'] : null
      if (!pair || source.split(pair[0]!).length !== 2) throw Error('Unknown or non-unique recent inputs mutation')
      code = source.replace(pair[0]!, pair[1]!)
    }
    const log = process.env.AGENTMUX_RECENT_INPUTS_LOADED
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (log) appendFileSync(log, JSON.stringify({ path, sourceSha256: sha(source), loadedSha256: sha(code), mutated: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/agent-input-initial-frame.test.tsx', 'apps/desktop/test/agent-input-protected-cost.test.tsx',
    'apps/desktop/test/conversation-input-entity-recap.test.tsx'], passWithNoTests: false }
})
