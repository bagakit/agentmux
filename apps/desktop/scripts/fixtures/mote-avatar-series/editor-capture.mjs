import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'
import { runProbeProcess } from '../../probe-process.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root, '.local/state/mote-avatar-series-editor', randomUUID()), compiled = path.join(directory, 'compiled')
await fs.mkdir(compiled, { recursive: true })
const receipt = { passed: false, aestheticReview: 'not-performed', source: {}, images: {},
  boundary: 'Production SpaceIconPicker/SeriesEditor/helper and default Desktop API/production preload consume actual isolated Electron Main MoteAvatarSeriesOwner + MoteAvatarControl + nativeImage. Fixture Mote targets and non-source environment are isolated; no live App/Session, save, persistence, installed package or final aesthetic claim.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const option = process.argv.length > 2 ? process.argv[2] : null
  const mutationIds = ['stale-source', 'stale-frame', 'reused-target', 'skip-dispose']
  assert.ok(option === null || option === 'visual-delta' || mutationIds.includes(option), 'Unknown editor scope or mutation')
  const mutation = mutationIds.includes(option) ? option : null
  receipt.scope = option === 'visual-delta' ? 'visual-delta' : 'full'
  const edits = {
    'stale-source': ['apps/desktop/src/renderer/src/components/MoteAvatarSeriesEditor.tsx', 'if (!alive.current || request !== sourceRequest.current || originalTarget.current !== target) return', 'if (!alive.current || originalTarget.current !== target) return'],
    'stale-frame': ['apps/desktop/src/renderer/src/components/MoteAvatarSeriesEditor.tsx', 'const valid = () => alive.current && request === frameRequest.current && originalTarget.current === target', 'const valid = () => alive.current && originalTarget.current === target'],
    'reused-target': ['apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', 'MoteAvatarSeriesEditor key={target.key}', 'MoteAvatarSeriesEditor'],
    'skip-dispose': ['apps/desktop/src/renderer/src/lib/mote-avatar-series-renderer.ts', 'function dispose() {', 'function dispose() { return;'],
  }
  const mutated = { name: 'bounded-production-mutation', setup(plugin) {
    if (!mutation) return
    const [file, from, to] = edits[mutation]
    plugin.onLoad({ filter: /\.[jt]sx?$/ }, async args => {
      if (path.relative(root, args.path) !== file) return
      const original = await fs.readFile(args.path, 'utf8')
      assert.equal(original.split(from).length - 1, 1, 'Mutation must match exactly one original production boundary')
      const contents = original.replace(from, to)
      receipt.mutation = { id: mutation, file, originalSha256: sha(original), effectiveSha256: sha(contents), from, to }
      await fs.writeFile(path.join(directory, 'effective-mutated-source' + path.extname(args.path)), contents)
      return { contents, loader: path.extname(args.path) === '.tsx' ? 'tsx' : 'ts' }
    })
  } }
  const alias = { ...radixOverlayAliases }
  const workerInputs = {}
  const workers = { name: 'original-monaco-workers', setup(plugin) {
    plugin.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'original-raw' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-raw' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'js', contents: 'export default ' + JSON.stringify(await fs.readFile(args.path, 'utf8')) }
    })
    plugin.onResolve({ filter: /\?url$/ }, args => ({ path: require.resolve(args.path.replace(/\?url$/, '')), namespace: 'original-url' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-url' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'file', contents: await fs.readFile(args.path) }
    })
    plugin.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.replace(/\?worker$/, '')), namespace: 'original-worker' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-worker' }, async args => {
      const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, minify: true, write: false, platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'error' })
      Object.assign(workerInputs, output.metafile.inputs)
      return { loader: 'js', contents: `export default class OriginalMonacoWorker extends Worker {constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(output.outputFiles[0].text)}],{type:'text/javascript'})))}}` }
    })
  } }
  for (const name of ['core', 'layout', 'demand']) {
    const folder = path.join(root, 'packages', name), manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath.includes('*')) continue
      const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
      alias['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = path.join(folder, source)
    }
  }
  const uiRoot = path.join(root, 'packages/client-ui'), uiManifest = JSON.parse(await fs.readFile(path.join(uiRoot, 'package.json'), 'utf8'))
  const uiSources = { name: 'original-client-ui-sources', setup(plugin) {
    plugin.onResolve({ filter: /^@agentmux\/client-ui(?:\/.*)?$/ }, args => {
      const key = args.path === '@agentmux/client-ui' ? '.' : '.' + args.path.slice('@agentmux/client-ui'.length)
      for (const [sub, target] of Object.entries(uiManifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
        const [before, after] = sub.split('*')
        if (sub !== key && (!sub.includes('*') || !key.startsWith(before) || !key.endsWith(after))) continue
        const source = typeof target === 'string' ? target : target.browser
        if (!source) throw new Error('Missing original UI export: ' + key)
        return { path: path.join(uiRoot, source.replace('*', sub.includes('*') ? key.slice(before.length, key.length - after.length) : '')) }
      }
      throw new Error('Unknown original UI export: ' + key)
    })
  } }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'editor-entry.tsx')], outdir: compiled,
    bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', metafile: true, logLevel: 'error',
    alias, conditions: ['production'], plugins: [mutated, uiSources, workers], loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' } })
  const preload = await build({ absWorkingDir: root, entryPoints: [path.join(root, 'apps/desktop/src/preload/index.ts')], outfile: path.join(compiled, 'production-preload.cjs'),
    platform: 'node', format: 'cjs', bundle: true, external: ['electron'], alias, metafile: true, logLevel: 'error' })
  const native = await build({ absWorkingDir: root, stdin: { contents: 'export { MoteAvatarSeriesOwner } from "./apps/desktop/src/main/mote-avatar-series.ts"; export { MoteAvatarControl } from "./apps/desktop/src/main/mote-avatar-control.ts";', resolveDir: root, sourcefile: 'original-source-entry.ts' },
    outfile: path.join(compiled, 'editor-native.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], alias, metafile: true, logLevel: 'error' })
  for (const file of Object.keys({ ...built.metafile.inputs, ...preload.metafile.inputs, ...native.metafile.inputs, ...workerInputs })) {
    if (file === 'original-source-entry.ts' || file.startsWith('original-worker:') || file.startsWith('original-url:') || file.startsWith('original-raw:')) continue
    receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  }
  for (const file of ['editor-capture.mjs', 'editor-main.cjs', 'editor-preload.cjs']) receipt.source[path.relative(root, path.join(fixture, file))] = sha(await fs.readFile(path.join(fixture, file)))
  const recordResources = async folder => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await recordResources(file)
      else if (entry.isFile()) receipt.source[path.relative(root, file)] = sha(await fs.readFile(file))
    }
  }
  await recordResources(path.join(root, 'apps/desktop/resources/avatar-series'))
  for (const name of ['SpaceIconPicker.tsx', 'MoteAvatarSeriesEditor.tsx']) assert.ok(receipt.source['apps/desktop/src/renderer/src/components/' + name], 'Original production consumer must be compiled')
  assert.ok(receipt.source['apps/desktop/src/main/mote-avatar-series.ts']); assert.ok(receipt.source['apps/desktop/src/preload/index.ts'])
  if (mutation) assert.equal(receipt.mutation?.id, mutation, 'The selected production mutation must run')
  await fs.copyFile(path.join(fixture, 'editor-preload.cjs'), path.join(compiled, 'editor-preload.cjs'))
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="editor-entry.css"></head><body><div id="root"></div><script type="module" src="editor-entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'editor-main.cjs'), path.join(compiled, 'index.html'), directory, path.join(root, 'apps/desktop/resources/avatar-series'), receipt.scope],
    { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => { logs.push(line); console.log(line) } })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  for (const file of receipt.renderer.images) receipt.images[file] = sha(await fs.readFile(path.join(directory, file)))
  receipt.sourceDrift = []
  for (const [file, hash] of Object.entries(receipt.source)) if (sha(await fs.readFile(path.resolve(root, file))) !== hash) receipt.sourceDrift.push(file)
  assert.deepEqual(receipt.sourceDrift, [], 'Captured source changed; qualify the affected candidate again')
  assert.equal(receipt.process.exitCode, 0, receipt.renderer.error?.message); assert.equal(receipt.renderer.passed, true, receipt.renderer.error?.message)
  assert.ok(receipt.renderer.sourceCalls.length > 0); assert.ok(receipt.renderer.images.length > 0)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
receipt.directory = directory
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(path.join(directory, 'receipt.json'))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
