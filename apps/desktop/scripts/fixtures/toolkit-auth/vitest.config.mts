import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../toolkit-preferences/vitest.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_AUTH_EVIDENCE!
assert.ok(evidence)
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_AUTH_MUTANT ?? 'baseline'
const store = 'apps/desktop/src/main/config-store.ts'
const asset = 'apps/desktop/resources/toolkit/auth/query.mjs'
const changes: Record<string, [string, string, string][]> = {
  initial: [[store, 'packages: INITIAL_TOOLKIT_PACKAGES,', 'packages: [],']],
  resurrect: [[store, '    const scratch = withScratchWorkspace(loaded)', `    if (!loaded.toolkit?.tools?.length) loaded.toolkit = { tools: await bootstrapToolkitPackages({resourceRoot: join(app.getAppPath(), 'resources', 'toolkit'),packageRoot: join(app.getPath('userData'), 'toolkit', 'packages'),workspacePath: app.getPath('home'),packages: INITIAL_TOOLKIT_PACKAGES,reportIssue: () => {}}) }\n    const scratch = withScratchWorkspace(loaded)`]],
  active: [[asset, "accountKey === '@active' ? snapshot.active_account_key : accountKey", "accountKey === '@active' ? accounts[0]?.account_key : accountKey"]],
  argv: [[asset, 'process.argv.slice(2)', 'process.argv.slice(1)']]
}
assert.ok(mutant === 'baseline' || changes[mutant])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function consume(path: string, input: string) {
  let code = input, applied = false
  for (const [target, before, after] of changes[mutant] ?? []) if (path === target) {
    assert.equal(code.split(before).length, 2, 'Unique owning mutation anchor')
    code = code.replace(before, after); applied = true
  }
  appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(input), consumedSHA256: sha(code), applied, mutant })+'\n')
  if (applied) { const target = resolve(evidence, 'loaded-product', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, code) }
  return code
}
const aliases = [
  { find: /^@agentmux\/core$/, replacement: resolve(import.meta.dirname, '../toolkit-custom-identity/core-entry.ts') },
  { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
  { find: /^@agentmux\/client-ui\/components\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1.tsx') },
  { find: /^@agentmux\/client-ui\/terminal\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/terminal/$1.ts') },
  { find: /^@agentmux\/client-ui\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') },
  ...(base.resolve?.alias as any[] ?? [])
]
export default defineConfig({ ...base, root, cacheDir: resolve(evidence, 'cache'), resolve: { alias: aliases },
  plugins: [{ name: 'ordinary-auth-loaded-source', enforce: 'pre', load(id) {
    const path = relative(root, id.split('?')[0]!)
    if (path === asset && id.endsWith('?raw')) return `export default ${JSON.stringify(consume(path, readFileSync(resolve(root, path), 'utf8')))}`
  }, transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(path) || (!path.startsWith('apps/desktop/') && !path.startsWith('packages/'))) return
    const code = consume(path, input); return code === input ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/toolkit-auth-config.test.ts', 'apps/desktop/test/toolkit-auth-script.test.ts'], passWithNoTests: false, testTimeout: 20_000 }
})
