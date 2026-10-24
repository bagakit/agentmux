import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/settings-actions')
const require = createRequire(path.join(desktop, 'package.json'))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')))
assert.equal(spawnSync(process.execPath, ['--check', path.join(fixture, 'main.cjs')]).status, 0, 'Probe syntax preflight')
const postcss = createRequire(require.resolve('vite'))('postcss')
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(desktop, 'scripts/fixtures/settings-overview/vitest.config.mts'), root)
// Keep source consumers inside an isolated checkout; shared node_modules supplies dependencies only.
const sourceAliases = []
for (const relative of ['packages/client-ui', 'apps/host']) {
  const directory = path.join(root, relative), manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(manifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
    const target = typeof value === 'string' ? value : value.browser ?? value.import
    if (!target) continue
    const name = manifest.name + (key === '.' ? '' : key.slice(1))
    const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
    sourceAliases.push({ find: new RegExp('^' + pattern + '$'), replacement: path.join(directory, target.replace('./dist/', './src/').replace(/\.js$/, '.ts').replace('*', '$1')) })
  }
}
const evidence = path.join(root, '.tmp/settings-actions', randomUUID())
await fs.mkdir(evidence, { recursive: true })
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-actions-'))
const compiled = path.join(privateRoot, 'compiled'), inputs = new Map()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const cssOwner = 'apps/desktop/src/renderer/src/styles/settings-actions.css'
const hostOwner = 'apps/desktop/src/renderer/src/components/settings/HostUpgradePanel.tsx'
const relevant = file => file.includes('/settings/') || file.endsWith('SettingsPanel.tsx') || /styles\/(settings-[^/]+|channel-settings|connector-experience|mote-profile-task|index)\.css$/.test(file)
const receipt = { passed: false, source: {}, runs: [], boundary: 'Actual SettingsPanel and original Profile/Appearance/Mobile/Host consumers in isolated Chromium; controlled configuration, device and upgrade API ports. No live device revocation, deployment, Runtime or installation.', aestheticReview: 'not-performed' }
async function compile(hostMutation = false) {
  let changed = 0; const buildInputs = new Map()
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { ...config.resolve, alias: [...config.resolve.alias, ...sourceAliases] }, define: { ...config.define, 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, plugins: [{ name: 'actual-settings-action-consumers', enforce: 'pre', async transform(source, id) {
    const file = id.split('?')[0]
    if (file.startsWith(root + '/') && !file.includes('/node_modules/')) buildInputs.set(path.relative(root, file), sha(await fs.readFile(file)))
    if (hostMutation && file === path.join(root, hostOwner)) {
      const from = "(busy ? pendingPrimary.current : check?.eligible && !needsRecheck) ? 'primary-button' : 'small-button'"
      assert.ok(source.includes(from), 'Host owner mutation must bind the actual consumer'); changed++
      return source.replace(from, "check?.eligible && !needsRecheck && !busy ? 'primary-button' : 'small-button'")
    }
  } }], css: { postcss: { plugins: [{ postcssPlugin: 'actual-settings-action-css', async Once(node) {
    const files = new Set(); node.walk(child => { if (child.source?.input.file) files.add(child.source.input.file) })
    for (const file of files) if (file.startsWith(root + '/')) buildInputs.set(path.relative(root, file), sha(await fs.readFile(file)))
  } }] } }, worker: { format: 'es' }, build: { target: 'esnext', outDir: compiled, emptyOutDir: true, chunkSizeWarningLimit: 20000 } })
  if (hostMutation) assert.equal(changed, 1)
  if (!hostMutation) for (const [file, hash] of buildInputs) inputs.set(file, hash)
  else for (const [file, hash] of buildInputs) if (relevant(file)) assert.equal(hash, inputs.get(file), 'Relevant candidate changed between baseline and mutant: ' + file)
  assert.ok(inputs.has(cssOwner)); assert.ok(inputs.has(hostOwner)); assert.ok(inputs.has('apps/desktop/src/renderer/src/components/SettingsPanel.tsx'))
}
async function run(variant, expectedFailure) {
  const output = path.join(evidence, variant); await fs.mkdir(output, { recursive: true })
  const profile = path.join(privateRoot, variant), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const processResult = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(compiled, 'index.html'), profile, output, variant], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000 })
  const runRecord = { variant, process: processResult }; receipt.runs.push(runRecord)
  const renderer = JSON.parse(await fs.readFile(path.join(output, 'renderer.json'), 'utf8'))
  runRecord.renderer = renderer
  if (!expectedFailure) { assert.equal(processResult.exitCode, 0, JSON.stringify(renderer.error)); assert.equal(renderer.passed, true) }
  else { assert.equal(renderer.passed, false); assert.equal(renderer.error?.name, 'AssertionError'); assert.ok(renderer.error.message.includes(expectedFailure), JSON.stringify(renderer.error)); assert.notEqual(processResult.exitCode, 0) }
}
try {
  await compile(); await run('baseline')
  const assets = (await fs.readdir(path.join(compiled, 'assets'))).filter(file => file.endsWith('.css')); assert.ok(assets.length)
  for (const [variant, property, value, expectedFailure] of [
    ['unequal-scale', 'min-height', '20px', 'Photo action height'],
    ['disabled-brand', 'background', 'linear-gradient(red,red)', 'Disabled primary is neutral'],
    ['focus-spacing', 'outline-offset', '0', 'Settings action focus spacing']
  ]) {
    let count = 0; const originals = new Map()
    for (const asset of assets) {
      const file = path.join(compiled, 'assets', asset), original = await fs.readFile(file, 'utf8'), tree = postcss.parse(original)
      tree.walkRules(rule => {
        const selector = rule.selector.replaceAll(' ', '')
        const target = property === 'min-height' ? '.settings-page:is(.small-button,.primary-button,.danger-button)' : property === 'background' ? '.settings-page:is(.small-button,.primary-button,.danger-button):disabled' : '.settings-page:is(.small-button,.primary-button,.danger-button,.icon-button):focus-visible'
        if (selector === target) rule.walkDecls(property, declaration => { declaration.value = value; count++ })
      })
      if (tree.toString() !== original) { originals.set(file, original); await fs.writeFile(file, tree.toString()) }
    }
    assert.equal(count, 1, 'Mutation must alter the original emitted settings owner exactly once')
    try { await run(variant, expectedFailure) } finally { for (const [file, original] of originals) await fs.writeFile(file, original) }
  }
  await compile(true); await run('upgrade-role', 'Pending precheck keeps primary role')
  receipt.passed = true
} catch (error) { receipt.error = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.source = Object.fromEntries(inputs); receipt.drift = []
  for (const [file, hash] of inputs) if (sha(await fs.readFile(path.join(root, file))) !== hash) receipt.drift.push(file)
  if (receipt.drift.some(file => relevant(file))) { receipt.passed = false; receipt.error = { message: 'Settings candidate changed during verification' } }
  await fs.rm(privateRoot, { recursive: true, force: true })
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(path.relative(root, path.join(evidence, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error?.message); process.exitCode = 1 }
