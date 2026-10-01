import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const args = process.argv.slice(2)
const expectedImages = [
  'toolbar-context-actions-wide.png', 'toolbar-context-actions-more-wide.png',
  'toolbar-context-actions-640.png', 'toolbar-context-actions-360.png',
  'toolbar-context-actions-region-only-360.png', 'keyboard-exact-Mote-discussion-pending.png',
  'late-preparation-keeps-current-input.png', 'same-Mote-newborn-request-wide.png',
  'same-Mote-newborn-request-narrow.png', 'restored-original-workface-and-discussion-wide.png',
  'restored-same-Mote-request-wide.png'
]
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--consume-receipt', 'Only an explicit exact receipt may be consumed')
if (args.length) {
  const path = resolve(root, args[1]), previous = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(previous.schema, 'agentmux.focus-toolbar-context-actions-scene.v1'); assert.equal(previous.capturedPass, true)
  assert.equal(previous.phases.length, 2)
  assert.notEqual(previous.phases[0].actual.pid, previous.phases[1].actual.pid)
  assert.equal(previous.phases[0].actual.seedCount, 1); assert.equal(previous.phases[1].actual.seedCount, 0)
  assert.ok(previous.phases.every(item => item.actual.passed && item.process.exitCode === 0))
  assert.ok(Object.keys(previous.inputs).length > 12); assert.deepEqual(previous.sourceAfter, previous.inputs)
  for (const [file, sha] of Object.entries(previous.inputs)) assert.equal(createHash('sha256').update(await readFile(join(root, file))).digest('hex'), sha, 'Current captured input: ' + file)
  assert.deepEqual(previous.frames.map(frame => frame.image).sort(), [...expectedImages].sort(), 'Exact finite eleven-image qualification')
  for (const frame of previous.frames) assert.equal(createHash('sha256').update(await readFile(resolve(path, '..', frame.image))).digest('hex'), frame.sha256, 'Full captured image: ' + frame.image)
  console.log(JSON.stringify({ consumedExactReceipt: path, capturedPass: true, sourceAndImagesCurrent: true, privateProcessesNotRepeated: true }))
  process.exit(0)
}
const evidence = join(root, '.bagakit/feature-tracker/focus-identity-consistency-artifacts/toolbar-context-actions', 'scene-' + globalThis.crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-toolbar-context-actions-'))
const fixture = join(desktop, 'scripts/fixtures/focus-toolbar-context-actions')
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map(), transformations = [], logs = []
const receipt = { schema: 'agentmux.focus-toolbar-context-actions-scene.v1', capturedPass: false, aestheticReview: 'pending independent full-image review',
  actualUserAppOrRunControlled: false, phases: [],
  boundary: 'Actual Global/Toolbar/Store initialize and persistence, precise spatial catalog/navigation, Mote entry/floating panel/Launcher/new discussion and Tab formatter. Maintained typed Session API, no actual Core/PTY/Run/CLI delivery. Original configured Mote has unconfirmed executor, so its exact newborn request is kept. Actual private Electron PID exit -> new PID on same Chromium profile, no second seed. Native terminal/Monaco paint alone isolated.' }
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await writeFile(join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0, 'Original current source/dist guard')
  const observe = { name: 'actual-toolbar-context-action-source-binding', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); const component = path.slice(path.lastIndexOf('/') + 1)
      if (['TerminalView.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx'].includes(component)) {
        const code = `export function ${component.slice(0, -4)}(){return null}`
        transformations.push({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), isolated: 'Native PTY/Monaco paint only; no Store, identity, Toolbar, navigation, Composer or Mote owner substitution' })
        return { contents: code, loader: 'js' }
      }
      return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); return { contents: source, loader: 'css' } })
    builder.onLoad({ filter: /\.(png|svg|woff2?|ttf)$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const source = await readFile(path); inputs.set(path, hash(source)); return { contents: source, loader: 'file' } })
  } }
  for (const path of [join(fixture, 'entry.mjs'), join(fixture, 'main.cjs'), new URL(import.meta.url).pathname]) inputs.set(path, hash(await readFile(path)))
  const out = join(privateRoot, 'out'); await mkdir(out)
  const built = await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true, plugins: [observe], logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = built.metafile; receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha])); receipt.transformations = transformations
  for (const suffix of ['FocusToolbar.tsx', 'GlobalFocusSurface.tsx', 'store.ts', 'workbench-tab-presentation.ts', 'workbench-projection.ts', 'focus-tab-projection.ts', 'agent-address.ts', 'primary-mote-executor.ts', 'pmo-teams-topic-floating.ts', 'PmoTeamsTopicFloatingPanel.tsx', 'PmoTeamsTopicEntry.tsx', 'NewTabSurface.tsx']) assert.ok([...inputs.keys()].some(path => path.endsWith('/' + suffix)), 'Nonempty actual module ' + suffix)
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><style>html,body,#root{height:100%;width:100%;margin:0;overflow:hidden}</style><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(join(out, 'app.js'))), css: hash(await readFile(join(out, 'app.css'))) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'profile'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const processReceipt = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence, phase], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(phase + ': ' + line) })
    const actual = await readFile(join(evidence, phase + '.json'), 'utf8').then(JSON.parse).catch(() => ({
      passed: false, phase, failure: { message: 'Private process did not produce a completed phase receipt; inspect retained process evidence' }
    }))
    receipt.phases.push({ process: processReceipt, actual }); assert.equal(processReceipt.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
  }
  assert.notEqual(receipt.phases[0].actual.pid, receipt.phases[1].actual.pid, 'Two actual Electron processes')
  assert.equal(receipt.phases[0].actual.seedCount, 1); assert.equal(receipt.phases[1].actual.seedCount, 0)
  receipt.frames = await Promise.all(receipt.phases.flatMap(item => item.actual.frames).map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.image))) })))
  assert.deepEqual(receipt.frames.map(frame => frame.image).sort(), [...expectedImages].sort(), 'Full wide/narrow action/Region/Mote/restart images')
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => [relative(root, path), hash(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Exact nonempty source stable during full capture')
  receipt.capturedPass = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { privateRoot, remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, pendingIndependentVisualReview: true }))
}
