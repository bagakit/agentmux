import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.focus-project-appearance.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export const zoneOrganizationMutations = {
  'project-default': ['shared/focus-zone-presentation.ts', "kind === 'project' ? 'cards'", "kind === 'project' ? 'sections'"],
  'container-override': ['shared/focus-zone-presentation.ts', 'preferences?.find(item => item.key === key)?.presentation', 'preferences?.find(item => item.key !== key)?.presentation'],
  'mode-consumer': ['renderer/src/components/FocusScanLaneContent.tsx', 'const organization = lane.zonePresentation ?? topicPresentation', 'const organization = topicPresentation'],
  'container-delta': ['shared/config-edit.ts', 'live = index(actual), result = new Map(live)', 'live = index(actual), result = new Map(old)'],
  'portaled-draft': ['renderer/src/components/FocusProjectPreferences.tsx', "${open ? ' is-menu-open' : ''}", ''],
  'late-save': ['renderer/src/components/FocusProjectPreferences.tsx', 'if (generation.current !== token) return', 'if (false) return'],
  'multiple-zones': ['renderer/src/lib/focus-collection-lanes.ts', 'if (!held.some(item => item.id === heading.id)) held.push(heading)', 'held.splice(0, held.length, heading)']
} as const
const selected = process.env.AGENTMUX_FOCUS_ZONE_MUTANT as keyof typeof zoneOrganizationMutations | undefined
if (selected && !zoneOrganizationMutations[selected]) throw Error('Unknown Focus Zone organization source mutation')
const affected = new Set(['shared/focus-zone-presentation.ts', 'shared/focus-preferences.ts', 'shared/config-edit.ts', 'main/config-store.ts', 'main/settings/modules/focus.ts',
  'renderer/src/components/FocusProjectLanes.tsx', 'renderer/src/components/FocusScanLaneContent.tsx', 'renderer/src/components/FocusContextCards.tsx',
  'renderer/src/components/FocusProjectPreferences.tsx', 'renderer/src/lib/focus-collection-lanes.ts', 'renderer/src/components/GlobalFocusSurface.tsx'])
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
let applied = false
export default defineConfig({ ...source, cacheDir: '.tmp/focus-zone-organization-cache',
  resolve: { ...source.resolve, alias: [{ find: /^@agentmux\/browser(?:\/(.*))?$/, replacement: resolve(root, 'packages/browser/src/$1') }, ...source.resolve!.alias as []] },
  plugins: [...source.plugins ?? [], { name: 'actual-zone-organization-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!), local = path.replace(/^apps\/desktop\/src\//, '')
    let code = original
    if (selected && local === zoneOrganizationMutations[selected][0]) {
      const [, before, after] = zoneOrganizationMutations[selected]
      if (code.split(before).length !== 2) throw Error('One exact Zone source mutation anchor required')
      code = code.replace(before, after); applied = true; process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    }
    if (process.env.AGENTMUX_FOCUS_ZONE_LOADED && affected.has(local)) appendFileSync(process.env.AGENTMUX_FOCUS_ZONE_LOADED,
      JSON.stringify({ path, original_sha256: sha(original), loaded_sha256: sha(code), mutant: code === original ? null : selected }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual Zone mutation consumer was not loaded') } }],
  test: { ...source.test, include: selected === 'late-save' ? ['apps/desktop/test/focus-project-preferences-races.test.tsx'] : selected === 'portaled-draft' ? ['apps/desktop/test/focus-collection-layout.test.tsx'] : process.env.AGENTMUX_FOCUS_ZONE_ADJACENT
    ? ['apps/desktop/test/focus-project-preferences-races.test.tsx', 'apps/desktop/test/focus-project-appearance.test.tsx']
    : ['apps/desktop/test/focus-zone-organization.test.tsx', 'apps/desktop/test/focus-zone-organization-control.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
