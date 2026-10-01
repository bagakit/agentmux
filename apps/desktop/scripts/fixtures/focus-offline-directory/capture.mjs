import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'
import { directorySourceBinding, directorySourceFiles, sha } from './source-binding.mjs'

const fixture = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(fixture, '../../../../..')
const desktop = path.join(root, 'apps/desktop'), require = createRequire(path.join(desktop, 'package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root, (".tmp/focus-offline-directory-gui-" + (globalThis.crypto.randomUUID()) + ""))
await fs.mkdir(directory, { recursive: true })
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-offline-directory-probe-'))
const receipt = { schema: 'agentmux.focus-offline-directory-gui.v1', passed: false, before: directorySourceBinding(root), phases: [], scenes: [], images: [], imageShas: {}, compile: {}, restartPreserved: false,
  boundary: 'One private esbuild Renderer producer with actual Vite worker semantics; two ordinary private Electron GUI processes with the same profile. Original Store.initialize seed then zero-seed restore. Typed Session/Run references, not true Core/PTY/Run/PID continuity; no user App, package/install, shared Runtime or real lifecycle controls.' }
try {
  const output = path.join(privateRoot, 'renderer'); await fs.mkdir(output, { recursive: true })
  receipt.compile.workers = {}
  const workerPlugin = { name: 'actual-worker-modules', setup(builder) {
    builder.onResolve({ filter: /\?worker$/ }, args => ({ path: createRequire(args.importer).resolve(args.path.slice(0, -7)), namespace: 'actual-worker' }))
    builder.onLoad({ filter: /.*/, namespace: 'actual-worker' }, async args => {
      const name = 'worker-' + sha(args.path).slice(0, 12) + '.js'
      const worker = await build({ absWorkingDir: root, entryPoints: [args.path], outfile: path.join(output, name), bundle: true, format: 'esm', platform: 'browser', target: 'esnext', metafile: true, logLevel: 'error' })
      receipt.compile.workers[name] = { entry: args.path, metafile: worker.metafile }
      return { contents: `export default class extends Worker { constructor(options) { super(new URL('./${name}',import.meta.url),{...options,type:'module'}); } }`, loader: 'js' }
    })
  } }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.mjs')], outdir: output, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', metafile: true, logLevel: 'error', plugins: [workerPlugin],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' } })
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>')
  receipt.compile.consumed = {}
  for (const file of directorySourceFiles.slice(0, 4)) {
    assert.ok(Object.hasOwn(built.metafile.inputs, file), `Nonempty actual compiled input ${file}`)
    receipt.compile.consumed[file] = sha(await fs.readFile(path.join(root, file)))
    assert.equal(receipt.compile.consumed[file], receipt.before[file], `Compiled current Source ${file}`)
  }
  receipt.compile.fixture = Object.fromEntries(await Promise.all(['entry.mjs', 'main.cjs', 'capture.mjs', 'source-binding.mjs'].map(async file => [file, sha(await fs.readFile(path.join(fixture, file)))])))
  receipt.compile.metafile = built.metafile
  receipt.compile.assets = Object.fromEntries(await Promise.all((await fs.readdir(output)).map(async file => [file, sha(await fs.readFile(path.join(output, file)))])))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const stderr = []
    const exit = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(output, 'index.html'), privateRoot, phase], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => stderr.push(line) })
    const actual = JSON.parse(await fs.readFile(path.join(privateRoot, phase + '-result.json'), 'utf8'))
    await fs.writeFile(path.join(directory, phase + '-result.json'), JSON.stringify(actual, null, 2) + '\n')
    receipt.phases.push({ pid: actual.pid, seedCount: actual.seedCount, exit, stderr, actual })
    for (const image of actual.images) {
      await fs.copyFile(path.join(privateRoot, image), path.join(directory, image))
      const ref = path.relative(root, path.join(directory, image))
      receipt.images.push(ref); receipt.imageShas[ref] = sha(await fs.readFile(path.join(directory, image)))
    }
    receipt.scenes.push(...actual.scenes)
    if (actual.cssMutation) receipt.cssMutation = actual.cssMutation
    assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0, actual.error?.message); assert.equal(actual.passed, true)
  }
  assert.notEqual(receipt.phases[0].pid, receipt.phases[1].pid)
  assert.equal(receipt.phases[1].actual.seedCount, 0)
  assert.equal(receipt.phases[1].actual.restartPreserved, true)
  receipt.restartPreserved = true
  receipt.after = directorySourceBinding(root); assert.deepEqual(receipt.after, receipt.before)
  assert.equal(receipt.scenes.length, 6); assert.ok(receipt.scenes.every(scene => scene.horizontalOverflow === false))
  assert.equal(receipt.cssMutation.assertionRed && receipt.cssMutation.restoredGreen, true)
  receipt.passed = true
} catch (error) { receipt.error = { name: error.name, code: error.code, message: error.message, stack: error.stack } }
finally {
  receipt.after ??= directorySourceBinding(root)
  receipt.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), rootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(path.relative(root, path.join(directory, 'receipt.json')))
assert.equal(receipt.passed, true, receipt.error?.message)
assert.equal(receipt.cleanup.rootRemoved, true); assert.deepEqual(receipt.cleanup.remaining, [])
