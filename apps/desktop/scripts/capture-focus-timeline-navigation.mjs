import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/focus-timeline-navigation')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/focus-timeline-navigation-scene-${Date.now()}`)), sceneArgs = process.argv.slice(3), mode = sceneArgs.includes('--supplement') ? 'supplement' : 'navigation', variants = sceneArgs.filter(value => value !== '--supplement')
if (!variants.length) variants.push('known')
assert.ok(variants.every(value => ['known', 'unknown', 'conflict'].includes(value)))
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-nav-'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/lib/focus-time-window.ts', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', 'apps/desktop/scripts/fixtures/focus-timeline-navigation/entry.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-navigation/main.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-navigation/index.html']
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-timeline-navigation-scene-delivery.v1', passed: false, mode, candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), sourceRoot: root, inputs: await binding(), actual: { controls: [], scenes: [] }, compiled: {}, images: [], cleanup: null, boundary: 'Normal Vite compiled production Timeline/API/Store, typed isolated I/O and trusted CDP presentation operations. Not public Reader/native Writer, whole App build, Runtime, restart, installation or healthy-user Run qualification.', independentVisualReview: 'pending' }
await fs.mkdir(evidence, { recursive: true })
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await fs.writeFile(path.join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0)
  const loaded = [], binder = { name: 'actual-timeline-navigation-module-binding', enforce: 'pre', transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(`${root}/apps/desktop/src/`) && /\.[cm]?[jt]sx?$/.test(file)) loaded.push({ path: path.relative(root, file), sha256: hash(code), bytes: Buffer.byteLength(code) }) } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [binder], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, rollupOptions: { input: path.join(fixture, 'index.html') } } })
  assert.ok(loaded.some(module => module.path.endsWith('/RecentFocusTimeline.tsx'))); receipt.actualLoadedModules = loaded
  await fs.copyFile(path.join(fixture, 'main.mjs'), path.join(privateRoot, 'main.mjs'))
  await fs.mkdir(path.join(privateRoot, 'node_modules'), { recursive: true }); await fs.symlink(path.join(desktop, 'node_modules/electron'), path.join(privateRoot, 'node_modules/electron'))
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
  receipt.compiled = Object.fromEntries(await Promise.all((await files(path.join(privateRoot, 'renderer'))).map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  receipt.compiled['main.mjs'] = hash(await fs.readFile(path.join(privateRoot, 'main.mjs')))
  for (const variant of variants) {
    const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
    const lines = [], result = await runProbeProcess(electron, [path.join(privateRoot, 'main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence, variant, mode], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
    await fs.writeFile(path.join(evidence, `${variant}.log`), lines.join('\n'))
    const actual = JSON.parse(await fs.readFile(path.join(evidence, `${variant}-scene.json`), 'utf8'))
    receipt.actual.scenes.push({ variant, result, ...actual }); receipt.actual.controls.push(...actual.controls)
    assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
    for (const frame of actual.frames) receipt.images.push({ path: frame.image, width: frame.width, variant, sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  }
  assert.deepEqual(await binding(), receipt.inputs, 'Actual source is unchanged during compiled capture'); assert.deepEqual(receipt.actual.controls, [])
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
console.log(JSON.stringify({ passed: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')), images: receipt.images }))
