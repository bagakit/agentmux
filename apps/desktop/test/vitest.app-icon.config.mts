import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const edits: Record<string, [string, string, string]> = {
  brand: ['apps/desktop/src/renderer/src/components/BrandIcon.tsx', 'icon={icon}', 'icon={undefined}'],
  save: ['apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPane.tsx', 'next.appIcon = submittedIcon.value', 'next.appIcon = DEFAULT_APP_ICON'],
  schema: ['src/main/config-store.ts', 'appIcon: z.enum(APP_ICON_IDS).optional(),', ''],
  native: ['src/main/app-brand-icon.ts', 'apply(saved.appearance.appIcon)', 'apply(undefined)'],
  'native-issue': ['src/main/app-brand-icon.ts', 'issue = `The system App icon could not be updated.', 'void `The system App icon could not be updated.']
}
const mutant = process.env.AGENTMUX_APP_ICON_MUTANT
assert.ok(!mutant || edits[mutant], 'Only a declared source mutation runs')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'actual-app-icon-source', enforce: 'pre', resolveId: installedDependency,
    transform(source, file) {
      if (!mutant || !file.endsWith(edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(source.split(before).length, 2, 'One actual owning mutation anchor')
      if (process.env.AGENTMUX_APP_ICON_MUTATION_LOG) appendFileSync(process.env.AGENTMUX_APP_ICON_MUTATION_LOG, file + '\n')
      return { code: source.replace(before, after), map: null }
    } }],
  test: { include: ['apps/desktop/test/app-icon-choice.test.tsx', 'apps/desktop/test/app-icon-settings-control.test.ts',
    'apps/desktop/test/app-brand-icon.test.ts', 'apps/desktop/test/app-brand-icon-notice.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
