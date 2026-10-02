import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'

const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const output = path.join(root, '.tmp', ("focus-work-history-scene-" + (globalThis.crypto.randomUUID()) + "")); await fs.mkdir(output, { recursive: true })
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amux-focus-work-history-'))
const renderer = path.join(privateRoot, 'renderer'); await fs.mkdir(renderer)
const products = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/lib/focus-work-history.ts', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', 'apps/desktop/src/renderer/src/styles/focus.css']
const receipt = { schema: 'agentmux.focus-work-history-scene.v1', passed: false, authorAgentId: '/root/focus_lane_intake', inputs: {}, sourceAfter: {}, phases: [], frames: [], compile: {}, restartPreserved: false, workHistoryPreserved: false, userAppRunRuntimeControlled: false,
  boundary: 'One light production Renderer compile; two ordinary private Electron GUI PIDs and the same profile with real Store.initialize, first seed1/second0. Actual public Client/FileStore rereads original T001 accepted records with unchanged IDs/times; separately controlled long consumer intervals qualify geometry. Retired sources are explicitly read again after restart. PTY paint is not physical Run continuity; no user App/Run/Runtime, Vendor Writer, package, installation or full Focus qualification.' }
try {
  const loaded = {}
  const sourcePlugin = { name: 'actual-compiled-source-bytes', setup(builder) {
    builder.onLoad({ filter: /\.(?:tsx?|[cm]?js|css|json)$/, namespace: 'file' }, async args => {
      const bytes = await fs.readFile(args.path), extension = path.extname(args.path).slice(1), name = path.relative(root, args.path)
      if (!name.includes('node_modules/')) loaded[name] = sha(bytes)
      return { contents: bytes.toString(), loader: extension === 'mjs' || extension === 'cjs' ? 'js' : extension }
    })
  } }
  const workerPlugin = { name: 'original-vite-worker-modules', setup(builder) {
    builder.onResolve({ filter: /\?worker$/ }, args => ({ path: createRequire(args.importer).resolve(args.path.slice(0, -7)), namespace: 'actual-worker' }))
    builder.onLoad({ filter: /.*/, namespace: 'actual-worker' }, async args => {
      const name = 'worker-' + sha(args.path).slice(0, 12) + '.js'
      const worker = await build({ absWorkingDir: root, entryPoints: [args.path], outfile: path.join(renderer, name), bundle: true, format: 'esm', platform: 'browser', target: 'esnext', metafile: true, logLevel: 'error' })
      receipt.compile.workers ??= {}; receipt.compile.workers[name] = worker.metafile
      return { contents: `export default class extends Worker { constructor(options) { super(new URL('./${name}',import.meta.url),{...options,type:'module'}); } }`, loader: 'js' }
    })
  } }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.mjs')], outdir: renderer, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', metafile: true, logLevel: 'error', plugins: [workerPlugin, sourcePlugin],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' } })
  await fs.writeFile(path.join(renderer, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>')
  const actualFiles = [...new Set([...Object.keys(built.metafile.inputs).filter(file => !file.includes('node_modules/')), ...products,
    ...['entry.mjs', 'main.cjs', 'preload.cjs', 'capture.mjs'].map(file => path.relative(root, path.join(fixture, file))),
    'apps/desktop/test/fixtures/focus-work-history-public-inputs.json', 'packages/core/dist/session-timeline.js', 'packages/core/dist/agent-session-store.js', 'packages/core/dist/client.js'])]
  const binding = async () => Object.fromEntries(await Promise.all(actualFiles.map(async file => { const bytes = await fs.readFile(path.join(root, file)); assert.ok(bytes.length, 'Nonempty actual input ' + file); return [file, sha(bytes)] })))
  receipt.inputs = await binding(); receipt.compile.metafile = built.metafile
  receipt.compile.loaded = loaded
  for (const [file, actualSHA] of Object.entries(loaded)) assert.equal(receipt.inputs[file], actualSHA, 'Same actual compile/on-load Source ' + file)
  for (const product of products) assert.ok(Object.hasOwn(built.metafile.inputs, product), 'Actual compiled product consumer ' + product)
  receipt.compile.assets = Object.fromEntries(await Promise.all((await fs.readdir(renderer)).map(async file => [file, sha(await fs.readFile(path.join(renderer, file)))])))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const stderr = [], exit = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(renderer, 'index.html'), privateRoot, phase, path.join(root, 'apps/desktop/test/fixtures/focus-work-history-public-inputs.json')],
      { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => stderr.push(line) })
    const actual = JSON.parse(await fs.readFile(path.join(privateRoot, phase + '-result.json'), 'utf8'))
    await fs.writeFile(path.join(output, phase + '-result.json'), JSON.stringify(actual, null, 2) + '\n')
    receipt.phases.push({ pid: actual.pid, seedCount: actual.seedCount, exit, stderr, actual })
    for (const image of actual.images) {
      await fs.copyFile(path.join(privateRoot, image), path.join(output, image)); const operation = actual.operations.find(operation => operation.name === image)
      receipt.frames.push({ path: image, width: operation.width, sha256: sha(await fs.readFile(path.join(output, image))), actual: operation.actual })
    }
    assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
  }
  assert.notEqual(receipt.phases[0].pid, receipt.phases[1].pid); assert.equal(receipt.phases[1].seedCount, 0)
  assert.equal(receipt.phases[1].actual.restartPreserved, true); assert.equal(receipt.phases[1].actual.workHistoryPreserved, true)
  receipt.restartPreserved = true; receipt.workHistoryPreserved = true
  receipt.sourceAfter = await binding(); assert.deepEqual(receipt.sourceAfter, receipt.inputs)
  assert.equal(receipt.frames.length, 3); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.cleanup = { remainingProcesses: (await listProbeProcesses(-1, privateRoot)).length, rootRemoved: false }
  if (receipt.cleanup.remainingProcesses === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(path.relative(root, path.join(output, 'receipt.json')))
assert.equal(receipt.passed, true, receipt.failure?.message)
