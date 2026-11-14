import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const edits = {
  'wrong-runtime': ['settings/SettingsRuntimeVersions.tsx', 'const kernel = runtime?.ctxmux', 'const kernel = undefined'],
  'ignore-hidden': ['settings/SettingsRuntimeVersions.tsx', 'if (!active) return', 'if (false) return'],
  'drop-app-version': ['main/client-observation.ts', '...(owner.appVersion ? { appVersion: owner.appVersion } : {}),', '']
} as const
const mutant = process.env.AMUX_SETTINGS_VERSION_MUTATION as keyof typeof edits | undefined
assert.ok(!mutant || edits[mutant])

export default defineConfig({
  root,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: aliases },
  plugins: [{
    name: 'settings-runtime-version-owner', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (!mutant) return
      const [file, before, after] = edits[mutant]
      if (!id.endsWith('/' + file)) return
      assert.equal(input.split(before).length - 1, 1, 'Exactly one actual owner anchor')
      return { code: input.replace(before, after), map: null }
    }
  }],
  test: {
    include: ['apps/desktop/test/settings-runtime-versions.test.tsx', 'apps/desktop/test/loaded-identity-ipc.test.ts', 'apps/desktop/test/general-settings-diagnostics.test.tsx'],
    setupFiles: ['vitest.setup.ts'],
    maxWorkers: 1,
    passWithNoTests: false,
    testTimeout: 20_000
  }
})
