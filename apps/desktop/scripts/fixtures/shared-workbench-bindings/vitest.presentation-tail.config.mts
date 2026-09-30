import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root,
 plugins: [...original.plugins ?? [], { name: 'actual-owner-visibility-counter', enforce: 'pre',
 transform(source, id) {
  if (id.split('?')[0] !== resolve(root, 'apps/desktop/src/renderer/src/App.tsx')) return
  const anchor = 'visible={visible}', mutation = process.env.AGENTMUX_FOCUS_TAIL_MUTATION
  assert.equal(source.split(anchor).length - 1, 1, 'One actual App original-owner visibility caller')
  const code = mutation === 'original-owner-visible' ? source.replace(anchor, 'visible={mounted}') : source
  if (process.env.AGENTMUX_FOCUS_TAIL_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_TAIL_LOADED,
   JSON.stringify({path:'apps/desktop/src/renderer/src/App.tsx', sourceSHA256:createHash('sha256').update(source).digest('hex'),
    loadedSHA256:createHash('sha256').update(code).digest('hex'), mutated:code!==source})+'\n')
  if(code!==source) return {code, map:null}
 } }],
 test: { ...original.test, include: [
 'apps/desktop/test/focus-workbench-projection.test.tsx',
 'apps/desktop/test/workbench-focus-residency.test.tsx',
 'apps/desktop/test/focused-tab-workspace.test.tsx',
 'apps/desktop/test/focus-preview-header.test.tsx',
 'apps/desktop/test/session-history-entry-views.test.tsx',
 'apps/desktop/test/focus-terminal-recovery.test.tsx',
 'apps/desktop/test/topic-terminal-open-close.test.tsx',
 'apps/desktop/test/global-focus-surface.test.tsx'
 ], fileParallelism: false, passWithNoTests: false, maxWorkers: 1, testTimeout: 15000 }
})
