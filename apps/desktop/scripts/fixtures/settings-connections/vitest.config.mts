import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from './environment.mjs'

const evidence = process.env.AGENTMUX_CONNECTIONS_EVIDENCE
assert.ok(evidence, 'Explicit owned evidence directory')
const mutant = process.env.AGENTMUX_CONNECTIONS_MUTANT ?? 'baseline'
const base = 'apps/desktop/src/renderer/src/components/settings/'
const edits: Record<string, { file: string; before: string; after: string }> = {
  catalog: { file: base + 'modules/devices.tsx', before: "group: 'connections'", after: "group: 'resources'" },
  single: { file: base + 'HostSettingsPane.tsx', before: 'hosts.filter((host) => host.id === selectedId).map', after: 'hosts.filter(() => true).map' },
  drafts: { file: base + 'HostSettingsPane.tsx', before: 'function selectHostPanel(id: string, panel: HostConnectionPanel): void {',
    after: 'function selectHostPanel(id: string, panel: HostConnectionPanel): void {\n    resource.setValue(() => Object.fromEntries(config.hosts.map((host) => [host.id, host])))' }
}
assert.ok(mutant === 'baseline' || edits[mutant], 'Known actual owning mutation')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
mkdirSync(evidence, { recursive: true })
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'bound-settings-connections-source', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (id.includes('?')) return
      const path = relative(root, id)
      if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) || !/\.[cm]?[jt]sx?$/u.test(path)) return
      const original = readFileSync(id, 'utf8'); assert.equal(input, original, 'Actual Source before transform')
      let code = input, applied = false
      const edit = edits[mutant]
      if (edit?.file === path) {
        assert.equal(code.split(edit.before).length, 2, 'One unique nonempty owning block')
        code = code.replace(edit.before, edit.after); applied = true
        const target = resolve(evidence, 'loaded-product', path)
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, code)
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(original), consumedSHA256: sha(code), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-connections.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 }
})
