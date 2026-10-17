import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_WORKVIEW_EVIDENCE
assert.ok(evidence, 'The source-bound test needs an explicit evidence directory')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_WORKVIEW_MUTANT
const edits: Record<string, [string, string, string]> = {
  survey: ['BrowserStartPageSettings.tsx', '<h3>{draft.value.title}</h3>', '<h3>{resolveBrowserStartPage(config).title}</h3>'],
  mote: ['MoteDirectorySettingsPane.tsx', 'width: draft.value.avatarSize, height: draft.value.avatarSize', 'width: MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT, height: MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT'],
  notes: ['NotesSettingsPane.tsx', 'fontSize: valid ? fontSize : saved.fontSize', 'fontSize: saved.fontSize'],
  space: ['SpaceSettingsPane.tsx', 'draft.value.gitHistoryShowTime && <time>', 'true && <time>']
}
assert.ok(!mutant || edits[mutant], 'Only a declared owning-source mutation is supported')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'settings-workview-actual-owner', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (id.includes('?') || !id.startsWith(root + '/apps/desktop/src/')) return
      if (!mutant || !id.endsWith('/components/settings/' + edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(input, readFileSync(id, 'utf8'), 'The actual owner is loaded before transform')
      const count = input.split(before).length - 1
      assert.equal(count, 1, 'The owning mutation anchor is unique')
      const output = input.replace(before, after)
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, file: relative(root, id), count, original: sha(input), consumed: sha(output) }) + '\n')
      return { code: output, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-workview-polish.test.tsx', 'apps/desktop/test/settings-workflows.test.tsx', 'apps/desktop/test/focus-personalization-settings.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
