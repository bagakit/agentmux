import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_TOOLKIT_EVIDENCE ?? resolve(root, '.bagakit/design/toolkit-custom-20261005/evidence/direct')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const aliases: { find: RegExp; replacement: string }[] = []
for (const name of ['core','demand','layout']) {
  const dir = resolve(root, 'packages', name)
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === 'string' ? value : (value as { import: string }).import
    const path = resolve(dir, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
    assert.ok(readFileSync(path).length > 0, `Alias must own a nonempty current WT Source: ${path}`)
    aliases.push({ find: new RegExp(`^@agentmux/${name}${key === '.' ? '' : key.slice(1)}$`), replacement: path })
  }
}
for (const name of ['react','react/jsx-runtime','react/jsx-dev-runtime','react-dom/client']) aliases.push({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) })
mkdirSync(evidence, { recursive: true })
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const mutant = process.env.AGENTMUX_TOOLKIT_MUTANT ?? 'baseline'
const owner = 'apps/desktop/src/main/toolkit-custom-owner.ts'
const changes: Record<string, [string,string,string][]> = {
  expected: [['apps/desktop/src/main/toolkit-config.ts', 'if (expected && !configValuesEqual(fields[key], changes[key]) && !configValuesEqual(fields[key], expected[key]))', 'if (false)']],
  execution: [[owner, "args: ['--input-type=module', '--eval', program.script, '--', ...program.args]", "args: ['--input-type=module', '--eval', 'void 0', '--', ...program.args]"]],
  completion: [[owner, "if (execution.cursor !== final.run.latestOutputBytes) throw", 'if (false) throw']],
  cleanup: [[owner, 'await execution.port.remove(ref(execution))', 'void execution.port']],
  'action-binding': [
    [owner, 'if (definition.revision !== input.expectedRevision) throw', 'if (false) throw'],
    [owner, 'if (action && (!tool.latest || tool.latest.definition.revision !== definition.revision ||\n          tool.latest.target.workspacePath !== definition.workspacePath || tool.latest.executionId !== action.sourceExecutionId ||\n          (tool.admission?.executionId ?? null) !== action.expectedAdmissionExecutionId))', 'if (false)']
  ],
  'action-output': [[owner, 'const action = definition.actions?.find(action => action.id === id)',
    "const action = [...(definition.actions ?? []), ...JSON.parse(this.tools.get(definition.id)?.latest?.text ?? '{}').actions].find(action => action.id === id)"]],
  'action-repeat': [
    [owner, 'if (this.repeat(tool, input, action)) return', 'if (action === null && this.repeat(tool, input, action)) return'],
    [owner, "if (tool.error || tool.admission) throw new AgentMuxError('Tool has an in-use or unconfirmed execution.', 'SETTING_RESOURCE_IN_USE')",
      "if (action === null && (tool.error || tool.admission)) throw new AgentMuxError('Tool has an in-use or unconfirmed execution.', 'SETTING_RESOURCE_IN_USE')"],
    [owner, '(tool.admission?.executionId ?? null) !== action.expectedAdmissionExecutionId', 'false']
  ]
}
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(evidence, 'cache'), resolve: { alias: aliases },
  plugins: [{ name: 'actual-performance-toolkit-source', enforce: 'pre', configResolved(config) {
    // Node SDK artifact URLs must keep Node semantics, not Vite browser asset lookup.
    const plugins = config.plugins as any[]
    const index = plugins.findIndex(value => value.name === 'vite:asset-import-meta-url')
    if (index >= 0) plugins.splice(index, 1)
  }, transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/') && !path.startsWith('apps/desktop/src/')) return
    let code = input
    for (const change of changes[mutant] ?? []) if (change[0] === path) {
      assert.equal(code.split(change[1]).length - 1, 1, `Mutation anchor must exist exactly once in actual Source: ${path}`)
      code = code.replace(change[1], change[2])
    }
    appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(input), consumedSHA256: sha(code), mutant, bytes: Buffer.byteLength(code) }) + '\n')
    if (code !== input) return { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/toolkit-custom-owner.test.ts', 'apps/desktop/test/toolkit-custom-main.test.ts', 'apps/desktop/test/toolkit-actions-main.test.ts', 'apps/desktop/test/toolkit-receipt-store.test.ts', 'apps/desktop/test/toolkit-owner.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    testTimeout: 120_000 }
})
