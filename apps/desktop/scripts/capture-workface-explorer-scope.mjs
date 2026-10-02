import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

assert.equal(process.argv.length, 6); assert.equal(process.argv[2], '--source'); assert.equal(process.argv[4], '--evidence')
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const sourcePath = resolve(process.argv[3]), evidence = resolve(process.argv[5]); await mkdir(evidence, { recursive: true })
const sourceBytes = await readFile(sourcePath), source = JSON.parse(sourceBytes)
assert.equal(source.passed, true); assert.equal(source.owning.passed, 8); assert.equal(source.mutations.length, 2)
const fixture = join(desktop, 'scripts/fixtures/workface-explorer-scope'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-workface-explorer-')), inputs = new Map(), logs = []
const validation = ['apps/desktop/scripts/verify-workface-explorer-scope.mjs',
  'apps/desktop/scripts/capture-workface-explorer-scope.mjs',
  'apps/desktop/scripts/fixtures/workface-explorer-scope/main.cjs']
const receipt = { schema: 'agentmux.workface-explorer-scope-scene.v1', passed: false, authorAgentId: '/root/focus_formal_resume_intake',
  sourceQualification: { path: relative(root, sourcePath), sha256: hash(sourceBytes), passed: source.passed },
  readinessDelta: [],
  boundary: 'Actual compiled original Mote wrapper/material actions/Explorer/hook and original CSS. Filesystem and Git transport isolated; only unrelated conversation paint is a retained fixture child. Outer Mote stock chrome has no current stylesheet, a preserved adjacent P2; this qualifies modern Explorer/scope only. No physical Run, Native, recovery or installation.' }
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await writeFile(join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0)
  for (const [file, sha] of Object.entries(source.sourceAfter)) {
    const current = hash(await readFile(join(root, file)))
    if (current !== sha) {
      assert.ok(validation.includes(file), 'Only declared verification readiness may differ; product/test/config stay exact: ' + file)
      receipt.readinessDelta.push({ path: file, before: sha, after: current, reason: 'Remove unapproved 400px panel threshold; verify five actual visible modern rows/controls, preserve P2 chrome boundary and reuse actual qualified behavior.' })
    }
    inputs.set(join(root, file), current)
  }
  const observe = { name: 'actual-workface-explorer-source', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path, 'utf8'); inputs.set(path, hash(bytes))
      return { contents: bytes, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path, 'utf8'); inputs.set(path, hash(bytes)); return { contents: bytes, loader: 'css' }
    })
  } }
  for (const path of [join(fixture, 'entry.mjs'), join(fixture, 'main.cjs'), new URL(import.meta.url).pathname]) inputs.set(path, hash(await readFile(path)))
  const out = join(evidence, 'compiled'); await mkdir(out, { recursive: true })
  let compiled
  const previousPath = process.env.AGENTMUX_WORKFACE_EXPLORER_COMPILED_RECEIPT
  if (previousPath) {
    const previous = JSON.parse(await readFile(previousPath, 'utf8')), previousOut = resolve(previousPath, '..', 'compiled')
    assert.ok(previous.inputs && Object.keys(previous.inputs).length > 0 && previous.compiled && previous.metafile)
    for (const [file, sha] of Object.entries(previous.inputs)) {
      const current = hash(await readFile(join(root, file)))
      if (!validation.includes(file)) assert.equal(current, sha, 'Exact existing compiled Renderer/style input ' + file)
      inputs.set(join(root, file), current)
    }
    for (const [file, key] of [['app.js', 'renderer'], ['app.css', 'css']]) assert.equal(hash(await readFile(join(previousOut, file))), previous.compiled[key])
    await cp(previousOut, out, { recursive: true })
    compiled = { metafile: previous.metafile }
    receipt.compiledReuse = { path: relative(root, previousPath), sha256: hash(await readFile(previousPath)), previousScenePassed: previous.passed,
      reason: 'Verification-only readiness changes; original nonempty Renderer and stylesheet inputs and compiled bytes remain exact. Original failed scene remains preserved.' }
  } else compiled = await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true, plugins: [observe], logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = compiled.metafile; receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha]))
  for (const name of ['MoteWorkface.tsx', 'mote-workface.ts', 'mote-materials-actions.ts', 'FileExplorer.tsx', 'useWorkspaceFileTree.ts', 'index.css']) assert.ok([...inputs.keys()].some(path => path.endsWith('/' + name)), 'Actual compiled product/caller ' + name)
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(join(out, 'app.js'))), css: hash(await readFile(join(out, 'app.css'))) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.path))) })))
  assert.equal(receipt.frames.length, 1)
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => [relative(root, path), hash(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n')); const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { remainingProcesses: remaining.length, remaining, privateRoot, removed: false }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure?.message }))
}
