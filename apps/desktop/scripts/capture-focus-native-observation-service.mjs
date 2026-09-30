import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/focus-observation-service')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/focus-observation-service-visual'))
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = require('electron')
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-observation-'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const product = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/session-user-messages.ts']
const sourcePaths = [...product, ...['entry.mjs', 'main.mjs', 'preload.cjs', 'index.html'].map(file => `apps/desktop/scripts/fixtures/focus-observation-service/${file}`)]
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-observation-service-scene.v1', passed: false, inputs: await binding(), compiled: {}, images: [], cleanup: null, boundary: 'Light Renderer compile and independent private Electron/FileStore public reader/observer. No fullDesktop/Core build, package install, healthy Run or user App operation.' }
await fs.mkdir(evidence, { recursive: true })
try {
  const loaded = [], binder = { name: 'actual-service-scene-source', enforce: 'pre', transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(`${root}/apps/desktop/src/`) && /\.[cm]?[jt]sx?$/.test(file)) loaded.push({ path: path.relative(root, file), sha256: hash(code), bytes: Buffer.byteLength(code) }) } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [binder], define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, rollupOptions: { input: path.join(fixture, 'index.html') } } })
  for (const file of product) assert.ok(loaded.some(item => item.path === file && item.sha256 === receipt.inputs[file] && item.bytes > 0))
  receipt.actualLoadedModules = loaded
  for (const file of ['main.mjs', 'preload.cjs']) await fs.copyFile(path.join(fixture, file), path.join(privateRoot, file))
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(path.join(root, 'packages/core'), path.join(privateRoot, 'node_modules/@agentmux/core'))
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
  receipt.compiled = Object.fromEntries(await Promise.all((await files(path.join(privateRoot, 'renderer'))).map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], result = await runProbeProcess(electron, [path.join(privateRoot, 'main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90000, onLine: line => lines.push(line) })
  await fs.writeFile(path.join(evidence, 'scene.log'), lines.join('\n')); receipt.actual = { ...JSON.parse(await fs.readFile(path.join(evidence, 'scene.json'), 'utf8')), result }
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true); assert.deepEqual(receipt.actual.controls, [])
  for (const frame of receipt.actual.frames) receipt.images.push({ path: frame.image, width: frame.width, sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  assert.deepEqual(await binding(), receipt.inputs); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
console.log(JSON.stringify({ passed: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')), images: receipt.images }))
