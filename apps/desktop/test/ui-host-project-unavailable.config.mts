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
assert.ok(['baseline', 'unavailable-selected', 'stale-connection-filter', 'label-sensitive'].includes(mutant), 'Known Executor mutation')
const target = mutant === 'label-sensitive' ? {
  file: 'apps/host/src/host-configuration.ts',
  before: 'if (!left || !right || left.id !== right.id || left.kind !== right.kind) return false',
  after: 'if (!left || !right || left.id !== right.id || left.kind !== right.kind || left.label !== right.label) return false',
} : mutant === 'stale-connection-filter' ? {
  file: 'apps/desktop/src/renderer/src/components/settings/HostProjectsPane.tsx',
  before: 'const pickerExecutors = selectionCurrent ? executors : executors.filter(item => item.id !== executorId)',
  after: 'const pickerExecutors = executors',
} : {
  file: 'apps/desktop/src/renderer/src/components/AgentExecutorPicker.tsx',
  before: "{ value: selected, label: selected, description: 'Configuration unavailable', disabled: true }",
  after: "{ value: selected, label: selected, description: 'Configuration unavailable' }",
}
const file = target.file
const sha = text => createHash('sha256').update(text).digest('hex')
mkdirSync(evidence, { recursive: true })

export default defineConfig({
  ...baseConfig,
  root,
  resolve: { ...baseConfig.resolve, alias: [{ find: '@agentmux/host/host-configuration', replacement: resolve(root, 'apps/host/src/host-configuration.ts') }, ...(baseConfig.resolve!.alias as import('vite').Alias[])] },
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
      if (mutant !== 'baseline') {
        const { before, after } = target
        assert.equal(code.split(before).length, 2, 'One unique Executor mutation target')
        code = code.replace(before, after)
        applied = true
        const loadedTarget = resolve(evidence, 'loaded-product', path)
        mkdirSync(dirname(loadedTarget), { recursive: true })
        writeFileSync(loadedTarget, code)
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(original), consumedSHA256: sha(code), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    },
  }],
  test: { ...baseConfig.test, include: ['apps/desktop/test/agent-executor-picker.test.tsx', 'apps/desktop/test/host-project-executors.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 },
})
