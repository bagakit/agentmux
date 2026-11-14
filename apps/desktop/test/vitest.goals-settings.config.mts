import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const ownerPaths = ['components/GoalsCommonActions.tsx', 'components/settings/ShortcutSettingsPane.tsx', 'components/settings/GoalsCommonActionsSettings.tsx',
  'components/settings/modules/prompts.tsx', 'components/settings/modules/goals.tsx', 'components/settings/GoalsSettingsPane.tsx',
  'lib/goals-common-actions.ts', 'lib/goals-common-actions-config.ts', 'components/settings/use-resource-drafts.ts',
  'components/settings/use-setting-draft.ts', 'components/settings/save-config-slice.ts'].map(path => 'apps/desktop/src/renderer/src/' + path)
const mutation = process.env.GOALS_SETTINGS_MUTATION ? JSON.parse(process.env.GOALS_SETTINGS_MUTATION) : null
export default { ...original, plugins: [...original.plugins ?? [], { name: 'Goals-Settings-original-owners', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!ownerPaths.includes(path)) return
    const hash = (text: string) => createHash('sha256').update(text).digest('hex'), originalSHA256 = hash(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw new Error('The Settings mutation must name one exact owner segment')
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    const output = process.env.GOALS_SETTINGS_LOADED
    if (!output) return source
    appendFileSync(output, '')
    const row = { path, originalSHA256, loadedSHA256: hash(source), ...(mutation?.path === path ? { mutant: mutation.id } : {}) }
    return `import {appendFileSync as __goalsSettingsLoaded} from 'node:fs'; __goalsSettingsLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: [
  'apps/desktop/test/goals-common-actions.test.tsx', 'apps/desktop/test/goals-page-maturity.test.tsx',
  'apps/desktop/test/settings-prompts-save.test.tsx', 'apps/desktop/test/settings-resources-draft.test.tsx',
  'apps/desktop/test/settings-workflows.test.tsx', 'apps/desktop/test/settings-save-feedback.test.tsx'
], passWithNoTests: false } }
