import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.continuity-projection.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const input = process.env.SESSION_PANE_RETENTION_INVERSE
  ? JSON.parse(readFileSync(process.env.SESSION_PANE_RETENTION_INVERSE, 'utf8')) : undefined
const mutations = input ? input.mutations ?? [input] : []
const sources = new Set([
  'apps/desktop/test/session-pane-retention.test.tsx',
  'apps/desktop/src/renderer/src/components/SessionPane.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
  'apps/desktop/src/renderer/src/components/AgentCurrentForkControls.tsx',
  'apps/desktop/src/renderer/src/components/AgentRegionHeader.tsx',
  'apps/desktop/src/renderer/src/components/AgentConnections.tsx',
  'apps/desktop/src/renderer/src/lib/use-agent-connector-menu.tsx',
  'apps/desktop/src/renderer/src/lib/use-composer-attachments.ts',
  'apps/desktop/src/renderer/src/lib/run-service-projection.ts',
  'apps/desktop/src/renderer/src/lib/use-observed-app-store.ts',
  'apps/desktop/src/renderer/src/lib/session-state.ts',
  'apps/desktop/src/renderer/src/store.ts',
  'packages/client-ui/src/lib/conversation-speaker.ts'
])
for (const mutation of mutations) if (!sources.has(mutation.file)) throw Error('Unknown Pane retention inverse owner: ' + mutation.file)

export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/session-pane-retention'), plugins: [{
  name: 'session-pane-retention-source-proof', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!sources.has(file)) return
    let code = original
    const applied: string[] = []
    for (const mutation of mutations) if (mutation.file === file) {
      if (code.split(mutation.before).length !== 2) throw Error('Inverse must match exactly one owning boundary: ' + mutation.name)
      code = code.replace(mutation.before, mutation.after)
      applied.push(mutation.name)
    }
    if (process.env.SESSION_PANE_RETENTION_LOADED) appendFileSync(process.env.SESSION_PANE_RETENTION_LOADED, JSON.stringify({
      file, sourceSHA256: createHash('sha256').update(original).digest('hex'),
      loadedSHA256: createHash('sha256').update(code).digest('hex'), ...(applied.length ? { inverses: applied } : {})
    }) + '\n')
    return code === original ? undefined : { code, map: null }
  }
}, ...base.plugins ?? []], test: { ...base.test, include: ['apps/desktop/test/session-pane-retention.test.tsx'],
  exclude: [], passWithNoTests: false, pool: 'forks', poolOptions: { forks: { execArgv: ['--expose-gc'] } }, testTimeout: 20000
} })
