import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_SETTINGS_HOME_EVIDENCE
assert.ok(evidence, 'The isolated test has an explicit evidence directory')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_SETTINGS_HOME_MUTANT
const edits: Record<string, [string, string, string]> = {
  disclosure: ['components/SettingsPanel.tsx', 'if (parent instanceof HTMLDetailsElement) parent.open = true', 'if (parent instanceof HTMLDetailsElement) void parent.open'],
  expanded: ['components/settings/SettingsSidebarNavigation.tsx', 'new Set(groups.map(group => group.id))', "new Set(['preferences'])"],
  entry: ['components/TopRowChrome.tsx', "settings.open('overview')", "settings.open('appearance')"],
  drafts: ['components/SettingsPanel.tsx', 'visited.map((pane)', "(active === 'overview' ? [] : [active]).map((pane)"],
  exact: ['App.tsx', 'initialSection={settingsRoute.section}', 'initialSection="overview"'],
  destination: ['components/settings/SettingsOverviewPane.tsx', 'onOpen(item.id)', "onOpen('general')"]
}
assert.ok(!mutant || edits[mutant], 'Only a declared owning-source mutation is supported')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'settings-home-actual-owner', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (id.includes('?') || !id.startsWith(root + '/apps/desktop/src/')) return
      if (!mutant || !id.endsWith('/src/renderer/src/' + edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(input, readFileSync(id, 'utf8'), 'The actual owner is loaded before transform')
      const count = input.split(before).length - 1
      assert.ok(count > 0, 'The owning mutation has nonempty source hits')
      if (mutant !== 'destination') assert.equal(count, 1, 'The owning mutation anchor is unique')
      const output = input.replaceAll(before, after)
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, file: relative(root, id), count,
        original: sha(input), consumed: sha(output) }) + '\n')
      return { code: output, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-overview.test.tsx', 'apps/desktop/test/settings-home.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
