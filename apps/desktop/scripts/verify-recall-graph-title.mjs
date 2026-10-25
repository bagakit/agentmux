import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { aliases, desktopRequire } from './fixtures/settings-resource-library/environment.mjs'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..')
const fixture = join(root, 'apps/desktop/scripts/fixtures/recall-graph-title')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const evidencePath = join(root, '.bagakit/feature-tracker/plans/ui-detail-polish/graph')
await mkdir(evidencePath, { recursive: true })
const evidence = await realpath(evidencePath)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const cssFile = 'apps/desktop/src/renderer/src/styles/note-canvas.css'
const rule = '.global-recall-surface .survey-notebook-home:has(.note-canvas) > .note-canvas { align-self: start; }'
const owners = [cssFile, 'apps/desktop/src/renderer/src/styles/survey.css', 'apps/desktop/src/renderer/src/styles/recall.css',
  'apps/desktop/src/renderer/src/styles/index.css', 'apps/desktop/src/renderer/src/components/GlobalRecallSurface.tsx',
  'apps/desktop/src/renderer/src/components/NotebookNavigation.tsx', 'apps/desktop/src/renderer/src/components/NotebookViews.tsx',
  'apps/desktop/src/renderer/src/components/NoteCanvas.tsx', 'apps/desktop/src/renderer/src/components/NotebookDirectoryContextMenu.tsx',
  'apps/desktop/src/renderer/src/lib/use-note-canvas-observation.ts', 'apps/desktop/src/renderer/src/lib/use-note-canvas-layout.ts',
  'apps/desktop/src/renderer/src/lib/note-canvas-state.ts', 'apps/desktop/src/renderer/src/lib/notebook-library.ts',
  ...['entry.tsx', 'index.html', 'main.cjs'].map(file => 'apps/desktop/scripts/fixtures/recall-graph-title/' + file),
  'apps/desktop/scripts/verify-recall-graph-title.mjs']
const sourceHashes = async () => Object.fromEntries(await Promise.all(owners.map(async file => [file, hash(await readFile(join(root, file)))])))
const compilationOwners = values => Object.fromEntries(Object.entries(values).filter(([file]) => !file.endsWith('/main.cjs') && !file.endsWith('/verify-recall-graph-title.mjs')))
const allFiles = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry =>
  entry.isDirectory() ? allFiles(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
if (process.env.AGENTMUX_GRAPH_RECEIPT) {
  const path = resolve(process.env.AGENTMUX_GRAPH_RECEIPT), bytes = await readFile(path), producer = JSON.parse(bytes)
  const script = 'apps/desktop/scripts/verify-recall-graph-title.mjs', current = await sourceHashes()
  assert.equal(producer.schema, 'agentmux.recall-graph-title.v1'); assert.equal(producer.passed, true)
  assert.deepEqual(Object.keys(current).sort(), Object.keys(producer.owned).sort())
  for (const [file, sha256] of Object.entries(current)) if (file !== script) assert.equal(sha256, producer.owned[file], 'Exact current product and fixture owner: ' + file)
  const producerSource = join(evidence, 'producer-script.mjs')
  assert.equal(hash(await readFile(producerSource)), producer.owned[script], 'The original producer definition is retained; the wrapper is not its bytes')
  const compiled = join(producer.build.privateRoot, 'renderer')
  for (const [file, sha256] of Object.entries(producer.build.compiled)) assert.equal(hash(await readFile(join(compiled, file))), sha256, 'Exact original compiled candidate')
  assert.equal(hash(await readFile(join(root, cssFile))), producer.styles.source)
  assert.equal(hash(await readFile(join(compiled, producer.styles.compiled))), producer.styles.candidate)
  assert.equal(hash(await readFile(join(compiled, producer.styles.compiled.replace(/\.css$/u, '-without-title-alignment.css')))), producer.styles.mutated)
  assert.equal(hash(await readFile(join(producer.build.privateRoot, 'production-source/note-canvas.css'))), producer.styles.privateSource)
  assert.deepEqual(producer.cases.map(item => item.label), ['green', 'red', 'restored'])
  for (const item of producer.cases) {
    assert.equal(item.process.timedOut, false); assert.equal(item.process.exitConfirmed, true)
    if (item.label === 'red') {
      assert.equal(item.process.exitCode, 1); assert.equal(item.actual.passed, false); assert.equal(item.actual.cases.length, 1)
      assert.match(item.actual.failure.message, /Original Notebook title and mode row remain above their Graph canvas/u)
      const geometry = item.actual.cases[0]
      assert.ok(geometry.canvas.y < geometry.header.bottom || geometry.canvas.y < geometry.picker.bottom)
    } else {
      assert.equal(item.process.exitCode, 0); assert.equal(item.actual.passed, true); assert.equal(item.actual.cases.length, 3)
      assert.deepEqual(item.actual.after, item.actual.before)
      assert.equal(item.actual.recovery.length, 2)
      for (const geometry of item.actual.cases) {
        assert.deepEqual(geometry.titleHits, [true, true, true]); assert.equal(geometry.originalNodes, true)
        assert.ok(geometry.modes.every(mode => mode.hit) && geometry.canvas.y >= geometry.header.bottom && geometry.canvas.y >= geometry.picker.bottom)
      }
    }
  }
  assert.equal(producer.frames.length, 2)
  for (const frame of producer.frames) assert.equal(hash(await readFile(frame.path)), frame.sha256, 'Exact independently reviewable original PNG')
  assert.deepEqual(producer.cleanup.remaining, [])
  const reuse = { schema: 'agentmux.recall-graph-title-reuse.v1', passed: true, newCapture: false,
    original: { path, sha256: hash(bytes), producerScript: producerSource, producerScriptSha256: producer.owned[script] },
    wrapper: { file: script, sha256: current[script] }, currentOwning: current, styles: producer.styles, frames: producer.frames,
    boundary: producer.boundary, cleanup: producer.cleanup }
  const output = join(evidence, 'receipt-reuse.json')
  await writeFile(output, JSON.stringify(reuse, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, reused: true, newCapture: false, receipt: output, original: path }))
  process.exit(0)
}
const run = join(evidence, 'runs', randomUUID())
await mkdir(run, { recursive: true })
let privateRoot
const receipt = { schema: 'agentmux.recall-graph-title.v1', passed: false, aestheticReview: 'pending',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  owned: await sourceHashes(), actualInputs: {}, frames: [], callers: [],
  boundary: 'Current original Recall surface and Graph consumers with full Desktop CSS. Private original Preview configuration/catalog and unavailable Graph owner. Exact geometry and trusted recovery actions; no successful Host graph, live Runtime, IME, durable restart, topology change or installed App claim.' }
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const source = await readFile(join(root, cssFile), 'utf8')
  assert.equal(source.split(rule).length - 1, 1, 'One scoped original production alignment rule')
  // These checks identify the real mounted consumer; the Renderer below proves behavior.
  for (const [file, expression, description] of [
    ['apps/desktop/src/renderer/src/components/GlobalRecallSurface.tsx', /<NotebookHome\b/u, 'Recall → original NotebookHome'],
    ['apps/desktop/src/renderer/src/components/NotebookNavigation.tsx', /view === 'graph' \? <NotebookGraph\b/u, 'Original local directory view → NotebookGraph'],
    ['apps/desktop/src/renderer/src/components/NotebookViews.tsx', /return <NoteCanvas scope=\{\{ kind: 'notebook', notebookId \}\}/u, 'NotebookGraph → original notebook-scoped NoteCanvas'],
    ['apps/desktop/src/renderer/src/components/NoteCanvas.tsx', /useNoteCanvasObservation\(active\)/u, 'NoteCanvas → original observation and explicit refresh owner']
  ]) {
    assert.match(await readFile(join(root, file), 'utf8'), expression)
    receipt.callers.push({ file, description })
  }
  const cachePath = join(evidence, 'build.json')
  let cached
  try { cached = JSON.parse(await readFile(cachePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (cached) {
    assert.deepEqual(compilationOwners(cached.owned), compilationOwners(receipt.owned), 'An existing compiled proof requires exact current product and Renderer fixture owners; preserve it before an intentional rebuild')
    // Workbench imports these sibling readers, but this unavailable-Graph scene never mounts them.
    // Keep their original compiled inputs explicit; their separate proofs own current behavior.
    const unrenderedSiblings = new Set(['packages/client-ui/src/components/ConversationView.tsx', 'packages/client-ui/src/components/NativeProcessObservation.tsx'])
    receipt.unrenderedSiblingDrift = []
    for (const [file, sha256] of Object.entries(cached.actualInputs)) {
      const current = hash(await readFile(join(root, file)))
      if (unrenderedSiblings.has(file) && current !== sha256) receipt.unrenderedSiblingDrift.push({ file, compiledSource: sha256, current, rendered: false })
      else assert.equal(current, sha256, 'Exact actual-loaded source for Renderer reuse: ' + file)
    }
    privateRoot = cached.privateRoot
    for (const [file, sha256] of Object.entries(cached.compiled)) assert.equal(hash(await readFile(join(privateRoot, 'renderer', file))), sha256, 'Exact preserved original compiled bytes')
    receipt.build = { ...cached, reused: true }
    receipt.actualInputs = cached.actualInputs
  } else {
    privateRoot = await mkdtemp(join(tmpdir(), 'amx-recall-title-'))
    const compiled = join(privateRoot, 'renderer')
    const host = join(root, 'apps/host'), exports = JSON.parse(await readFile(join(host, 'package.json'), 'utf8')).exports
    const hostAliases = Object.entries(exports).map(([key, value]) => ({ find: '@agentmux/host' + key.slice(1),
      replacement: join(host, value.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts')) }))
    const { build } = await import(pathToFileURL(require.resolve('vite')).href)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
      resolve: { alias: [...hostAliases, ...aliases] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'original-recall-title-consumer-inputs', enforce: 'pre', transform(code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/') && /\.(?:[cm]?[jt]sx?|css)$/u.test(file)) receipt.actualInputs[relative(root, file)] = hash(code)
      } }], build: { target: 'esnext', minify: false, outDir: compiled, emptyOutDir: true, rollupOptions: { maxParallelFileOps: 8 } } })
    const output = Object.fromEntries(await Promise.all((await allFiles(compiled)).map(async file => [relative(compiled, file), hash(await readFile(file))])))
    receipt.build = { privateRoot, compiled: output, actualInputs: receipt.actualInputs, owned: receipt.owned, builds: 1, reused: false }
    await writeFile(cachePath, JSON.stringify(receipt.build, null, 2) + '\n')
  }
  const compiled = join(privateRoot, 'renderer')
  for (const file of owners.filter(file => /\.(?:tsx?|mjs)$/u.test(file) && !file.endsWith('/main.cjs') && !file.endsWith('/verify-recall-graph-title.mjs'))) {
    assert.ok(receipt.actualInputs[file], 'Original consumer actually loaded: ' + file)
  }
  const compiledCss = []
  for (const file of Object.keys(receipt.build.compiled).filter(file => file.endsWith('.css'))) {
    if ((await readFile(join(compiled, file), 'utf8')).includes(source)) compiledCss.push(file)
  }
  assert.equal(compiledCss.length, 1, 'The compiled full Desktop stylesheet contains exact complete original NoteCanvas CSS')
  const css = compiledCss[0], candidateCss = await readFile(join(compiled, css), 'utf8')
  const privateSource = join(privateRoot, 'production-source', 'note-canvas.css')
  await mkdir(join(privateRoot, 'production-source'), { recursive: true })
  await writeFile(privateSource, source.replace(rule, ''))
  const mutationSource = await readFile(privateSource, 'utf8')
  const mutantCss = candidateCss.replace(source, mutationSource)
  assert.notEqual(hash(mutantCss), hash(candidateCss))
  assert.equal(mutantCss.includes(rule), false)
  const mutantCssName = css.replace(/\.css$/u, '-without-title-alignment.css')
  await writeFile(join(compiled, mutantCssName), mutantCss)
  const html = await readFile(join(compiled, 'index.html'), 'utf8')
  assert.equal(html.split(css).length - 1, 1)
  const mutantHtml = join(compiled, 'without-title-alignment.html')
  await writeFile(mutantHtml, html.replace(css, mutantCssName))
  receipt.styles = { owner: cssFile, source: hash(source), fullOriginalSourceInCompiled: true, compiled: css,
    candidate: hash(candidateCss), mutated: hash(mutantCss), privateSource: hash(mutationSource), mutation: 'Remove only the scoped production alignment rule; all other compiled CSS and JavaScript stay exact.' }
  const outcomes = []
  for (const label of ['green', 'red', 'restored']) {
    const processRoot = await mkdtemp(join(privateRoot, label + '-'))
    const logs = []
    const process = await runProbeProcess(desktopRequire('electron'), [join(fixture, 'main.cjs'), label === 'red' ? mutantHtml : join(compiled, 'index.html'), processRoot, run, label],
      { cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
    await writeFile(join(run, label + '.log'), logs.join('\n'))
    const actual = JSON.parse(await readFile(join(run, label + '.json'), 'utf8'))
    outcomes.push({ label, process, actual })
    assert.equal(process.timedOut, false)
    assert.equal(process.exitConfirmed, true)
    if (label === 'red') {
      assert.equal(process.exitCode, 1)
      assert.equal(actual.passed, false)
      assert.match(actual.failure?.message ?? '', /Original Notebook title and mode row remain above their Graph canvas/u, 'The mutant fails the actual title geometry, not setup')
      assert.equal(actual.cases.length, 1)
    } else {
      assert.equal(process.exitCode, 0, actual.failure?.message)
      assert.equal(actual.passed, true)
      assert.equal(actual.cases.length, 3)
      if (label === 'green') for (const frame of actual.frames) {
        assert.equal(hash(await readFile(join(run, frame.file))), frame.sha256)
        receipt.frames.push({ ...frame, path: join(run, frame.file) })
      }
    }
  }
  receipt.cases = outcomes
  assert.equal(receipt.frames.length, 2)
  assert.deepEqual(await sourceHashes(), receipt.owned, 'Original owning source and harness remain unchanged through the actual proof')
  receipt.passed = true
} catch (error) {
  receipt.failure = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  receipt.cleanup = { remaining: privateRoot ? await listProbeProcesses(-1, privateRoot) : [], compiledPreservedForExactReuse: true, userRuntimeTouched: false }
  await writeFile(join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, frames: receipt.frames.length, receipt: join(run, 'receipt.json'), failure: receipt.failure?.message }))
}
