import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixture = path.join(root, 'apps/desktop/scripts/fixtures/settings-section-picker-hover')
const evidence = path.join(root, '.tmp/settings-section-hover', `native-${Date.now()}`)
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const configPath = path.join(fixture, 'vitest.config.mts')
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, configPath, root)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), runs = []
const compiled = []
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-settings-section-hover-'))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
await fs.mkdir(evidence, { recursive: true })
const git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
async function input(file) {
  const bytes = await fs.readFile(file), stat = await fs.stat(file), hash = sha(bytes)
  if (inputs.has(file)) assert.equal(hash, inputs.get(file).sha256, `consumed input remained fixed: ${file}`)
  else {
    const relative = path.relative(root, file)
    assert(!relative.startsWith('..'), `input belongs to repository: ${file}`)
    const saved = path.join(evidence, 'inputs', relative)
    await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.writeFile(saved, bytes); await fs.chmod(saved, stat.mode)
    inputs.set(file, { path: relative, sha256: hash, bytes: bytes.length, mode: stat.mode & 0o777 })
  }
}
let passed = false
try {
  for (const file of [fileURLToPath(import.meta.url), configPath, path.join(fixture, 'entry.tsx'), path.join(fixture, 'index.html'), path.join(fixture, 'main.cjs'),
    path.join(root, 'package.json'), path.join(root, 'pnpm-lock.yaml'), path.join(root, 'apps/desktop/package.json'), path.join(root, 'packages/core/package.json'),
    path.join(root, 'apps/desktop/scripts/fixtures/settings-search-refinement/vitest.config.mts'), path.join(root, 'apps/desktop/scripts/probe-process.mjs')]) await input(file)
  // Vite folds @import into one CSS module. Capture the real import chain separately, in its order.
  const styles = path.join(root, 'apps/desktop/src/renderer/src/styles'), entry = path.join(styles, 'index.css')
  await input(entry)
  const imports = [...(await fs.readFile(entry, 'utf8')).matchAll(/@import\s+'\.\/([\w-]+\.css)'/g)]
  assert(imports.length > 0, 'actual CSS import chain is nonempty')
  for (const match of imports) await input(path.join(styles, match[1]))
  const output = path.join(temporary, 'renderer')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' }, resolve: config.resolve,
    define: { ...config.define, 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'settings-section-input-binding', async generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) {
        const file = id.split('?')[0]
        if (path.isAbsolute(file) && file.startsWith(root + '/') && !file.includes('\0')) await input(file)
      }
    } }], build: { target: 'esnext', outDir: output, emptyOutDir: true } })
  assert(inputs.size > imports.length, 'actual production modules are loaded beyond the CSS chain')
  async function preserveOutput(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await preserveOutput(file)
      else {
        const bytes = await fs.readFile(file), relative = path.relative(output, file), target = path.join(evidence, 'compiled-renderer', relative)
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes)
        compiled.push({ path: relative, sha256: sha(bytes), bytes: bytes.length })
      }
    }
  }
  await preserveOutput(output)
  assert(compiled.length > 0, 'actual compiled renderer is retained')
  for (const [scenario, width] of [['settings', 320], ['settings', 420], ['settings', 1480], ['feedback', 1100]]) {
    const folder = path.join(evidence, `${scenario}-${width}`); await fs.mkdir(folder)
    const process = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(output, 'index.html'), path.join(temporary, `${scenario}-${width}`), folder, String(width), scenario],
      { temporaryRoot: temporary, cwd: root, env, timeoutMs: 60000 })
    const render = JSON.parse(await fs.readFile(path.join(folder, 'render.json'), 'utf8'))
    runs.push({ scenario, width, process, render })
    assert.equal(process.exitCode, 0, render.failure?.message)
    assert.equal(render.passed, true)
  }
  passed = true
} finally {
  const readback = []
  for (const [file, fact] of inputs) readback.push({ ...fact, afterSha256: sha(await fs.readFile(file)) })
  const sourceUnchanged = readback.length > 0 && readback.every(fact => fact.sha256 === fact.afterSha256)
  await fs.rm(temporary, { recursive: true })
  const remaining = await listProbeProcesses(process.pid + 1000000000, temporary)
  const receipt = { schema: 'settings-section-hover-native.v1', git, passed: passed && sourceUnchanged && remaining.length === 0,
    inputs: readback, compiled, runs, cleanup: { temporaryRootRemoved: true, remainingOwnedProcesses: remaining },
    boundary: 'Owned production renderer/CSS only. No user App or shared Runtime/Run, real restart or installation. Independent image review is required separately.' }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ evidence: path.relative(root, evidence), passed: receipt.passed, inputs: inputs.size, runs: runs.length, cleanup: receipt.cleanup }))
  assert(sourceUnchanged, 'all consumed input bytes remained fixed')
  assert.deepEqual(remaining, [])
}
