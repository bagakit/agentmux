import { defineConfig } from 'vitest/config'
import shared from '../scripts/fixtures/settings-modules/vitest.config.mts'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

export const focusMapSettingsMutations = [
  { name: 'polygon-serializer', file: 'renderer/src/lib/collaboration-map-geometry.ts', before: "if (boundary === 'polygon')", after: 'if (false)', assertion: 'edits complete Map drafts with production preview geometry, keeps invalid input and restores only Map defaults' },
  { name: 'invalid-draft-save', file: 'renderer/src/components/settings/FocusSettingsPane.tsx', before: 'disabled={Boolean(mapIssue)}', after: 'disabled={false}', assertion: 'edits complete Map drafts with production preview geometry, keeps invalid input and restores only Map defaults' },
  { name: 'last-valid-preview', file: 'renderer/src/components/settings/FocusSettingsPane.tsx', before: 'mapPreviewLastValid={Boolean(mapIssue)}', after: 'mapPreviewLastValid={false}', assertion: 'edits complete Map drafts with production preview geometry, keeps invalid input and restores only Map defaults' },
  { name: 'map-draft-deep-equality', file: 'renderer/src/components/settings/FocusSettingsPane.tsx', before: 'resolveFocusPreferences(preferences), configValuesEqual', after: 'resolveFocusPreferences(preferences), Object.is', assertion: 'treats equivalent authored Map defaults as unchanged and actually previews compact status information' },
  { name: 'original-map-field-navigation', file: 'renderer/src/components/SettingsPanel.tsx', before: 'navigationRequest?.field ? { section: initialSection, target: navigationRequest.field, route } : null', after: 'null', assertion: 'opens the original Focus Map field without search and preserves the visited editor draft on return' },
  { name: 'aggregate-public-validation', file: 'main/settings/modules/focus-map.ts', before: 'const issue = focusMapPreferencesIssue(changed)', after: 'const issue = null', assertion: 'keeps invalid aggregate profiles, stale public paths and a failed durable save out of the published configuration' },
  { name: 'public-map-write', file: 'main/settings/modules/focus-map.ts', before: 'return write(current, changed)', after: 'return current', assertion: 'the actual CLI discovers, writes and reopens every active Map scalar through the public socket and durable owner' },
  { name: 'queued-active-fields', file: 'main/settings-control.ts', before: 'const saved = await owner.update(current => {\n    const settings = scalarSettings(current), setting = settings.find', after: 'const staleSettings = scalarSettings(owner.current)\n  const saved = await owner.update(current => {\n    const settings = staleSettings, setting = settings.find', assertion: 'reads one committed snapshot and resolves removed or newly admitted stage fields inside the original commit queue' },
] as const
const selected = process.env.AGENTMUX_FOCUS_MAP_SETTINGS_MUTATION, mutation = focusMapSettingsMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('A declared Map settings mutation is required')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let applied = false

export default defineConfig({ ...shared, cacheDir: '.cache/collaboration-map-settings', plugins: [...shared.plugins ?? [], {
  name: 'actual-focus-map-settings-source', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/')) return
    const target = mutation && file === 'apps/desktop/src/' + mutation.file
    let served = source
    if (target) {
      if (source.split(mutation.before).length !== 2) throw Error('One exact Map settings mutation owner is required')
      served = source.replace(mutation.before, mutation.after); applied = true
    }
    if (process.env.AGENTMUX_FOCUS_MAP_SETTINGS_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_MAP_SETTINGS_LOADED, JSON.stringify({ file, sourceSHA256: hash(source), servedSHA256: hash(served), mutation: target ? selected : null }) + '\n')
    return served === source ? undefined : { code: served, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual Map settings mutant was not loaded') }
}], test: { ...shared.test, pool: 'threads',
  include: ['apps/desktop/test/focus-map-preferences.test.ts', 'apps/desktop/test/focus-map-settings-control.test.ts',
    'apps/desktop/test/settings-modules-control.test.ts', 'apps/desktop/test/settings-preferences-control.test.ts',
    'apps/desktop/test/collaboration-map-settings-ui.test.tsx', 'apps/desktop/test/focus-personalization-settings.test.tsx',
    'apps/desktop/test/settings-field-discovery.test.tsx', 'apps/desktop/test/settings-search.test.ts',
    'apps/desktop/test/settings-control.test.ts', 'apps/desktop/test/settings-focus-control.test.ts', 'apps/desktop/test/settings-work-preferences-control.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000
} })
