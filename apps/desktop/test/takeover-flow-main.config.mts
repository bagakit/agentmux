import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import source from './agent-takeover-source-owner.config.mts'

export default defineConfig({ ...source, define: { ...source.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  plugins: [...source.plugins ?? [], { name: 'takeover-flow-main-loaded-source', enforce: 'pre', transform(original, id) {
    const output = process.env.AGENT_TAKEOVER_FLOW_MAIN_LOADED
    const path = relative(source.root!, id.split('?')[0]!)
    if (output && ['apps/desktop/src/', 'apps/host/src/', 'packages/core/src/'].some(prefix => path.startsWith(prefix))) {
      const hash = createHash('sha256').update(original).digest('hex')
      appendFileSync(output, JSON.stringify({ path, originalSHA256: hash, loadedSHA256: hash }) + '\n')
    }
  } }], test: { ...source.test, include: ['apps/desktop/test/takeover-flow-main.test.tsx'],
    passWithNoTests: false, fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 } })
