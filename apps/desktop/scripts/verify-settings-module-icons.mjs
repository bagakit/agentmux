import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/settings-module-icons')
const require = createRequire(path.join(desktop, 'package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const runtime = { node: process.versions.node, electron: require('electron/package.json').version, vite: require('vite/package.json').version }
const evidenceRoot = path.join(root, '.tmp/settings-module-icons'), qualification = path.join(evidenceRoot, 'qualified.json')
// Consume the exact source-bound proof after commit-only integration; rebuild only changed inputs.
try {
  const { receiptPath, digest } = JSON.parse(await fs.readFile(qualification, 'utf8'))
  assert.equal(path.dirname(path.dirname(receiptPath)), evidenceRoot)
  const bytes = await fs.readFile(receiptPath), previous = JSON.parse(bytes)
  assert.equal(hash(bytes), digest); assert.equal(previous.passed, true)
  assert.deepEqual(previous.runtime, runtime)
  assert.deepEqual(previous.runs.map(run => run.variant), ['baseline', 'recovery-binding', 'search-binding', 'menu-binding'])
  assert.ok(Object.keys(previous.source).length > 100 && Object.keys(previous.artifacts).length > 10)
  for (const [file, digest] of Object.entries(previous.source)) assert.equal(hash(await fs.readFile(path.join(root, file))), digest)
  for (const [file, digest] of Object.entries(previous.artifacts)) assert.equal(hash(await fs.readFile(path.join(path.dirname(receiptPath), file))), digest)
  console.log('Reused unchanged source-bound Settings module proof: ' + path.relative(root, receiptPath))
  process.exit(0)
} catch (error) {
  if (error.code !== 'ENOENT') console.log('Settings module proof inputs changed; verifying the current candidate.')
}
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')))
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(desktop, 'scripts/fixtures/settings-overview/vitest.config.mts'), root)
const aliases = []
for (const relative of ['packages/client-ui', 'apps/host', 'packages/identity', 'packages/capsule']) {
  const directory = path.join(root, relative), manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(manifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
    const target = typeof value === 'string' ? value : value.browser ?? value.import
    if (!target) continue
    const name = manifest.name + (key === '.' ? '' : key.slice(1))
    const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
    aliases.push({ find: new RegExp('^' + pattern + '$'), replacement: path.join(directory, target.replace('./dist/', './src/').replace(/\.js$/, '.ts').replace('*', '$1')) })
  }
}
const evidence = path.join(evidenceRoot, randomUUID())
await fs.mkdir(evidence, { recursive: true })
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-module-icons-')), compiled = path.join(privateRoot, 'compiled')
const mutations = {
  'recovery-binding': ['components/settings/modules/continuity.tsx', "semanticIconComponent('object.session-recovery')", "semanticIconComponent('action.refresh')", 'Module icon: continuity'],
  'search-binding': ['components/settings/SettingsSearchResults.tsx', '<Icon size={16} aria-hidden="true" />', '', 'Search module icon: capsule'],
  'menu-binding': ['components/SettingsPanel.tsx', '<Icon size={15} aria-hidden="true" />', '', 'Menu module icon: profile']
}
const inputs = new Map(), relevant = file => file.startsWith('packages/client-ui/src/theme/') || file.includes('/components/settings/') || file.includes('/scripts/fixtures/settings-module-icons/') || file.endsWith('/verify-settings-module-icons.mjs') || file.endsWith('/SettingsPanel.tsx') || /styles\/(settings-[^/]+|surfaces)\.css$/.test(file)
for (const file of ['package.json', 'pnpm-lock.yaml', 'apps/desktop/package.json', 'packages/client-ui/package.json', 'packages/core/package.json', 'apps/host/package.json', 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts', 'apps/desktop/scripts/verify-settings-module-icons.mjs', ...['main.cjs', 'entry.tsx', 'index.html', 'scenario.md'].map(file => 'apps/desktop/scripts/fixtures/settings-module-icons/' + file)]) inputs.set(file, hash(await fs.readFile(path.join(root, file))))
const receipt = { passed: false, source: {}, runs: [], runtime, aestheticReview: 'not-performed', boundary: 'Actual SettingsPanel, module contributions, original Profile draft and shared theme preview in private Chromium with controlled preview configuration/API ports. Not live Runtime, installed app or theme-editor save qualification.' }
try {
  for (const variant of ['baseline', ...Object.keys(mutations)]) {
    const mutation = mutations[variant]; let changed = 0
    const buildInputs = new Map()
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { ...config.resolve, alias: [...config.resolve.alias, ...aliases] }, define: { ...config.define, 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, plugins: [{
      name: 'actual-settings-module-inputs', enforce: 'pre', async transform(source, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) buildInputs.set(path.relative(root, file), hash(await fs.readFile(file)))
        if (mutation && file === path.join(desktop, 'src/renderer/src', mutation[0])) {
          assert.equal(source.split(mutation[1]).length, 2, 'One original consumer mutation anchor'); changed++
          return source.replace(mutation[1], mutation[2])
        }
      }
    }], worker: { format: 'es' }, build: { target: 'esnext', outDir: compiled, emptyOutDir: true, chunkSizeWarningLimit: 20000 } })
    assert.equal(changed, mutation ? 1 : 0)
    if (!mutation) for (const [file, digest] of buildInputs) { if (inputs.has(file)) assert.equal(digest, inputs.get(file), 'Verification input changed during compile'); inputs.set(file, digest) }
    else for (const [file, digest] of buildInputs) if (relevant(file)) assert.equal(digest, inputs.get(file), 'Original source changed between variants: ' + file)
    for (const source of ['components/SettingsPanel.tsx', 'components/settings/SettingsSearchResults.tsx', 'components/settings/modules/continuity.tsx']) assert.ok(inputs.has('apps/desktop/src/renderer/src/' + source))
    assert.ok(inputs.has('packages/client-ui/src/theme/icon-catalog.ts'))
    const output = path.join(evidence, variant); await fs.mkdir(output, { recursive: true })
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const processResult = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(compiled, 'index.html'), path.join(privateRoot, variant), output, variant], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000 })
    const renderer = JSON.parse(await fs.readFile(path.join(output, 'renderer.json'), 'utf8'))
    receipt.runs.push({ variant, process: processResult, renderer })
    if (!mutation) { assert.equal(processResult.exitCode, 0, JSON.stringify(renderer.error)); assert.equal(renderer.passed, true) }
    else { assert.notEqual(processResult.exitCode, 0); assert.equal(renderer.error?.name, 'AssertionError'); assert.ok(renderer.error.message.includes(mutation[3]), JSON.stringify(renderer.error)) }
    console.log(variant + ': ' + (mutation ? 'mutant killed' : 'passed'))
  }
  receipt.passed = true
} catch (error) { receipt.error = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.source = Object.fromEntries(inputs); receipt.drift = []
  for (const [file, digest] of inputs) {
    try { if (hash(await fs.readFile(path.join(root, file))) !== digest) receipt.drift.push(file) }
    catch { receipt.drift.push(file) }
  }
  if (receipt.drift.length) { receipt.passed = false; receipt.error = { message: 'Candidate verification inputs changed during verification' } }
  await fs.rm(privateRoot, { recursive: true, force: true }); receipt.privateRuntimeRemoved = true
  receipt.artifacts = {}
  for (const run of receipt.runs) for (const file of ['renderer.json', ...run.renderer.images]) {
    const relative = path.join(run.variant, file)
    receipt.artifacts[relative] = hash(await fs.readFile(path.join(evidence, relative)))
  }
  const receiptPath = path.join(evidence, 'receipt.json'), bytes = JSON.stringify(receipt, null, 2) + '\n'
  await fs.writeFile(receiptPath, bytes)
  if (receipt.passed) await fs.writeFile(qualification, JSON.stringify({ receiptPath, digest: hash(bytes) }) + '\n')
}
console.log(path.relative(root, path.join(evidence, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error?.message); process.exitCode = 1 }
