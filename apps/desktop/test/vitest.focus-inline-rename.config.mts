import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const legacySelectionGuard = process.env.AGENTMUX_FOCUS_LEGACY_NAME_ROUTE === '1'
const ignoreSupersedingEdit = process.env.AGENTMUX_FOCUS_IGNORE_SUPERSEDING_NAME === '1'
export default defineConfig({
  ...base,
  cacheDir: '.tmp/focus-inline-rename-vitest',
  plugins: [...base.plugins ?? [], {
    name: 'focus-inline-rename-mutations',
    enforce: 'pre',
    transform(source, id) {
      if (ignoreSupersedingEdit && id.endsWith('/apps/desktop/src/renderer/src/components/FocusAgentNameEdit.tsx')) {
        const comparison = 'result.nameRevision !== feedback.nameRevision'
        assert.equal(source.split(comparison).length, 2, 'One check for a later original name')
        process.stderr.write('FOCUS_CONFIRM_WITHOUT_REVISION_CHECK_LOADED\n')
        return source.replace(comparison, 'false')
      }
      if (!legacySelectionGuard || !id.endsWith('/apps/desktop/src/renderer/src/store.ts')) return
      const actual = "const result = await commitDisplayName(target, value, 'manual', expectedNameRevision)"
      assert.equal(source.split(actual).length, 2, 'One Focus display-name save owner')
      process.stderr.write('FOCUS_LEGACY_NAME_ROUTE_LOADED\n')
      return source.replace(actual, `const state = useAppStore.getState()
      const unavailable = state.activeWorkspaceId && originalSourceActionUnavailable(state, state.activeWorkspaceId, 'rename')
      if (unavailable) throw unavailable
      ${actual}`)
    }
  }],
  test: { ...base.test, include: [
    'apps/desktop/test/name-editor-owner-pending.test.tsx',
    'apps/desktop/test/name-editor-pending.test.tsx',
    'apps/desktop/test/focus-source-unification.test.tsx',
  ], maxWorkers: 1, fileParallelism: false, passWithNoTests: false },
})
