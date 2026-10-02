import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from './environment.mjs'

const evidence = process.env.AGENTMUX_RESOURCE_LIBRARY_EVIDENCE
assert.ok(evidence, 'Each run has an explicit owned evidence directory')
const section = process.env.AGENTMUX_RESOURCE_LIBRARY_SECTION
assert.ok(section === 'agents' || section === 'hosts', 'A bounded resource task is selected')
const mutant = process.env.AGENTMUX_RESOURCE_LIBRARY_MUTANT ?? 'baseline'
const file = `apps/desktop/src/renderer/src/components/settings/${section === 'agents' ? 'Agent' : 'Host'}SettingsPane.tsx`
const edits: Record<string, [string, string]> = section === 'agents' ? {
  single: ['executors.filter(({ id }) => id === selectedId).map', 'executors.filter(() => true).map'],
  drafts: ['function selectExecutor(id: string): void {', 'function selectExecutor(id: string): void {\n    setDrafts(() => Object.fromEntries(Object.entries(config.executors).map(([key, value]) => [key, toDraft(value)])))'],
  navigation: ['consumedNavigation.current === request', "consumedNavigation.current === (typeof request === 'string' ? request : request?.executorId)"],
} : {
  single: ['hosts.filter((host) => host.id === selectedId).map', 'hosts.filter(() => true).map'],
  disclosure: ['function selectHost(id: string): void {', 'function selectHost(id: string): void {\n    setAdvancedOpen({})'],
  captured: ['onClick={() => void checkHost(host)}', "onClick={() => void checkHost(host.kind === 'ssh' ? { id: host.id, kind: host.kind, label: host.label, hostname: host.hostname } : host)}"],
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
        if (mutant === 'navigation') {
          const anchor = 'consumedNavigation.current = request'
          assert.equal(code.split(anchor).length, 2)
          code = code.replace(anchor, "consumedNavigation.current = typeof request === 'string' ? request : request?.executorId")
        }
        applied = true
        const target = resolve(evidence, 'loaded-product', path)
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, code)
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(original), consumedSHA256: sha(code), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-resource-library.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 }
})
