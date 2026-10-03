import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../../..')
const fixture = join(root, 'apps/desktop/scripts/fixtures/file-markdown-quality')
const style = 'packages/client-ui/src/styles/markdown.css'
const sourceFiles = [style, 'packages/client-ui/src/components/AgentMarkdown.tsx', 'packages/client-ui/src/lib/agent-markdown.ts',
  'apps/desktop/src/renderer/src/styles/file-preview.css', 'apps/desktop/src/renderer/src/styles/tokens.css', 'apps/desktop/src/renderer/src/styles/base.css']
const fixtureFiles = ['entry.tsx', 'main.cjs', 'index.html'].map(file => `apps/desktop/scripts/fixtures/file-markdown-quality/${file}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(join(root, path)))])))
const fixtureHashes = Object.fromEntries(await Promise.all(fixtureFiles.map(async path => [path, hash(await readFile(join(root, path)))])))
await mkdir(join(root, '.tmp'), { recursive: true })
const evidence = await mkdtemp(join(root, '.tmp/file-markdown-layout-'))
const temporary = await mkdtemp(_hygiene_fixturePath("tmp/amx-markdown-layout-"))
const report = { passed: false, evidence, sourceHashes: hashes, fixtureHashes, phases: [], boundary: 'Real Chromium layout over the shared production renderer and Desktop reading CSS in private ordinary Electron processes. Full Workbench/File identity is verified by the integration capture; no user Session is operated.' }
try {
  for (const mode of ['green', 'shrinking-document', 'restored']) {
    const loaded = [], outDir = join(temporary, 'out')
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
      esbuild: { jsx: 'automatic' }, plugins: [{ name: 'loaded-markdown-layout-source', enforce: 'pre',
        transform(code, id) {
          const path = relative(root, id.split('?')[0])
          if (!sourceFiles.includes(path)) return null
          assert.equal(hash(code), hashes[path], 'Real compiled module must match the candidate source')
          let actual = code
          if (mode === 'shrinking-document' && path === style) {
            const anchor = '.md-document > * { flex-shrink: 0; }'
            assert.equal(code.split(anchor).length - 1, 1, 'Intrinsic-height mutation must reach its real CSS rule')
            actual = code.replace(anchor, '.md-document > * { flex-shrink: 1; }')
          }
          loaded.push({ path, sourceSHA256: hash(code), loadedSHA256: hash(actual), mutated: actual !== code })
          return actual === code ? null : actual
        }
      }], build: { outDir, emptyOutDir: true } })
    for (const path of sourceFiles) assert.ok(loaded.some(item => item.path === path), `Actual ${path} must be compiled`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const logs = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), join(temporary, `profile-${mode}`), evidence, mode],
      { temporaryRoot: temporary, cwd: root, env, timeoutMs: 30000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, `${mode}.log`), logs.join('\n'))
    const render = JSON.parse(await readFile(join(evidence, `${mode}.render.json`), 'utf8'))
    report.phases.push({ mode, loaded, outcome, render })
    if (mode === 'shrinking-document') {
      assert.notEqual(outcome.exitCode, 0, 'Loaded CSS shrink regression must fail actual layout')
      assert.equal(render.failure?.name, 'AssertionError', 'Mutation must fail the layout assertion, not process startup')
      assert.ok(loaded.some(item => item.mutated), 'The production CSS rule must actually be mutated in the loaded bundle')
    } else {
      assert.equal(outcome.exitCode, 0, render.failure?.message)
      assert.equal(render.passed, true)
      assert.equal(render.scenarios.length, 3, 'Normal, narrow and short production documents must all be measured')
    }
  }
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  assert.equal(report.cleanup.remaining.length, 0, 'Private layout processes must be cleaned up')
  await rm(temporary, { recursive: true, force: true })
  for (const [path, expected] of Object.entries({ ...hashes, ...fixtureHashes })) assert.equal(hash(await readFile(join(root, path))), expected, 'Loaded-source mutation must preserve candidate bytes')
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure ?? null }))
  process.exitCode = report.passed ? 0 : 1
}
