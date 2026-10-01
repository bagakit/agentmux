import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../toolkit-preferences/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_TOOLKIT_IDENTITY_EVIDENCE
assert.ok(evidence, 'Each owning run has its own explicit evidence directory')
const mutant = process.env.AGENTMUX_TOOLKIT_IDENTITY_MUTANT ?? 'baseline'
const pane = 'apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx'
const edits: Record<string, [string, string]> = {
  default: ['useState<string | null>(toolId ?? tools[0]?.id ?? null)', "useState<string | null>(toolId ?? 'performance')"],
  pattern: ['onEdit={patch => resource.edit(selectedId, patch)}', 'onEdit={patch => resource.edit(selectedId, { ...patch, script: createAccountUsageTool().script })}'],
  retarget: ['setSelectedId(toolId)', 'setSelectedId(tools[0]?.id ?? null)']
}
assert.ok(mutant === 'baseline' || edits[mutant], 'Known actual product block mutation')
mkdirSync(evidence, { recursive: true })
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export default defineConfig({ ...original, root, cacheDir: resolve(evidence, 'cache'),
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: resolve(import.meta.dirname, 'core-entry.ts') }, ...(original.resolve?.alias as any[] ?? [])] },
  plugins: [{ name: 'actual-custom-identity-consumer', enforce: 'pre', transform(input, id) {
    if (id.includes('?')) return
    const file = id.split('?')[0]!, path = relative(root, file)
    if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) || !/\.[cm]?[jt]sx?$/u.test(path)) return
    const bytes = readFileSync(file, 'utf8'); assert.equal(input, bytes, 'Pre-transform consumes original Source')
    let code = input, applied = false
    if (path === pane && mutant !== 'baseline') {
      const edit = edits[mutant]!
      assert.equal(code.split(edit[0]).length, 2, 'Unique nonempty actual owning mutation anchor')
      code = code.replace(edit[0], edit[1]); applied = true
      const target = resolve(evidence, 'loaded-product', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, code)
    }
    appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(bytes), consumedSHA256: sha(code), mutant, applied }) + '\n')
    return code === input ? undefined : { code, map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/toolkit-custom-identity.test.tsx'], passWithNoTests: false, testTimeout: 20_000 }
})
