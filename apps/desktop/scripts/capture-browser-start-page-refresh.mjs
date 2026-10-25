import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
assert.ok(process.argv[2] === '--evidence' && process.argv[3] && process.argv.length === 4, 'Use --evidence <new local evidence directory>')
const evidence = resolve(process.argv[3]); await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-browser-start-page-'))
const fixture = join(desktop, 'scripts/fixtures/browser-start-page-refresh'), out = join(privateRoot, 'out')
await mkdir(out)
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map(), transformations = [], logs = []
const receipt = { schema: 'agentmux.browser-start-page-refresh.v1', capturedPass: false, captureOnly: true, aestheticReview: 'not-performed', userAppRunRuntimeControlled: false,
  boundary: 'Actual App/GlobalSurveySurface/Workbench/BrowserPane/BrowserStartPage and complete source CSS. Typed preview API; four previews captured from local native HTTP fixtures. Unused SessionPane, EditorPane and diff paint leaves isolated. No user Runtime/profile, production Main history persistence, ordinary restart or installation.' }
try {
  const alias = {}
  for (const [name, directory, sourceRoot] of [['core', 'packages/core', './src/'], ['host', 'apps/host', './src/'], ['demand', 'packages/demand', './']]) {
    const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) {
      if (typeof value.import !== 'string') continue
      alias[key === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + key.slice(2)] = join(root, directory, value.import.replace('./dist/', sourceRoot).replace(/\.js$/, '.ts'))
    }
  }
  const observe = { name: 'start-page-current-source', setup(builder) {
    builder.onResolve({ filter: /\?(worker|url)$/ }, args => ({ path: createRequire(args.importer).resolve(args.path.replace(/\?(worker|url)$/, '')), namespace: args.path.endsWith('?worker') ? 'start-page-worker' : 'start-page-url' }))
    builder.onLoad({ filter: /.*/, namespace: 'start-page-url' }, async ({ path }) => {
      const file = 'asset-' + hash(path).slice(0, 12) + '.mjs'; await writeFile(join(out, file), await readFile(path))
      return { contents: `export default new URL('./${file}',import.meta.url).href`, loader: 'js' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'start-page-worker' }, async ({ path }) => {
      const file = 'worker-' + hash(path).slice(0, 12) + '.js'
      await build({ entryPoints: [path], outfile: join(out, file), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' })
      return { contents: `export default class extends Worker {constructor(options){super(new URL('./${file}',import.meta.url),{...options,type:'module'})}}`, loader: 'js' }
    })
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, hash(source))
      const component = path.slice(path.lastIndexOf('/') + 1)
      if (['SessionPane.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx'].includes(component)) {
        const code = `export function ${component.slice(0, -4)}(){return null}`
        transformations.push({ path: relative(root, path), isolated: 'Unused paint leaf; no matching Region in this scenario', sourceSHA256: hash(source), loadedSHA256: hash(code) })
        return { contents: code, loader: 'js' }
      }
      return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); return { contents: source, loader: 'css' }
    })
  } }
  for (const file of ['main.cjs', 'pages.cjs', 'entry.mjs', 'scenario.md']) inputs.set(join(fixture, file), hash(await readFile(join(fixture, file))))
  inputs.set(new URL(import.meta.url).pathname, hash(await readFile(new URL(import.meta.url))))
  const renderer = join(out, 'app.js')
  const result = await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: renderer, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', conditions: ['production'], metafile: true, alias,
    plugins: [observe], logLevel: 'silent', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = { inputCount: Object.keys(result.metafile.inputs).length, outputCount: Object.keys(result.metafile.outputs).length }
  receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha]))
  receipt.transformations = transformations
  for (const suffix of ['App.tsx', 'GlobalSurveySurface.tsx', 'WorkspaceWorkbench.tsx', 'BrowserPane.tsx', 'BrowserStartPage.tsx', 'BrowserAddressInput.tsx', 'store.ts', 'browser.css']) assert.ok([...inputs.keys()].some(path => path.endsWith('/' + suffix)), 'Actual loaded ' + suffix)
  const html = join(out, 'index.html')
  await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script src="./fixture-data.js"></script><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(renderer)), css: hash(await readFile(join(out, 'app.css'))) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }
  delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence], { cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  assert.equal(receipt.frames.length, 10)
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => [relative(root, path), hash(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Source must be stable while the candidate is captured')
  receipt.capturedPass = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
} finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { privateRoot, remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, pendingIndependentVisualReview: true }))
}
