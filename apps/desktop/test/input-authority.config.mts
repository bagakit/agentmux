import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../vitest.config'

const baseline = process.env.AGENTMUX_CLIENT_BASELINE_SOURCE
const production = resolve('apps/desktop/src/renderer/src/lib/session-state.ts')
const loaded = new Map<string, { path: string; sha256: string; physicalSource?: string }>()
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function receipt() {
  const path = process.env.AGENTMUX_CLIENT_LOADED_RECEIPT
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ baselineSource: baseline ?? null, modules: [...loaded.values()] }, null, 2) + '\n')
}
export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'input-authority-loaded-source', enforce: 'pre',
    load(id) {
      if (baseline && id === production) return readFileSync(baseline, 'utf8')
      return null
    },
    transform(code, id) {
      if (/\/(?:apps|packages)\//.test(id) && !id.includes('/node_modules/') && !id.includes('?')) {
        loaded.set(id, { path: id, sha256: sha(code), ...(baseline && id === production ? { physicalSource: baseline } : {}) })
        receipt()
      }
      return null
    }
  }],
  test: { maxWorkers: 1, fileParallelism: false,
    include: ['apps/desktop/test/terminal-input-authority.integration.test.tsx',
      'apps/desktop/test/terminal-reveal.test.ts', 'apps/desktop/test/terminal-recovery.test.tsx',
      'apps/desktop/test/terminal-historical-protocol.test.ts',
      'apps/desktop/test/renderer-state-owners.test.ts'],
    ...(process.env.AGENTMUX_CLIENT_TEST_PATTERN ? { testNamePattern: process.env.AGENTMUX_CLIENT_TEST_PATTERN } : {})
  }
}))
