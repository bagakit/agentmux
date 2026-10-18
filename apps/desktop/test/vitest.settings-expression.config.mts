import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_SETTINGS_EXPRESSION_EVIDENCE
assert.ok(evidence, 'An explicit evidence directory is required')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_SETTINGS_EXPRESSION_MUTANT
const edits: Record<string, [string, string, string]> = {
  overview: ['SettingsOverviewPane.tsx', '<small title={item.savedSummary(config)}>{item.savedSummary(config)}</small>', '<small>{item.description}</small>'],
  profile: ['ProfileSettingsPane.tsx', "onClick={() => draft.setField('avatar', '')}", 'onClick={() => {}}'],
  general: ['GeneralSettingsPane.tsx', "data-path-format={draft.value.copyPathsAsAbsolute ? 'absolute' : 'abbreviated'}", "data-path-format={saved ? 'absolute' : 'abbreviated'}"],
  notification: ['NotificationSettingsPane.tsx', 'data-selected={tier.id === mode ? \'\' : undefined}', 'data-selected={tier.id === resolveNotificationModeId({ notifications }) ? \'\' : undefined}'],
  survey: ['BrowserStartPageSettings.tsx', 'if (validBrowserStartPageImage(icon) && validBrowserStartPageImage(backgroundImage))', 'if (true)']
}
assert.ok(!mutant || edits[mutant], 'Only a declared owner mutation is supported')
const sha = (input: string) => createHash('sha256').update(input).digest('hex')
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'settings-expression-owner', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (!mutant || !id.endsWith('/components/settings/' + edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(input, readFileSync(id, 'utf8'))
      assert.equal(input.split(before).length - 1, 1, 'Exactly one actual owner anchor')
      const output = input.replace(before, after)
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, file: relative(root, id),
        original: sha(input), consumed: sha(output) }) + '\n')
      return { code: output, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-expression.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
