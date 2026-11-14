import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { sourceAliases } from './fixtures/launcher-launchpad/vitest.owning.config.mts'
import { runProbeProcess } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const fixture = path.join(import.meta.dirname, 'fixtures/space-new-tab-reachability')
const output = path.resolve(process.argv[2] ?? '.bagakit/feature-tracker/space-new-tab-reachability/native')
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'amux-new-tab-'))
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const source = 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'
const workbench = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const mutations = [
  { name: 'resource-conflict', path: source, before: 'tab.space && !tab.source', after: 'tab.space', failure: /Space plus creates one Tab/ },
  { name: 'select-old-tab', path: workbench, before: 'onPointerDown={event => event.stopPropagation()} onClick={() => onNewTab(group.id)}', after: 'onClick={() => onNewTab(group.id)}', failure: /Pressing the plus does not select the previous Tab/ },
  { name: 'stale-projection', path: workbench, before: "const reveal = viewOwnership === 'owner'", after: 'const reveal = false', failure: /Space selects the new Launcher through the current owner/ },
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceHashes = Object.fromEntries(await Promise.all([source, workbench].map(async file => [file, digest(await fs.readFile(path.join(root, file)))])))
const receipt = { passed: false, source, sourceHash: sourceHashes[source], sourceHashes, mutated: false, mutations: [], consumers: [], runs: [] }
await fs.mkdir(output, { recursive: true })
try {
  for (const mutant of [null, ...mutations]) {
    const directory = path.join(temporary, mutant?.name ?? 'baseline')
    await fs.mkdir(directory)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
      define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: sourceAliases }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
      plugins: [{ name: 'new-tab-owning-consumers', enforce: 'pre',
        resolveId(id) {
          if (/(^|\/)SessionPane(?:\.js)?$/.test(id)) return '\0agent-painting-leaf'
          if (/(^|\/)TerminalView(?:\.js)?$/.test(id)) return '\0terminal-painting-leaf'
          if (/^(\.\.\/)+shared\/zone-file-resource(?:\.js)?$/.test(id)) return '\0unused-native-file-resource'
        },
        load(id) {
          if (id === '\0agent-painting-leaf') return 'export function SessionPane(){return null}'
          if (id === '\0terminal-painting-leaf') return 'export function TerminalView(){return null}'
          if (id === '\0unused-native-file-resource') return 'export function zoneFileResource(){throw new Error("Unused native file leaf")}'
        },
        transform(code, id) {
          const relative = path.relative(root, id.split('?')[0])
          if (!mutant && [source, workbench, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/original-space-navigation.ts'].includes(relative)) receipt.consumers.push(relative)
          if (!mutant || relative !== mutant.path) return
          assert.equal(code.split(mutant.before).length, 2, 'Unique actual code for ' + mutant.name)
          const loaded = code.replace(mutant.before, mutant.after)
          receipt.mutated = true
          receipt.mutations.push({ name: mutant.name, path: relative, originalSHA256: digest(code), loadedSHA256: digest(loaded) })
          return { code: loaded, map: null }
        }
      }], build: { outDir: path.join(directory, 'renderer'), emptyOutDir: true, minify: false } })
    assert.equal(new Set(receipt.consumers).size, 4, 'All four owning production consumers compiled')
    const main = path.join(directory, 'main.cjs'); await fs.copyFile(path.join(fixture, 'main.cjs'), main)
    const evidence = path.join(output, mutant?.name ?? 'baseline'); await fs.mkdir(evidence, { recursive: true })
    for (const phase of mutant ? ['click'] : ['click', 'restart']) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
      const result = await runProbeProcess(require('electron'), [main, path.join(directory, 'renderer/index.html'), directory, evidence, phase],
        { cwd: root, temporaryRoot: temporary, env, timeoutMs: 45000 })
      const record = JSON.parse(await fs.readFile(path.join(evidence, phase + '.json'), 'utf8'))
      if (mutant) {
        assert.equal(result.exitCode, 1)
        assert.match(record.failure?.message ?? '', mutant.failure)
      } else { assert.equal(result.exitCode, 0, JSON.stringify(record.failure)); assert.equal(record.passed, true) }
      receipt.runs.push({ mutant: mutant?.name ?? null, phase, exitCode: result.exitCode, pid: record.pid, failure: record.failure?.message })
      console.log(`Space New Tab ${mutant ? mutant.name + ' mutation killed' : phase + ' passed'}`)
    }
  }
  assert.deepEqual(receipt.mutations.map(item => item.name), mutations.map(item => item.name))
  assert.notEqual(receipt.runs[0].pid, receipt.runs[1].pid, 'Restart used a different actual process')
  for (const [file, originalHash] of Object.entries(sourceHashes)) {
    assert.equal(digest(await fs.readFile(path.join(root, file))), originalHash, 'Mutation never changed ' + file)
  }
  receipt.passed = true
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
  receipt.temporaryRemoved = true
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
