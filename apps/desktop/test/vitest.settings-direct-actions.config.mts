import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_SETTINGS_DIRECT_ACTIONS_EVIDENCE
assert.ok(evidence, 'An explicit evidence directory is required')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_SETTINGS_DIRECT_ACTIONS_MUTANT
const edits: Record<string, [string, string, string]> = {
  surveyClear: ['StartPageImageField.tsx', "change(''); choose.current?.focus()", 'choose.current?.focus()'],
  surveyLateRead: ['StartPageImageField.tsx', 'if (selected !== request.current) return', 'if (false) return'],
  surveyPreview: ['BrowserStartPageSettings.tsx', 'if (validBrowserStartPageImage(icon) && validBrowserStartPageImage(backgroundImage))', 'if (true)'],
  mobileScanCopies: ['DeviceManagementSettings.tsx', "if (action === 'scan')", 'if (false)'],
  mobileCopyReissues: ['DeviceManagementSettings.tsx', "action === 'copy' && url ? url : (await api.deviceManagement.link({})).url", '(await api.deviceManagement.link({})).url'],
  mobileLateLink: ['DeviceManagementSettings.tsx', 'if (epoch !== generation.current) return', 'if (false) return']
}
assert.ok(!mutant || edits[mutant], 'Only a declared owner mutation is supported')
const sha = (input: string) => createHash('sha256').update(input).digest('hex')
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'settings-direct-action-owner', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (!mutant || !id.endsWith('/components/settings/' + edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(input, readFileSync(id, 'utf8'))
      assert.equal(input.split(before).length - 1, 1, 'Exactly one actual owner anchor')
      const output = input.replace(before, after)
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, file: relative(root, id), original: sha(input), consumed: sha(output) }) + '\n')
      return { code: output, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-direct-actions.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
