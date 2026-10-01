import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'
import { chatSourceBinding, chatSourceFiles, sha } from './source-binding.mjs'

const fixture = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(fixture, '../../../../..')
const retryIndex=process.argv.indexOf('--retry-of'),previousPath=retryIndex>=0?process.argv[retryIndex+1]:null
const revisedIndex=process.argv.indexOf('--visual-revision-of'),revisedPath=revisedIndex>=0?process.argv[revisedIndex+1]:null
const revisedBytes=revisedPath?await fs.readFile(path.resolve(root,revisedPath)):null
const revised=revisedBytes?JSON.parse(revisedBytes):null
const previousBytes=previousPath?await fs.readFile(path.resolve(root,previousPath)):null
const previous=previousBytes?JSON.parse(previousBytes):null
const desktop = path.join(root, 'apps/desktop'), require = createRequire(path.join(desktop, 'package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root, (".tmp/focus-chat-mote-gui-" + (globalThis.crypto.randomUUID()) + ""))
await fs.mkdir(directory, { recursive: true })
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-chat-mote-probe-'))
const receipt = { schema: 'agentmux.focus-chat-mote-gui.v1', passed: false, before: chatSourceBinding(root), phases: [], scenes: [], images: [], imageShas: {}, compile: {}, restartPreserved: false,
  boundary: 'One private esbuild Renderer producer with actual Vite worker semantics; two ordinary private Electron GUI processes with the same profile. Original Store.initialize workface seed then zero-seed restore; preference is selected through actual GUI and never seeded. Typed Session/Run references, not true Core/PTY/Run/PID continuity; no user App, package/install, shared Runtime or real lifecycle controls.' }
if(previous){assert.deepEqual(receipt.before,previous.before,'Same unchanged product/owning/docs as failed actual attempt');receipt.previousAttempt={path:previousPath,sha256:sha(previousBytes),error:previous.error,producerInvocationsIncludingPrevious:2}}
if(revised){const changed=Object.keys(receipt.before).filter(file=>receipt.before[file]!==revised.before[file]);assert.deepEqual(changed,['apps/desktop/src/renderer/src/styles/focus.css'],'Only reviewed menu CSS changes after actual previous GUI');receipt.visualRevision={path:revisedPath,sha256:sha(revisedBytes),changed,producerInvocationsIncludingPrevious:3}}
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
  for (const file of chatSourceFiles.slice(0, 3)) {
    assert.ok(Object.hasOwn(built.metafile.inputs, file), `Nonempty actual compiled input ${file}`)
    receipt.compile.consumed[file] = sha(await fs.readFile(path.join(root, file)))
    assert.equal(receipt.compile.consumed[file], receipt.before[file], `Compiled current Source ${file}`)
  }
  receipt.compile.fixture = Object.fromEntries(await Promise.all(['entry.mjs', 'main.cjs', 'capture.mjs', 'source-binding.mjs'].map(async file => [file, sha(await fs.readFile(path.join(fixture, file)))])))
  receipt.compile.metafile = built.metafile
  receipt.compile.assets = Object.fromEntries(await Promise.all((await fs.readdir(output)).map(async file => [file, sha(await fs.readFile(path.join(output, file)))])))
  if(previous){assert.deepEqual(receipt.compile.assets,previous.compile.assets,'Rebuilt exact same compiled Renderer assets; only private driver premise corrected');receipt.compile.sameAssetsAsPrevious=true}
  if(revised){const changedAssets=Object.keys(receipt.compile.assets).filter(file=>receipt.compile.assets[file]!==revised.compile.assets[file]);assert.deepEqual(changedAssets,['entry.css'],'Only actual compiled CSS changes after visual revision');receipt.compile.changedAssetsFromVisualRevision=changedAssets}
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

    assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0, actual.error?.message); assert.equal(actual.passed, true)
  }
  assert.notEqual(receipt.phases[0].pid, receipt.phases[1].pid)
  assert.equal(receipt.phases[1].actual.seedCount, 0)
  assert.equal(receipt.phases[1].actual.restartPreserved, true)
  receipt.restartPreserved = true
  receipt.after = chatSourceBinding(root); assert.deepEqual(receipt.after, receipt.before)
  assert.equal(receipt.scenes.length, 3); assert.ok(receipt.scenes.every(scene => scene.horizontalOverflow === false))
  assert.equal(receipt.phases[1].actual.preferenceRestored, true)
  receipt.preferenceRestored = true; receipt.selectionSideEffects = false
  receipt.passed = true
} catch (error) { receipt.error = { name: error.name, code: error.code, message: error.message, stack: error.stack } }
finally {
  receipt.after ??= chatSourceBinding(root)
  receipt.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), rootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(path.relative(root, path.join(directory, 'receipt.json')))
assert.equal(receipt.passed, true, receipt.error?.message)
assert.equal(receipt.cleanup.rootRemoved, true); assert.deepEqual(receipt.cleanup.remaining, [])
