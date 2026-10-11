import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repository, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const dialog = createRequire(createRequire(join(repository, 'packages/client-ui/package.json')).resolve('@radix-ui/react-dialog'))
const alias = Object.fromEntries(['@radix-ui/react-dismissable-layer', '@radix-ui/react-focus-scope'].map(name => [name, dialog.resolve(name)]))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const owner = 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts'
const material = 'apps/desktop/src/renderer/src/styles/overlays.css'
const inputs = [owner, material, 'apps/desktop/scripts/verify-native-overlay-motion.mjs',
  ...['main.ts', 'renderer.tsx', 'preload.ts'].map(name => 'apps/desktop/scripts/fixtures/native-overlay-motion/' + name)]
const sourceInputs = Object.fromEntries(await Promise.all(inputs.map(async path => [path, hash(await readFile(join(repository, path)))])))
const root = resolve(repository, process.env.AGENTMUX_OVERLAY_MOTION_OUTPUT ?? '.local/browser-chrome-controls/overlay/proof', randomUUID())
await mkdir(root, { recursive: true })
const evidence = { sourceInputs, cases: [], passed: false }
const consumedInputs = new Map()
const mutations = {
  'animated-overlap': { path: owner, before: 'if (nativeDemand) {\n        staticFloats.add(node)', after: 'if (false) {\n        staticFloats.add(node)' },
  'animated-material': { path: material, before: "[data-native-overlay-motion='static'] { animation: none !important; }", after: "[data-native-overlay-motion='static'] { animation: menu-in var(--dur-enter) var(--ease-enter) !important; }" },
  'early-overlap': { path: owner, before: 'for (const node of floats) {\n      // A scaled entry',
    after: 'for (const node of floats) {\n      if (nativeDemand && !nativeDemand.bounds.some(native => boundsOverlap(rendererCssBoundsToWindowDip(rectOf(node), zoomFactor()), native))) continue\n      // A scaled entry' }
}
async function run(label, mutation) {
  const directory = join(root, label); await mkdir(directory)
  const loads = [], loadedInputs = {}
  const plugin = { name: 'actual-overlay-motion-owner', setup(builder) {
    builder.onLoad({ filter: /native-overlay-regions\.ts$|overlays\.css$/ }, async args => {
      const path = relative(repository, args.path)
      assert.ok(path === owner || path === material)
      const source = await readFile(args.path, 'utf8'); let selected = source
      if (mutation?.path === path) {
        assert.equal(source.split(mutation.before).length - 1, 1, 'nonempty unique actual owner mutation')
        selected = source.replace(mutation.before, mutation.after)
      }
      loads.push({ path, sourceSHA256: hash(source), loadedSHA256: hash(selected), mutated: selected !== source })
      return { contents: selected, loader: path.endsWith('.css') ? 'css' : 'ts', resolveDir: dirname(args.path) }
    })
  } }
  const common = { absWorkingDir: repository, bundle: true, logLevel: 'silent', metafile: true }
  const results = []
  for (const [name, platform, format] of [['main', 'node', 'cjs'], ['preload', 'node', 'cjs'], ['renderer', 'browser', 'iife']]) {
    results.push(await build({ ...common, platform, format, external: platform === 'node' ? ['electron'] : [],
      jsx: 'automatic', alias, plugins: [plugin], define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.png': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
      entryPoints: ['apps/desktop/scripts/fixtures/native-overlay-motion/' + name + (name === 'renderer' ? '.tsx' : '.ts')],
      outfile: join(directory, name + (platform === 'node' ? '.cjs' : '.js')) }))
  }
  for (const result of results) for (const path of Object.keys(result.metafile.inputs)) {
    loadedInputs[path] = hash(await readFile(resolve(repository, path)))
    if (consumedInputs.has(path)) assert.equal(loadedInputs[path], consumedInputs.get(path), 'all runs consume the same source and dependencies')
    else consumedInputs.set(path, loadedInputs[path])
  }
  for (const path of [owner, material]) assert.equal(loads.filter(row => row.path === path).length, 1, 'exact actual owner consumption')
  assert.equal(loads.filter(row => row.mutated).length, mutation ? 1 : 0)
  const compiled = Object.fromEntries(await Promise.all(['main.cjs', 'preload.cjs', 'renderer.js', 'renderer.css'].map(async name => [name, hash(await readFile(join(directory, name)))])))
  await writeFile(join(directory, 'loaded.json'), JSON.stringify({ loads, loadedInputs, compiled }, null, 2))
  await writeFile(join(directory, 'index.html'), '<!doctype html><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>')
  const env = { ...process.env, AGENTMUX_OVERLAY_MOTION_ROOT: directory }; delete env.ELECTRON_RUN_AS_NODE
  const output = []
  const processReceipt = await runProbeProcess(require('electron'), [join(directory, 'main.cjs')], { cwd: directory, env, timeoutMs: 25000, onLine: line => output.push(line) })
  await writeFile(join(directory, 'process.log'), output.join('\n'))
  await writeFile(join(directory, 'process.json'), JSON.stringify(processReceipt, null, 2))
  await stopProbeProcesses(processReceipt.originalPid, directory)
  const remaining = await listProbeProcesses(processReceipt.originalPid, directory)
  assert.deepEqual(remaining, [], 'exact private Electron scope must exit')
  await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ remaining, originalExitConfirmed: processReceipt.exitConfirmed }, null, 2))
  assert.equal(processReceipt.exitConfirmed, true)
  assert.equal(processReceipt.timedOut, false, 'Electron preparation/observation timeout is not a product mutation result')
  const receipt = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
  if (mutation) {
    assert.equal(processReceipt.exitCode, 1)
    assert.equal(receipt.passed, false)
    assert.ok(receipt.publications.some(row => row.surfaces.length > 0), 'mutation reaches a nonempty actual menu')
    assert.match(receipt.publicationFailure?.message ?? '', /first overlapping entry must/)
    if (label === 'early-overlap') assert.equal(receipt.cases.length, 3, 'the early-overlap mutation must reach the final-only edge after ordinary entry and exit pass')
  } else {
    assert.equal(processReceipt.exitCode, 0, JSON.stringify(receipt))
    assert.equal(receipt.passed, true)
    assert.equal(receipt.cases.length, 7)
    assert.deepEqual(receipt.warnings, [])
    assert.ok(receipt.publications.some(row => row.surfaces.length === 2 && row.regions.length === 2))
  }
  evidence.cases.push({ label, expected: mutation ? 'RED' : 'GREEN', receiptSHA256: hash(await readFile(join(directory, 'result.json'))), loads })
  console.log(label + ': ' + (mutation ? 'expected RED' : 'GREEN'))
}
try {
  await run('source')
  if (process.argv.includes('--mutations')) {
    for (const [name, mutation] of Object.entries(mutations)) await run(name, mutation)
    await run('restored')
  }
  for (const [path, expected] of Object.entries(sourceInputs)) assert.equal(hash(await readFile(join(repository, path))), expected, 'source remains unchanged')
  for (const [path, expected] of consumedInputs) assert.equal(hash(await readFile(resolve(repository, path))), expected, 'all actually consumed inputs remain unchanged')
  evidence.passed = true
} catch (error) { evidence.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(root, 'receipt.json'), JSON.stringify(evidence, null, 2)); console.log(relative(repository, join(root, 'receipt.json'))) }
