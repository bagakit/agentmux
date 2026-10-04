import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_EXECUTOR_CREATION_EVIDENCE
assert.ok(evidence, 'Each run has an explicit owned evidence directory')
const mutant = process.env.AGENTMUX_EXECUTOR_CREATION_MUTANT ?? 'baseline'
const file = 'apps/desktop/src/renderer/src/components/settings/AgentSettingsPane.tsx'
const edits: Record<string, [string, string]> = {
  entry: ['disabled={saving} onClick={() => addExecutor()}', 'disabled={providerCatalog.length === 0 || saving} onClick={() => addExecutor()}'],
  publication: ['useAppStore.setState({ providerCatalog: catalog })', 'void catalog'],
  identity: ['const id = createExecutorId(provider.id)', 'const id = (() => { let n = 1; while (Object.hasOwn(drafts, `${provider.id}-${n}`)) n++; return `${provider.id}-${n}` })()'],
}
assert.ok(mutant === 'baseline' || edits[mutant], 'Known actual owning product block mutation')
const sha = (code: string) => createHash('sha256').update(code).digest('hex')
mkdirSync(evidence, { recursive: true })
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'bound-resource-library-product', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (id.includes('?')) return
      const path = relative(root, id)
      if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) || !/\.[cm]?[jt]sx?$/u.test(path)) return
      const original = readFileSync(id, 'utf8'); assert.equal(input, original, 'Actual Source is consumed before transform')
      let code = input, applied = false
      if (path === file && mutant !== 'baseline') {
        const [before, after] = edits[mutant]!
        assert.equal(code.split(before).length, 2, 'Unique nonempty actual owning mutation anchor')
        code = code.replace(before, after)
        applied = true
        const target = resolve(evidence, 'loaded-product', path)
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, code)
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(original), consumedSHA256: sha(code), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-executor-creation.test.tsx', 'apps/desktop/test/settings-resource-library.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 }
})
