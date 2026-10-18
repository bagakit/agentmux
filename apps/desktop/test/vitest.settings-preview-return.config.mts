import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_SETTINGS_PREVIEW_EVIDENCE
assert.ok(evidence, 'An explicit evidence directory is required')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_SETTINGS_PREVIEW_MUTANT
const edits: Record<string, [string, string, string]> = {
  focus: ['FocusSettingsPane.tsx', 'setScene(nextScene); preview.open(event.currentTarget)', 'setScene(nextScene)'],
  takeover: ['BrowserAgentControlSettingsPane.tsx', 'onClick={event => preview.open(event.currentTarget)}', 'onClick={() => {}}'],
  return: ['use-settings-preview-return.tsx', 'previous.pane.scrollTop = previous.scrollTop', 'previous.pane.scrollTop = 0'],
  destination: ['use-settings-preview-return.tsx', 'aria-label={`Back to ${returnLabel}`}', 'aria-label="Back"'],
}
assert.ok(!mutant || edits[mutant], 'Only a declared owner mutation is supported')
const sha = (input: string) => createHash('sha256').update(input).digest('hex')
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'settings-preview-return-owner', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (!mutant || !id.endsWith('/components/settings/' + edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(input, readFileSync(id, 'utf8'))
      assert.equal(input.split(before).length - 1, 1, 'Exactly one actual owner anchor')
      const output = input.replace(before, after)
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, file: relative(root, id), original: sha(input), consumed: sha(output) }) + '\n')
      return { code: output, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-preview-return.test.tsx', 'apps/desktop/test/focus-personalization-settings.test.tsx', 'apps/desktop/test/settings-browser-agent-control.test.tsx'],
    // This UI reading change does not alter the separately qualified public RPC worker.
    testNamePattern: /^(?!actual CLI reads and persists the same preferences through public RPC).+/u,
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 30000 }
})
