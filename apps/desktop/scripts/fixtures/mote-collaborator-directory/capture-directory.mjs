import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProbeProcess } from '../../probe-process.mjs'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root, (".tmp/mote-collaborator-directory/renderer-" + (globalThis.crypto.randomUUID()) + "")), compiled = path.join(directory, 'compiled')
await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, captureSubset: 'directory', aestheticReview: 'not-performed', source: {}, images: {},
  boundary: 'Original App/WorkspaceSidebar/SpaceTopicsTree/SettingsPanel/Workbench/Store and Desktop styles in an isolated Electron Renderer. Controlled filesystem replies, exact original Launcher resource and no configured Executor; no live user App/Run, Core native lifecycle, model, package or install claim.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const alias = {}
  const packages = path.join(await fs.realpath(path.join(root, 'node_modules')), '.pnpm')
  const virtual = (await fs.readdir(packages)).find(name => name.startsWith('@tanstack+react-virtual@'))
  if (!virtual) throw Error('Existing react-virtual dependency unavailable')
  const virtualRoot = path.join(packages, virtual, 'node_modules/@tanstack/react-virtual')
  alias['@tanstack/react-virtual'] = path.join(virtualRoot, JSON.parse(await fs.readFile(path.join(virtualRoot, 'package.json'), 'utf8')).module)
  const installedRoots = {}
  for (const name of ['jsonc-parser', 'papaparse', 'pdfjs-dist']) {
    const folder = (await fs.readdir(packages)).find(entry => entry.startsWith(name + '@'))
    if (!folder) throw Error('Existing dependency unavailable: ' + name)
    const installed = path.join(packages, folder, 'node_modules', name)
    installedRoots[name] = installed
    alias[name] = installed
  }
  const resolveAsset = name => {
    const entry = Object.entries(installedRoots).find(([key]) => name.startsWith(key + '/'))
    return entry ? path.join(entry[1], name.slice(entry[0].length + 1)) : require.resolve(name)
  }
  const workerInputs = {}
  const workers = { name: 'original-monaco-workers', setup(plugin) {
    plugin.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'original-raw' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-raw' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'js', contents: 'export default ' + JSON.stringify(await fs.readFile(args.path, 'utf8')) }
    })
    plugin.onResolve({ filter: /\?url$/ }, args => ({ path: resolveAsset(args.path.replace(/\?url$/, '')), namespace: 'original-url' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-url' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'file', contents: await fs.readFile(args.path) }
    })
    plugin.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.replace(/\?worker$/, '')), namespace: 'original-worker' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-worker' }, async args => {
      const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'error' })
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
  const clientUiRoot = path.join(root, 'packages/client-ui'), clientUiManifest = JSON.parse(await fs.readFile(path.join(clientUiRoot, 'package.json'), 'utf8'))
  const clientUiSource = { name: 'original-client-ui-source', setup(plugin) { plugin.onResolve({ filter: /^@agentmux\/client-ui(?:\/.*)?$/ }, args => { const key = args.path === '@agentmux/client-ui' ? '.' : '.' + args.path.slice('@agentmux/client-ui'.length); const entries = Object.entries(clientUiManifest.exports).sort(([a],[b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length-a.length); for (const [sub, target] of entries) { const [before,after] = sub.split('*'); if (sub !== key && (!sub.includes('*') || !key.startsWith(before) || !key.endsWith(after))) continue; const source = typeof target === 'string' ? target : target.browser; if (!source) throw Error('Missing current Source export'); return { path: path.join(clientUiRoot, source.replace('*', sub.includes('*') ? key.slice(before.length, key.length-after.length) : '')) } } throw Error('Unknown original UI export '+key) }) } }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'directory-entry.tsx')], outdir: compiled, bundle: true,
    format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true, alias, plugins: [clientUiSource, workers],
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.ttf': 'file' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  for (const file of Object.keys({ ...built.metafile.inputs, ...workerInputs }).filter(file => !file.startsWith('original-worker:') && !file.startsWith('original-url:') && !file.startsWith('original-raw:'))) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  for (const name of ['capture-directory.mjs', 'directory-main.cjs']) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  for (const file of ['apps/desktop/src/renderer/src/components/SpaceTopicsTree.tsx', 'apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx', 'apps/desktop/src/renderer/src/components/settings/MoteDirectorySettingsPane.tsx', 'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx']) assert.ok(receipt.source[file], 'Nonempty original product inputs are required')
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="directory-entry.css"></head><body><div id="root"></div><script type="module" src="directory-entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'directory-main.cjs'), path.join(compiled, 'index.html'), directory, directory],
    { temporaryRoot: directory, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.renderer.passed, true)
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
receipt.compiled = Object.fromEntries(await Promise.all((await fs.readdir(compiled)).map(async file => [file, sha(await fs.readFile(path.join(compiled, file)))])))
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await fs.rm(compiled, { recursive: true, force: true })
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
