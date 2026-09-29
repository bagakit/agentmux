import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/focus-timeline-order')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/focus-timeline-order-scene-${Date.now()}`))
const require = createRequire(path.join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite'))('esbuild'), electron = require('electron')
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-order-'), output = path.join(privateRoot, 'renderer'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const renderer = 'apps/desktop/src/renderer/src/'
const paths = [`${renderer}lib/focus-history-timeline.ts`, `${renderer}components/RecentFocusTimeline.tsx`, `${renderer}components/FocusMessagePreview.tsx`, `${renderer}lib/focus-time-window.ts`, `${renderer}lib/conversation-speaker.ts`, `${renderer}components/ConversationMessage.tsx`, `${renderer}store.ts`, `${renderer}styles/focus.css`, `${renderer}styles/focus-timeline-ruler.css`, 'apps/desktop/scripts/fixtures/focus-timeline-order/entry.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-order/main.cjs', 'apps/desktop/scripts/capture-focus-timeline-order.mjs']
const binding = async () => Object.fromEntries(await Promise.all(paths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-timeline-order-scene.v1', passed: false, sourceRoot: root, inputs: await binding(), compiled: {}, images: [], boundary: 'Light esbuild production Timeline/Store, private ordinary Electron process, trusted CDP and isolated typed presentation I/O. Public Reader/private FileStore qualified separately by owning. No Runtime/actual Run/full App build/restart/package/install.', independentVisualReview: 'pending' }
await fs.mkdir(evidence, { recursive: true })
try {
  const fresh = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await fs.writeFile(path.join(evidence, 'freshness.log'), fresh.stdout + fresh.stderr); assert.equal(fresh.status, 0)
  const loaded = [], binder = { name: 'actual-order-product-module-binding', setup(builder) { builder.onLoad({ filter: /\.[cm]?[jt]sx?$|\.css$/ }, async args => {
    if (!args.path.startsWith(`${root}/apps/desktop/src/`) && !args.path.startsWith(`${fixture}/`)) return
    const code = await fs.readFile(args.path, 'utf8'); loaded.push({ path: path.relative(root, args.path), sha256: hash(code), bytes: Buffer.byteLength(code) })
    return { contents: code, loader: path.extname(args.path) === '.css' ? 'css' : path.extname(args.path) === '.tsx' ? 'tsx' : path.extname(args.path) === '.ts' ? 'ts' : 'js', resolveDir: path.dirname(args.path) }
  }) } }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.mjs')], outdir: output, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', metafile: true, logLevel: 'error', plugins: [binder], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' } })
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>')
  assert.ok(loaded.length > 0)
  for (const file of paths.slice(0, 9)) { assert.ok(Object.hasOwn(built.metafile.inputs, file)); assert.ok(loaded.some(item => item.path === file && item.sha256 === receipt.inputs[file])) }
  receipt.compiled = { loaded, metafile: built.metafile, assets: Object.fromEntries(await Promise.all((await fs.readdir(output)).map(async file => [file, hash(await fs.readFile(path.join(output, file)))]))) }
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], result = await runProbeProcess(electron, [path.join(fixture, 'main.cjs'), path.join(output, 'index.html'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
  await fs.writeFile(path.join(evidence, 'process.log'), lines.join('\n'))
  receipt.actual = JSON.parse(await fs.readFile(path.join(evidence, 'actual.json'), 'utf8')); receipt.process = result
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  assert.ok(receipt.actual.frames.length >= 4); assert.deepEqual(receipt.actual.controls, [])
  for (const frame of receipt.actual.frames) receipt.images.push({ path: frame.image, width: frame.width, sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  assert.deepEqual(await binding(), receipt.inputs); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remainingOwnedProcesses: remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(evidence, 'receipt.json') })); assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
