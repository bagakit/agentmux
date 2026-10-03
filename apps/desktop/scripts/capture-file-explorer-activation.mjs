import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink } from 'node:fs/promises'
import { dirname, resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { build } from 'vite'
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite'))('esbuild')
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/file-surface-quality/visual')
const evidence = join(root, '.tmp/file-explorer-activation-visual')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
if (!process.argv.includes('--capture-only')) {
  const report = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
  assert.equal(report.passed, true); assert.equal(report.frames.length, 4)
  assert.ok(Object.keys(report.sourceHashes).length > 0)
  for (const [path, expected] of Object.entries(report.sourceHashes)) assert.equal(sha(await readFile(join(root, path))), expected, 'Reviewed candidate ' + path)
  for (const frame of report.frames) assert.equal(sha(await readFile(join(evidence, frame.file))), frame.sha256)
  const review = JSON.parse(await readFile(join(evidence, 'independent-review.json'), 'utf8'))
  assert.equal(review.passed, true); assert.ok(review.reviewer && review.reviewer !== '/root')
  assert.deepEqual(review.frames, report.frames.map(({ file, sha256 }) => ({ file, sha256 })), 'Review binds exact full frames')
  console.log(JSON.stringify({ passed: true, evidence, reviewer: review.reviewer, reused: true }))
  process.exit(0)
}
const temporary = await mkdtemp(_hygiene_fixturePath("tmp/amx-file-activation-")), workspace = join(temporary, 'workspace'), profile = join(temporary, 'profile'), out = join(temporary, 'out')
const report = { schema: 'agentmux.file-explorer-activation-scene.v1', passed: false, frames: [], sourceHashes: {}, processes: [],
  boundary: 'Actual compiled Explorer/Store/Workbench/Monaco and production preload into native WorkspaceFiles/Core spatial owner; actual Chromium mouse and insertText. Private Focus placeholder only supplies non-workbench display selection, not real Focus paint or native Agent proof. Two ordinary private processes; no user App or Run touched.' }
await mkdir(evidence, { recursive: true })
try {
  await mkdir(workspace); await mkdir(profile); await mkdir(join(workspace, 'assets'))
  const files = { 'code.ts': 'export const original = 42\n', 'notes.md': '# Original neighbour\n\nThe same document and draft remain.\n',
    'assets/inside.ts': 'export const inside = true\n',
    'drawing.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#dce9e4"/><circle cx="320" cy="190" r="110" fill="#598c82"/><text x="180" y="350" font-family="sans-serif" font-size="22" fill="#273b42">Original file preview</text></svg>' }
  for (const [path, content] of Object.entries(files)) await writeFile(join(workspace, path), content)
  const pluginFile = join(temporary, 'pdf-assets.mjs')
  await esbuild.build({ entryPoints: [join(desktop, 'scripts/pdfjs-viewer-assets.ts')], outfile: pluginFile, platform: 'node', format: 'esm', bundle: true, logLevel: 'error' })
  const { pdfjsViewerAssets } = await import(pluginFile)
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    plugins: [pdfjsViewerAssets(dirname(require.resolve('pdfjs-dist/package.json'))), { name: 'activation-source-binding', enforce: 'pre', async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + '/') && !file.includes('/node_modules/') && /\.(?:tsx?|css|html)$/.test(file)) report.sourceHashes[relative(root, file)] = sha(await readFile(file))
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir: out, emptyOutDir: true } })
  const nativeModule = join(temporary, 'native.mjs')
  const nativeBuild = await esbuild.build({ entryPoints: [join(fixture, 'native-file-owner.ts')], outfile: nativeModule, bundle: true, platform: 'node', format: 'esm', external: ['@agentmux/core/spatial-state'], metafile: true, logLevel: 'error' })
  for (const path of Object.keys(nativeBuild.metafile.inputs)) {
    const file = resolve(path)
    if (file.startsWith(root + '/') && !file.includes('/node_modules/')) report.sourceHashes[relative(root, file)] = sha(await readFile(file))
  }
  await symlink(join(desktop, 'node_modules'), join(temporary, 'node_modules'), 'dir')
  await esbuild.build({ entryPoints: [join(fixture, 'preload.ts')], outfile: join(temporary, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error' })
  await copyFile(join(fixture, 'main.cjs'), join(temporary, 'main.cjs'))
  for (const path of ['apps/desktop/scripts/capture-file-explorer-activation.mjs', 'apps/desktop/scripts/fixtures/file-surface-quality/visual/main.cjs', 'apps/desktop/scripts/fixtures/file-surface-quality/visual/preload.ts', 'apps/desktop/scripts/pdfjs-viewer-assets.ts', 'pnpm-lock.yaml']) report.sourceHashes[path] = sha(await readFile(join(root, path)))
  const spatial = fileURLToPath(import.meta.resolve('@agentmux/core/spatial-state')); report.sourceHashes[relative(root, spatial)] = sha(await readFile(spatial))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['activation', 'activation-restart']) {
    const lines = [], outcome = await runProbeProcess(require('electron'), [join(temporary, 'main.cjs'), join(out, 'index.html'), profile, evidence, phase, nativeModule, workspace], { temporaryRoot: temporary, cwd: root, env, timeoutMs: 60000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, phase + '.log'), lines.join('\n'))
    const rendered = JSON.parse(await readFile(join(evidence, phase + '-render.json'), 'utf8')); report.processes.push({ phase, outcome, rendered })
    assert.equal(outcome.exitCode, 0, rendered.failure?.message); assert.equal(rendered.passed, true)
    for (const frame of rendered.frames) report.frames.push({ ...frame, sha256: sha(await readFile(join(evidence, frame.file))) })
  }
  assert.notEqual(report.processes[0].rendered.pid, report.processes[1].rendered.pid)
  assert.equal(report.processes[1].rendered.durable.passed, true)
  for (const [path, content] of Object.entries(files)) assert.equal(await readFile(join(workspace, path), 'utf8'), content)
  for (const [path, expected] of Object.entries(report.sourceHashes)) assert.equal(sha(await readFile(join(root, path))), expected, 'Stable compiled candidate ' + path)
  assert.equal(report.frames.length, 4); report.passed = true
} catch (error) { report.failure = { message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }; assert.equal(report.cleanup.remaining.length, 0)
  await rm(temporary, { recursive: true }); await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure?.message }))
assert.equal(report.passed, true)
