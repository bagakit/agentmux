import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from './environment.mjs'
import { candidateModule } from '../../candidate-package-resolve.mjs'
import { readViteSourceMapLoader, verifyViteModuleSource } from '../../vite-loaded-source.mjs'

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
const sha = (code: string | Uint8Array) => createHash('sha256').update(code).digest('hex')
mkdirSync(evidence, { recursive: true })
const loader = await readViteSourceMapLoader(root)
writeFileSync(resolve(evidence, 'vite-map-loader.json'), JSON.stringify(loader, null, 2) + '\n')
const inputs = new Map<string, { fileSHA256: string; mapSHA256?: string }>()
function firstPartyModule(id: string): string | null {
  if (id.includes('?')) return null
  const path = relative(root, id)
  if ((!path.startsWith('apps/') && !path.startsWith('packages/')) || path.split('/').includes('node_modules') || !/\.[cm]?[jt]sx?$/u.test(path)) return null
  candidateModule(root, id)
  return path
}
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'bound-resource-library-product', enforce: 'pre', resolveId: installedDependency,
    load(id) {
      const path = firstPartyModule(id)
      if (!path) return
      const raw = readFileSync(id), fileSHA256 = sha(raw), source = raw.toString(), directive = '//# sourceMappingURL=' + basename(id) + '.map'
      const mapped = /\/dist\/.*\.js$/u.test(path) && (source.endsWith('\n' + directive) || source.endsWith('\n' + directive + '\n'))
      const mapSHA256 = mapped ? sha(readFileSync(id + '.map')) : undefined
      const previous = inputs.get(path)
      if (previous) assert.deepEqual(previous, { fileSHA256, ...(mapSHA256 ? { mapSHA256 } : {}) }, 'Pinned first-party load input is stable')
      inputs.set(path, { fileSHA256, ...(mapSHA256 ? { mapSHA256 } : {}) })
    },
    transform(input, id) {
      const path = firstPartyModule(id)
      if (!path) return
      const pinned = inputs.get(path)
      assert.ok(pinned, 'Actual first-party module was pinned before its loader')
      const raw = readFileSync(id), original = raw.toString()
      const sourceMap = input === original ? null : { path: path + '.map', sha256: pinned.mapSHA256 }
      const verifiedMap = verifyViteModuleSource({ module: { path, kind: 'module', query: '', fileSHA256: pinned.fileSHA256,
        originalSHA256: sha(input), loadedSHA256: sha(input), mutation: null, sourceMap }, raw, expectedFileSHA256: pinned.fileSHA256,
        ...(sourceMap ? { sourceMapBytes: readFileSync(id + '.map'), expectedMapSHA256: pinned.mapSHA256 } : {}) })
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
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, kind: /\/dist\//u.test(path) ? 'compiled' : 'source',
        originalSHA256: pinned.fileSHA256, inputSHA256: sha(input), consumedSHA256: sha(code),
        ...(verifiedMap ? { sourceMap: verifiedMap, loaderSHA256: loader.sha256 } : {}), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-resource-library.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 }
})
