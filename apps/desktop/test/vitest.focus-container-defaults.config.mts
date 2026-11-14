import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.focus-zone-organization.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'project-default': ['shared/focus-zone-presentation.ts', "kind === 'project' ? 'cards'", "kind === 'project' ? 'sections'"],
  'topic-default': ['shared/focus-preferences.ts', "return value === 'cards' ? 'cards' : 'sections'", "return value === 'sections' ? 'sections' : 'cards'"],
  'public-default': ['main/settings/modules/focus.ts', "FOCUS_TOPIC_PRESENTATIONS, resolveFocusTopicPresentation(undefined)", "FOCUS_TOPIC_PRESENTATIONS, 'cards'"]
} as const
const selected = process.env.AGENTMUX_FOCUS_DEFAULTS_MUTANT as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown Focus container defaults mutation')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const owners = new Set(['shared/focus-preferences.ts', 'shared/focus-zone-presentation.ts', 'main/settings/modules/focus.ts',
  'renderer/src/components/FocusProjectLanes.tsx', 'renderer/src/components/FocusProjectPreferences.tsx', 'renderer/src/components/FocusScanLaneContent.tsx',
  'renderer/src/components/settings/FocusSettingsPreview.tsx', 'renderer/src/components/settings/FocusSettingsPane.tsx'])
let applied = false
export default defineConfig({ ...source, cacheDir: '.tmp/focus-container-defaults-cache',
  plugins: [...source.plugins ?? [], { name: 'actual-focus-container-defaults', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!), local = path.replace(/^apps\/desktop\/src\//, '')
    let code = original
    if (selected && local === mutations[selected][0]) {
      const [, before, after] = mutations[selected]
      if (code.split(before).length !== 2) throw Error('One exact defaults source anchor required')
      code = code.replace(before, after); applied = true
      process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    }
    if (process.env.AGENTMUX_FOCUS_DEFAULTS_LOADED && owners.has(local)) appendFileSync(process.env.AGENTMUX_FOCUS_DEFAULTS_LOADED,
      JSON.stringify({ path, original_sha256: sha(original), loaded_sha256: sha(code), mutant: code === original ? null : selected }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('Actual defaults mutation consumer was not loaded') } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-zone-organization.test.tsx', 'apps/desktop/test/focus-zone-organization-control.test.ts',
    'apps/desktop/test/focus-topic-presentation-settings.test.tsx', 'apps/desktop/test/focus-zone-footer.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
