import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './selection-field.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_SELECTION_EVIDENCE
assert.ok(evidence, 'Explicit SelectionField evidence directory')
const mutant = process.env.AGENTMUX_SELECTION_MUTANT ?? 'baseline'
const file = 'apps/desktop/src/renderer/src/components/SelectionField.tsx'
const edits = {
  'saved-inference': { before: "missingOptionLabel = 'Not in current options'", after: "missingOptionLabel = 'Saved selection · not in current options'" },
  'drop-description': { before: 'aria-describedby={describedByIds} aria-labelledby={labelledBy}', after: 'aria-describedby={descriptionId} aria-labelledby={labelledBy}' },
  'disable-missing': { before: '<Menu.RadioItem className="tab-context-menu__item selection-field__option" value={value} data-missing disabled={disabled}>', after: '<Menu.RadioItem className="tab-context-menu__item selection-field__option" value={value} data-missing disabled>' },
}
assert.ok(mutant === 'baseline' || edits[mutant], 'Known SelectionField mutation')
const sha = text => createHash('sha256').update(text).digest('hex')
mkdirSync(evidence, { recursive: true })

export default defineConfig({
  ...baseConfig,
  root,
  cacheDir: resolve(evidence, 'cache'),
  plugins: [...(baseConfig.plugins ?? []), {
    name: 'selection-field-loaded-source', enforce: 'pre',
    transform(input, id) {
      if (id.includes('?')) return
      const path = relative(root, id)
      if (path !== file) return
      const original = readFileSync(id, 'utf8')
      assert.equal(input, original, 'Actual SelectionField source before transform')
      let code = input, applied = false
      const edit = edits[mutant]
      if (edit) {
        assert.equal(code.split(edit.before).length, 2, 'One unique SelectionField mutation target')
        code = code.replace(edit.before, edit.after)
        applied = true
        const target = resolve(evidence, 'loaded-product', path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, code)
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(original), consumedSHA256: sha(code), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    },
  }],
  test: { ...baseConfig.test, include: ['apps/desktop/test/ui-selection-field.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 },
})
