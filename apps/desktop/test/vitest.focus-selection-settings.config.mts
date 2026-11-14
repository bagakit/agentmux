import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const changes = {
  'default-normalization': ['apps/desktop/src/shared/config-edit.ts', 'selectionFillPercent: resolveFocusSelectionFillPercent,', 'selectionFillPercent: value => value,'],
  'public-accent-writer': ['apps/desktop/src/main/settings/modules/focus.ts', '...config.focus, selectionAccent }', '...config.focus, selectionAccent: DEFAULT_FOCUS_SELECTION_ACCENT }']
} as const
const selected = process.env.AGENTMUX_SELECTION_SETTINGS_MUTANT as keyof typeof changes | undefined
if (selected && !changes[selected]) throw Error('Unknown selection settings inverse')
const owners = new Set(['apps/desktop/src/shared/focus-preferences.ts', 'apps/desktop/src/shared/config-edit.ts', 'apps/desktop/src/main/config-store.ts',
  'apps/desktop/src/main/settings/modules/focus.ts', 'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/settings-control.ts'])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
let applied = false
export default defineConfig({ ...source, cacheDir: '.tmp/focus-selection-settings-cache',
  resolve: { ...source.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...source.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  plugins: [...source.plugins ?? [], { name: 'actual-selection-settings-owner', enforce: 'pre', transform(original, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    let code = original
    if (selected && path === changes[selected][0]) {
      const [, before, after] = changes[selected]
      if (code.split(before).length !== 2) throw Error('One exact loaded selection settings inverse anchor required')
      code = code.replace(before, after); applied = true; process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    }
    if (process.env.AGENTMUX_SELECTION_SETTINGS_LOADED && owners.has(path)) appendFileSync(process.env.AGENTMUX_SELECTION_SETTINGS_LOADED,
      JSON.stringify({ path, original_sha256: sha(original), loaded_sha256: sha(code), mutant: code === original ? null : selected }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The selected inverse did not reach its actual settings consumer') } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-selection-settings-control.test.ts', 'apps/desktop/test/focus-selection-settings-process.test.ts'],
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
