import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source,
  // Keep UI preview leaves, while the three existing persistence consumers use
  // their shipping Desktop ports, as the Goal edit product proof does.
  plugins: [...(source.plugins ?? []), { name: 'original-desktop-user-document-owner', enforce: 'pre', transform(code, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts'].includes(path))
      return code.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
  } }],
  test: { ...source.test, include: ['apps/desktop/test/goal-plan-delivery-workflow.test.tsx'], setupFiles: [], globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 } })
