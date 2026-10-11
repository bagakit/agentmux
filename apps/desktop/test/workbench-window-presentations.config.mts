import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'

const apiOwner = resolve(import.meta.dirname, '../src/renderer/src/lib/api.ts')

// Exercise the original native Browser presentation consumers with the maintained
// typed IO fixture. Native admission and actual WebContents have their own gate.
export default defineConfig({
  ...owning,
  define: { ...owning.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  plugins: [...(owning.plugins ?? []), {
    name: 'original-window-presentation-io', enforce: 'pre',
    transform(source, id) {
      if (id.split('?')[0] !== apiOwner) return
      const entry = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
      assert.equal(source.split(entry).length - 1, 1, 'One maintained typed API fixture seam')
      return { code: source.replace(entry, 'export const api = mockApi'), map: null }
    }
  }],
  test: {
    ...owning.test,
    include: ['test/workbench-window-presentations.test.tsx', 'test/stable-workbench-reading-transition.test.tsx', 'test/workbench-placement-confirmation.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10000
  }
})
