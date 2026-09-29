import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const output = process.env.AGENTMUX_PROMPT_MUTATION_EVIDENCE
assert.ok(output, 'The Source mutation verifier supplies one owned run directory')
mkdirSync(output, { recursive: true })
const paths = [
  'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/prompts.tsx',
  'apps/desktop/src/renderer/src/components/settings/ShortcutSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/LiquidSelectionSurface.tsx',
  'apps/desktop/src/renderer/src/components/ComposerTextarea.tsx',
  'apps/desktop/src/renderer/src/components/settings/use-resource-drafts.ts',
  'apps/desktop/src/main/config-owner.ts',
  'apps/desktop/src/main/runtime-config-transaction.ts'
]
const hash = (source: string | Buffer) => createHash('sha256').update(source).digest('hex')
const inputs = Object.fromEntries(paths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
writeFileSync(resolve(output, 'source-inputs.json'), JSON.stringify(inputs, null, 2) + '\n')

export default defineConfig({
  ...original,
  root,
  cacheDir: resolve(output, 'cache'),
  plugins: [{
    name: 'prompt-mutation-source-readback', enforce: 'pre',
    transform(source, id) {
      const file = relative(root, id.split('?')[0]!)
      if (!Object.hasOwn(inputs, file)) return
      assert.equal(hash(source), inputs[file], `Actual loaded Source changed: ${file}`)
      appendFileSync(resolve(output, 'loaded-source.jsonl'), JSON.stringify({ file, sha256: hash(source) }) + '\n')
    }
  }],
  test: {
    ...original.test,
    include: [
      'apps/desktop/test/settings-prompts-liquid.test.tsx',
      'apps/desktop/test/settings-prompts-library.test.tsx',
      'apps/desktop/test/settings-prompts-save.test.tsx',
      'apps/desktop/test/settings-prompts-source-mutations.test.tsx'
    ],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1
  }
})
