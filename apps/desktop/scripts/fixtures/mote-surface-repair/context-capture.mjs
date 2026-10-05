import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'
import { runProbeProcess } from '../../probe-process.mjs'

const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const directory = path.resolve(process.argv[2] ?? path.join(root, '.local/state/mote-context-design-review/context-renderer'))
const compiled = path.join(directory, 'compiled')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
const sourceAliases = Object.entries(radixOverlayAliases).map(([name, replacement]) => ({ name, replacement }))
for (const name of ['core', 'demand', 'git', 'identity', 'layout', 'client-ui']) {
  const folder = path.join(root, 'packages', name), manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'))
  for (const [subpath, target] of Object.entries(manifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
    const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
    const exported = typeof target === 'string' ? target : target.browser ?? target.import
    if (!exported || !exported.startsWith('./')) continue
    const stem = exported.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
    const filename = path.join(folder, stem)
    sourceAliases.push({ name: specifier, replacement: subpath.includes('*') || existsSync(filename) ? filename : filename.replace(/\.ts$/, '.tsx') })
  }
  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@agentmux/') || sourceAliases.some(alias => alias.name === dependency)) continue
    const installed = path.join(root, 'apps/desktop/node_modules/@agentmux', name, 'node_modules', dependency)
    const cached = path.join(root, 'node_modules/.pnpm', dependency.replace('/', '+') + '@' + version, 'node_modules', dependency)
    const filename = [installed, cached].find(existsSync)
    if (filename) sourceAliases.push({ name: dependency, replacement: filename })
  }
}
for (const name of ['react', 'react-dom']) sourceAliases.push({ name, replacement: path.join(root, 'apps/desktop/node_modules', name) })
const originalInputs = {}
const sources = { name: 'current-public-source-exports', setup(plugin) {
  plugin.onResolve({ filter: /.*/ }, async args => {
    if (args.pluginData?.sourceResolved) return
    for (const { name, replacement } of sourceAliases) {
      if (name.includes('*')) {
        const [prefix, suffix] = name.split('*')
        if (args.path.startsWith(prefix) && args.path.endsWith(suffix)) {
          const filename = replacement.replace('*', args.path.slice(prefix.length, args.path.length - suffix.length))
          return { path: existsSync(filename) ? filename : filename.replace(/\.ts$/, '.tsx') }
        }
      } else if (args.path === name || !name.startsWith('@agentmux/') && args.path.startsWith(name + '/')) {
        const target = replacement + args.path.slice(name.length)
        return await plugin.resolve(target, { kind: args.kind, resolveDir: args.resolveDir || root, pluginData: { sourceResolved: true } })
      }
    }
  })
} }
const workers = { name: 'original-monaco-workers', setup(plugin) {
  // This fixture never opens a drawing. Keep the optional engine lazy, and make
  // its unavailable stylesheet an explicit non-exercised dependency boundary.
  plugin.onResolve({ filter: /^@excalidraw\/excalidraw\/index\.css$/ }, () => ({ path: 'unexercised-excalidraw-styles', namespace: 'unexercised-dependency' }))
  plugin.onLoad({ filter: /.*/, namespace: 'unexercised-dependency' }, () => ({ loader: 'css', contents: '' }))
  plugin.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'original-raw' }))
  plugin.onLoad({ filter: /.*/, namespace: 'original-raw' }, async args => {
    originalInputs[args.path] = {}; return { loader: 'js', contents: 'export default ' + JSON.stringify(await fs.readFile(args.path, 'utf8')) }
  })
  plugin.onResolve({ filter: /\?url$/ }, args => ({ path: require.resolve(args.path.replace(/\?url$/, '')), namespace: 'original-url' }))
  plugin.onLoad({ filter: /.*/, namespace: 'original-url' }, async args => {
    originalInputs[args.path] = {}; return { loader: 'file', contents: await fs.readFile(args.path) }
  })
  plugin.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.replace(/\?worker$/, '')), namespace: 'original-worker' }))
  plugin.onLoad({ filter: /.*/, namespace: 'original-worker' }, async args => {
    const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, minify: true, write: false,
      platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'error' })
    Object.assign(originalInputs, output.metafile.inputs)
    return { loader: 'js', contents: `export default class OriginalMonacoWorker extends Worker {constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(output.outputFiles[0].text)}],{type:'text/javascript'})))}}` }
  })
} }
await fs.mkdir(compiled, { recursive: true })
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed',
  boundary: 'Original Mote/Workbench/SessionPane/Conversation/Composer and source preparation owners in isolated Chromium Electron. Controlled API failures and exact fixture identities. No live Provider, installed package or native Session recovery claim.', source: {}, images: {} }
try {
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.tsx')], outdir: compiled, bundle: true,
    minify: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true,
    plugins: [sources, workers], external: ['@excalidraw/excalidraw'], loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  for (const filename of Object.keys({ ...built.metafile.inputs, ...originalInputs }).filter(name => !/^original-(raw|url|worker):/.test(name) && !name.startsWith('unexercised-dependency:')))
    receipt.source[filename] = sha(await fs.readFile(path.resolve(root, filename)))
  for (const filename of [import.meta.filename, path.join(fixture, 'context-main.cjs')]) receipt.source[path.relative(root, filename)] = sha(await fs.readFile(filename))
  for (const filename of ['components/PmoTeamsTopicFloatingPanel.tsx', 'components/MoteContextStatus.tsx', 'components/WorkspaceWorkbench.tsx', 'components/AgentSessionComposer.tsx', 'store.ts'])
    assert.ok(receipt.source['apps/desktop/src/renderer/src/' + filename], 'Actual product consumer must be compiled: ' + filename)
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script type="module" src="entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'context-main.cjs'), path.join(compiled, 'index.html'), directory],
    { temporaryRoot: directory, cwd: root, env, timeoutMs: 55000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.renderer.passed, true)
  assert.ok(receipt.renderer.images.length >= 8, 'Normal/failure/location wide+narrow captures must be nonempty')
  for (const filename of receipt.renderer.images) receipt.images[filename] = sha(await fs.readFile(path.join(directory, filename)))
  receipt.sourceDrift = []
  for (const [filename, digest] of Object.entries(receipt.source)) if (sha(await fs.readFile(path.resolve(root, filename))) !== digest) receipt.sourceDrift.push(filename)
  assert.deepEqual(receipt.sourceDrift, [], 'A changed candidate requires an affected capture')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(path.join(directory, 'receipt.json'))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
