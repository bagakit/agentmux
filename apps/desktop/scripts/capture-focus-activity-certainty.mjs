import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

assert.equal(process.argv.length, 6); assert.equal(process.argv[2], '--source'); assert.equal(process.argv[4], '--evidence')
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const sourcePath = resolve(process.argv[3]), evidence = resolve(process.argv[5]); await mkdir(evidence, { recursive: true })
const source = JSON.parse(await readFile(sourcePath, 'utf8'))
// The independent lane scene can proceed with accepted behavior even when the
// whole Desktop types expose a separately preserved Main Mote/FileExplorer error.
assert.deepEqual(source.owning.map(item => [item.collected, item.passed, item.failed]), [[6, 6, 0], [7, 7, 0]])
assert.equal(source.mutations.length, 3); assert.ok(source.mutations.every(item => item.red.failed > 0 && item.green.failed === 0))
assert.equal(source.adjacent.failed, 0); assert.equal(source.adjacent.collected, 42)
assert.ok(source.types.some(item => item.label === 'core-production' && item.code === 0))
const fixture = join(desktop, 'scripts/fixtures/focus-activity-certainty'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const seedPath = resolve(sourcePath, '..', 'public-scene-seed.json'), seedBytes = await readFile(seedPath), seed = JSON.parse(seedBytes)
assert.equal(seed.schema, 'agentmux.activity-certainty-public-scene-seed.v1')
assert.deepEqual(seed.rows.map(row => row.observation.semantic), ['unknown', 'unknown', 'active', 'idle'])
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-activity-certainty-')), inputs = new Map(), transformations = [], logs = []
const receipt = { schema: 'agentmux.focus-activity-certainty-scene.v1', passed: false, authorAgentId: '/root/focus_formal_resume_intake',
  sourceQualification: { path: relative(root, sourcePath), sha256: hash(await readFile(sourcePath)), passed: source.passed,
    typeFailure: source.failure?.message ?? null, boundary: 'Scene behavior and visual scope only; this scene does not change the preserved whole Source type failure or finish the Task.' },
  publicSeed: { path: relative(root, seedPath), sha256: hash(seedBytes), rows: seed.rows.map(row => ({ id: row.session.agentSessionId, semantic: row.observation.semantic, process: row.run.state })), boundary: seed.boundary },
  boundary: 'Actual compiled Global/Store/projection/Row/menu and styles with public Client/private FileStore seed. Fixed Run transport, unrelated PTY/independent Timeline/editor paint isolated. Requester automation only; no physical OS input, Provider Writer, Runtime, real healthy Run or installation.' }
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await writeFile(join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0)
  for (const [file, sha] of Object.entries(seed.inputs)) { assert.equal(hash(await readFile(join(root, file))), sha, 'Exact actual public seed Source ' + file); inputs.set(join(root, file), sha) }
  const observe = { name: 'actual-activity-certainty-source', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path, 'utf8'); inputs.set(path, hash(bytes)); const component = path.slice(path.lastIndexOf('/') + 1)
      if (['SessionPane.tsx', 'RecentFocusTimeline.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx'].includes(component)) {
        const code = `export function ${component.slice(0, -4)}(){return null}`
        transformations.push({ path: relative(root, path), sourceSHA256: hash(bytes), loadedSHA256: hash(code),
          isolated: component === 'RecentFocusTimeline.tsx' ? 'Independent T002 Timeline/history scene, no certainty-lane code altered' : 'Unselected native/Monaco paint; no lifecycle, input or displayed workface replaced' })
        return { contents: code, loader: 'js' }
      }
      return { contents: bytes, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const bytes = await readFile(path, 'utf8'); inputs.set(path, hash(bytes)); return { contents: bytes, loader: 'css' } })
  } }
  for (const path of [join(fixture, 'entry.mjs'), join(fixture, 'main.cjs'), new URL(import.meta.url).pathname]) inputs.set(path, hash(await readFile(path)))
  const out = join(evidence, 'compiled'); await mkdir(out, { recursive: true })
  const compiled = await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true, plugins: [observe], logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = compiled.metafile; receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha])); receipt.transformations = transformations
  for (const path of ['packages/core/src/agent-status-freshness.ts', 'apps/desktop/src/renderer/src/lib/focus-context.ts', 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'apps/desktop/src/renderer/src/components/FocusContextRow.tsx']) {
    assert.equal(receipt.inputs[path], source.sourceBefore[path], 'Same Source qualification product ' + path)
  }
  for (const name of ['GlobalFocusSurface.tsx', 'store.ts', 'focus-context.ts', 'FocusContextRow.tsx', 'FocusContextMenu.tsx', 'FocusLaneGroups.tsx', 'focus-lane-layout.ts', 'HoverDropdownMenu.tsx', 'agent-status-freshness.js', 'index.css', 'focus.css']) assert.ok([...inputs.keys()].some(path => path.endsWith('/' + name)), 'Actual compiled input ' + name)
  await writeFile(join(out, 'public-scene-seed.json'), seedBytes)
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(join(out, 'app.js'))), css: hash(await readFile(join(out, 'app.css'))) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  const actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8')); receipt.actual = actual
  assert.equal(receipt.process.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
  receipt.frames = await Promise.all(actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.path))) })))
  assert.equal(receipt.frames.length, 2); receipt.activityCertainty = actual.activityCertainty
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => [relative(root, path), hash(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n')); const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { remainingProcesses: remaining.length, remaining, privateRoot, removed: false, compiledBytesPreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure?.message, pendingIndependentImageReview: true }))
}
