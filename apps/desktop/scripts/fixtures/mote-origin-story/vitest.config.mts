import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_MOTE_STORY_EVIDENCE!
assert.ok(evidence, 'Evidence directory is required')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_MOTE_STORY_MUTANT
const edits: Record<string, [string, string, string]> = {
  switch: ['MoteOriginStory.tsx', 'onClick={() => setSelected(index)}', 'onClick={() => setSelected(0)}'],
  consumer: ['MoteDirectorySettingsPane.tsx', '<MoteOriginStory />', '{null}'],
}
assert.ok(!mutant || edits[mutant], 'Only declared source mutations are allowed')
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'mote-story-original-consumer', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (!mutant || !id.endsWith('/components/settings/' + edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      const count = input.split(before).length - 1
      assert.equal(count, 1, 'The production mutation anchor is unique')
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, id, count }) + '\n')
      return { code: input.replace(before, after), map: null }
    } }],
  test: { include: ['apps/desktop/test/mote-origin-story.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
