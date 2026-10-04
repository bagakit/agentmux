import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../toolkit-preferences/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(process.env.AGENTMUX_TOOLKIT_TEMPLATE_EVIDENCE ?? resolve(root, ".bagakit/design/toolkit-template-fixture/direct"))
const mutant = process.env.AGENTMUX_TOOLKIT_TEMPLATE_MUTANT ?? 'baseline'
const pane = 'apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx'
const asset = 'apps/desktop/resources/toolkit/account-usage.mjs'
const changes: Record<string, [string, string, string][]> = {
  create: [[pane, 'onClick={() => add(createAccountUsageTool())}', 'onClick={() => {}}']],
  unknown: [[asset, 'const available = details ? count(details.available_count) : count(usage.reset_credits)',
    'const available = (details ? count(details.available_count) : count(usage.reset_credits)) ?? 0']],
  edit: [[pane, 'const resource = useToolkitDrafts(tools)',
    'const resource = useToolkitDrafts(tools)\n  useEffect(() => { for (const tool of tools) resource.edit(tool.id, createAccountUsageTool()) }, [])']]
}
assert.ok(mutant === 'baseline' || changes[mutant], 'Explicit template loaded mutation')
mkdirSync(evidence, { recursive: true })
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function consume(path: string, input: string) {
  const originalBytes = readFileSync(resolve(root, path), 'utf8')
  let code = input
  let applied = false
  for (const [target, before, after] of changes[mutant] ?? []) if (path === target) {
    assert.equal(input, originalBytes, 'Mutation consumes the actual product Source bytes')
    assert.equal(code.split(before).length - 1, 1, 'Unique nonempty actual template mutation anchor')
    code = code.replace(before, after)
    applied = true
  }
  const target = resolve(evidence, 'source', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, originalBytes)
  if (applied) {
    const compiled = resolve(evidence, 'compiled-product', path); mkdirSync(dirname(compiled), { recursive: true }); writeFileSync(compiled, code)
  }
  appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(originalBytes), loadedInputSHA256: sha(input), consumedSHA256: sha(code), mutant, applied }) + '\n')
  return code
}
export default defineConfig({ ...original, root, cacheDir: resolve(evidence, 'cache'),
  plugins: [{ name: 'actual-toolkit-template-source', enforce: 'pre', load(id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (path !== asset || !id.endsWith('?raw')) return
    return `export default ${JSON.stringify(consume(path, readFileSync(file, 'utf8')))}`
  }, transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    if (!/\.[cm]?[jt]sx?$/u.test(path)) return
    const code = consume(path, input)
    return code === input ? undefined : { code, map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/toolkit-template-script.test.ts', 'apps/desktop/test/toolkit-template-ui.test.tsx'],
    passWithNoTests: false, testTimeout: 20_000 }
})
