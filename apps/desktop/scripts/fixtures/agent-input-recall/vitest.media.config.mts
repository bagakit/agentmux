import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import shared from '../workbench-identity/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...shared, cacheDir: resolve(root, '.tmp/agent-input-recall/media-cache'),
  plugins: [...shared.plugins ?? [], { name: 'actual-Agent-reading-images', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    let served = code
    if (path === 'apps/desktop/src/renderer/src/components/AgentReadingBody.tsx' && process.env.AGENT_RECALL_MEDIA_MUTATION) {
      const change = process.env.AGENT_RECALL_MEDIA_MUTATION === 'images' ? ['readOnly readOnlyImages', 'readOnly']
        : process.env.AGENT_RECALL_MEDIA_MUTATION === 'host' ? ['hostId: control.hostId, agentSessionId: control.agentSessionId', 'hostId: "neighbor-host", agentSessionId: control.agentSessionId'] : null
      if (!change || code.split(change[0]!).length !== 2) throw Error('One original media consumer required')
      served = code.replace(change[0]!, change[1]!)
    }
    if (process.env.AGENT_RECALL_MEDIA_LOADED && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/client-ui/src/'))) appendFileSync(process.env.AGENT_RECALL_MEDIA_LOADED,
      JSON.stringify({ path, sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: served !== code }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...shared.test, include: ['apps/desktop/test/agent-reading-images.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
