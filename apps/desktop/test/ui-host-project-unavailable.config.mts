import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './selection-field.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_EXECUTOR_EVIDENCE
assert.ok(evidence, 'Explicit Executor mutation evidence directory')
const mutant = process.env.AGENTMUX_EXECUTOR_MUTANT ?? 'baseline'
assert.ok(['baseline', 'unavailable-selected'].includes(mutant), 'Known Executor mutation')
const file = 'apps/desktop/src/renderer/src/components/AgentExecutorPicker.tsx'
const sha = text => createHash('sha256').update(text).digest('hex')
mkdirSync(evidence, { recursive: true })

export default defineConfig({
  ...baseConfig,
  root,
  cacheDir: resolve(evidence, 'cache'),
  plugins: [...(baseConfig.plugins ?? []), {
    name: 'executor-unavailable-loaded-source', enforce: 'pre',
    transform(input, id) {
      if (id.includes('?')) return
      const path = relative(root, id)
      if (path !== file) return
      const original = readFileSync(id, 'utf8')
      assert.equal(input, original, 'Actual AgentExecutorPicker source before transform')
      let code = input, applied = false
      if (mutant === 'unavailable-selected') {
        const before = "{ value: selected, label: selected, description: 'Configuration unavailable', disabled: true }"
        const after = "{ value: selected, label: selected, description: 'Configuration unavailable' }"
        assert.equal(code.split(before).length, 2, 'One unique unavailable-selected mutation target')
        code = code.replace(before, after)
        applied = true
        const target = resolve(evidence, 'loaded-product', path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, code)
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(original), consumedSHA256: sha(code), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    },
  }],
  test: { ...baseConfig.test, include: ['apps/desktop/test/agent-executor-picker.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 },
})
