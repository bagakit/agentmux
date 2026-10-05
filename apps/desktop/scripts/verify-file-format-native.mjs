import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..'), require = createRequire(join(desktop, 'package.json'))
const { build } = await import('vite'), { build: bundle } = createRequire(require.resolve('vite/package.json'))('esbuild')
const fixture = join(desktop, 'scripts/fixtures/file-format-capabilities')
const outputArg = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
const evidence = outputArg ? resolve(repository, outputArg) : join(repository, '.bagakit/editor-format-implementation/evidence/file-format-native')
const diagnosticNotebookOnly = process.argv.includes('--diagnose-notebook')
const diagnosticRender = diagnosticNotebookOnly || process.argv.includes('--diagnose-render')
const staticUriMutation = process.argv.includes('--static-uri-mutation')
assert.ok(!staticUriMutation || diagnosticNotebookOnly, 'Static URI mutation is limited to the private Notebook consumer probe')
const staticMarkupFile = join(desktop, 'src/renderer/src/components/file-preview/StaticMarkupPreview.tsx')
const staticMarkupSource = await readFile(staticMarkupFile, 'utf8')
const staticUriAnchor = "FORBID_ATTR: ['srcdoc', 'srcset', 'target', 'action', 'formaction', 'autofocus']"
const staticUriAfter = staticUriAnchor + ",\n        ALLOWED_URI_REGEXP: /^(?:#|data:image\\/(?:png|jpeg|gif|webp);base64,)/i"
if (staticUriMutation) assert.equal(staticMarkupSource.split(staticUriAnchor).length - 1, 1, 'Unique old SVG URI mutation anchor')
const loadedStaticMarkup = staticUriMutation ? staticMarkupSource.replace(staticUriAnchor, staticUriAfter) : staticMarkupSource
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const roots = [
  'apps/desktop/src/renderer/src/components', 'apps/desktop/src/renderer/src/lib', 'apps/desktop/src/renderer/src/styles',
  'apps/desktop/src/renderer/file-diagram', 'apps/desktop/src/shared', 'packages/client-ui/src', 'packages/core/src',
  'packages/identity/src', 'packages/layout/src', 'packages/git/src', 'packages/demand/src', 'packages/relay/src',
  'apps/desktop/scripts/fixtures/file-format-capabilities', 'apps/desktop/scripts/fixtures/file-surface-quality/visual'
]
const singleFiles = ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/monaco.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/main/html-file-previews.ts',
  'apps/desktop/src/main/file-diagram-renderer.ts', 'apps/desktop/src/main/file-builds.ts', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/scripts/file-diagram-assets.ts', 'apps/desktop/scripts/excalidraw-local-fonts.ts',
  'apps/desktop/scripts/pdfjs-viewer-assets.ts', 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/scripts/verify-file-format-native.mjs',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/pdf-reader-fixture.ts',
  'apps/desktop/package.json', 'packages/client-ui/package.json', 'packages/core/package.json', 'packages/identity/package.json',
  'packages/layout/package.json', 'packages/git/package.json', 'packages/demand/package.json', 'packages/relay/package.json', 'pnpm-lock.yaml',
  'packages/core/bin/amux', 'packages/core/src/control.ts', 'packages/core/src/control-host.ts', 'packages/core/src/agentmux.ts',
  'packages/core/src/rpc-business-codec.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/space-control.ts', 'packages/core/src/space-control-parser.ts', 'packages/core/src/spatial-state.ts', 'vitest.dist-freshness.ts']
async function identity() {
  const files = [...singleFiles]
  for (const root of roots) for (const entry of await readdir(join(repository, root), { recursive: true, withFileTypes: true })) if (entry.isFile()) files.push(join(entry.parentPath, entry.name).slice(repository.length + 1))
  const sources = {}; for (const file of [...new Set(files)].sort()) sources[file] = sha(await readFile(join(repository, file)))
  return { sources, digest: sha(JSON.stringify(sources)) }
}
async function assertLoadedSources(sources) {
  assert.ok(sources && Object.keys(sources).length > 0, 'Actual product build inputs are nonempty')
  for (const [file, digest] of Object.entries(sources)) assert.equal(sha(await readFile(join(repository, file))), digest, 'Actual built source remains unchanged: ' + file)
}
function assertOutcome(outcome, message) {
  assert.equal(outcome.exitCode, 0, message)
  assert.equal(outcome.timedOut, false, 'Native capture completed before its watchdog')
  assert.equal(outcome.interruption, null, 'Native capture was not interrupted')
}
await mkdir(evidence, { recursive: true })
const candidate = await identity()
if (process.argv.includes('--check')) {
  const report = JSON.parse(await readFile(join(evidence, 'capture-receipt.json'), 'utf8'))
  assert.equal(report.passed, true); assert.deepEqual(report.identity, candidate); assert.equal(report.sourceDigest, candidate.digest)
  assert.equal(report.capture.passed, true); assert.equal(report.restart.passed, true); assert.notEqual(report.capture.pid, report.restart.pid)
  assertOutcome(report.captureOutcome); assertOutcome(report.restartOutcome); await assertLoadedSources(report.loadedSources)
  assert.ok(report.frames.length > 0); assert.ok(report.capture.cli.length > 0); assert.ok(report.capture.seen.length > 0); assert.deepEqual(report.cleanup.remaining, [])
  for (const frame of report.frames) assert.equal(sha(await readFile(join(evidence, frame.file))), frame.sha256, 'Exact native PNG ' + frame.file)
  const review = JSON.parse(await readFile(join(evidence, 'visual-review.json'), 'utf8')); assert.equal(review.approved, true); assert.equal(review.sourceDigest, candidate.digest)
  for (const frame of report.frames) assert.equal(review.screenshots.find(item => item.file === frame.file)?.sha256, frame.sha256, 'Independent review opened ' + frame.file)
  console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'capture-receipt.json'), sourceDigest: candidate.digest })); process.exit(0)
}
const temporary = await mkdtemp(_hygiene_fixturePath("tmp/amx-file-formats-")), profile = join(temporary, 'profile'), workspace = join(temporary, 'workspace'), renderer = join(temporary, 'renderer')
const result = { schema: 'agentmux.file-format-capture.v1', passed: false, sourceDigest: candidate.digest, identity: candidate, frames: [], userRunTouched: false,
  boundary: 'Production Workbench/FileExplorer/FileSurfaceView/Monaco/adapters/client-ui, production preload into real WorkspaceFiles/HTML/diagram/build owners, real Core ControlServer and independently spawned compiled CLI. Official local assets and native Chromium. Two ordinary Electron processes share a private durable profile. Config/Git/empty Agent facts are fixture-controlled; no installed App or real Agent Session recovery claim.' }
try {
  await mkdir(profile); await mkdir(workspace); await symlink(join(desktop, 'node_modules'), join(temporary, 'node_modules'))
  const freshnessModule = join(temporary, 'core-freshness.mjs')
  await bundle({ entryPoints: [join(repository, 'vitest.dist-freshness.ts')], outfile: freshnessModule, platform: 'node', format: 'esm', bundle: true, logLevel: 'error' })
  const { staleDistComplaint } = await import(pathToFileURL(freshnessModule).href)
  const compiledPackages = ['core', 'identity', 'git', 'demand', 'relay']
  for (const name of compiledPackages) {
    const packageDirectory = join(repository, 'packages', name), manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
    assert.equal(await staleDistComplaint(packageDirectory, manifest.exports['.'].import), null, 'Native public CLI must consume the current ' + name + ' build')
  }
  async function coreArtifacts() { const files = {}; for (const name of compiledPackages) for (const entry of await readdir(join(repository, 'packages', name, 'dist'), { recursive: true, withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.js')) { const file = join(entry.parentPath, entry.name); files[file.slice(repository.length + 1)] = sha(await readFile(file)) }; return files }
  result.coreCompiled = await coreArtifacts()
  const pluginModule = join(temporary, 'asset-plugins.mjs')
  await bundle({ stdin: { contents: `export { pdfjsViewerAssets } from './scripts/pdfjs-viewer-assets.ts'; export { fileDiagramAssets } from './scripts/file-diagram-assets.ts'`, resolveDir: desktop }, outfile: pluginModule, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', external: ['vite'] })
  const { pdfjsViewerAssets, fileDiagramAssets } = await import(pathToFileURL(pluginModule).href)
  const loaded = {}
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
    plugins: [{ name: 'private-static-markup-mutation', enforce: 'pre', load(id) { if (staticUriMutation && id === staticMarkupFile) return loadedStaticMarkup } }, pdfjsViewerAssets(), fileDiagramAssets(desktop), { name: 'format-native-actual-source', enforce: 'pre', async transform(_bytes, id) { const clean = id.split('?')[0]; if (clean === staticMarkupFile) { assert.equal(sha(_bytes), sha(loadedStaticMarkup), 'Actual source bytes consumed by the native Notebook'); result.staticMarkupLoaded = { file: clean.slice(repository.length + 1), sha256: sha(_bytes), mutated: staticUriMutation }; await writeFile(join(evidence, 'loaded-static-markup.ts'), _bytes) } if (clean.startsWith(repository + '/') && !clean.includes('/node_modules/') && !id.includes('?')) loaded[clean.slice(repository.length + 1)] = sha(await readFile(clean)) } }],
    build: { outDir: renderer, emptyOutDir: true } })
  // The production isolated diagram entry retains its real renderer-relative asset address.
  await build({ configFile: false, root: join(desktop, 'src/renderer'), base: './', logLevel: 'error',
    build: { outDir: renderer, emptyOutDir: false, rollupOptions: { input: join(desktop, 'src/renderer/file-diagram/index.html') } } })
  for (const file of ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/FileExplorer.tsx', 'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'apps/desktop/src/renderer/src/components/file-preview/SourceFilePreview.tsx']) assert.equal(loaded[file], candidate.sources[file], 'Actual product caller built: ' + file)
  result.loadedSources = loaded
  const nativeModule = join(temporary, 'native/src/main/native-file-owner.mjs'), helper = join(temporary, 'native/resources/bin/agentmux-workspace-move')
  await mkdir(dirname(helper), { recursive: true }); await cp(join(desktop, 'resources/bin/agentmux-workspace-move'), helper)
  await bundle({ entryPoints: [join(fixture, 'native-file-owner.ts')], outfile: nativeModule, bundle: true, platform: 'node', format: 'esm', external: ['electron', '@agentmux/core', '@agentmux/core/spatial-state'], logLevel: 'error' })
  await bundle({ entryPoints: [join(fixture, 'preload.ts')], outfile: join(temporary, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error' })
  await cp(join(fixture, 'main.cjs'), join(temporary, 'main.cjs'))
  result.compiled = {}; for (const entry of await readdir(renderer, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const file = join(entry.parentPath, entry.name); result.compiled[file.slice(renderer.length + 1)] = sha(await readFile(file)) }
  const htmlFile = 'index.html'; assert.ok(result.compiled[htmlFile], 'Real fixture HTML emitted in the product consumer build')
  const toolsRoot = _hygiene_fixturePath("tmp/agentmux-file-build-tools-fixture")
  const params = { html: join(renderer, htmlFile), profile, evidence, nativeModule: pathToFileURL(nativeModule).href, workspacePath: workspace, repository, node: process.execPath,
    diagnosticRender, diagnosticNotebookOnly, documentsModule: pathToFileURL(join(fixture, 'documents.mjs')).href, diagramFile: join(renderer, 'file-diagram/index.html'), compilers: { commands: { latex: join(toolsRoot, 'tectonic'), typst: join(toolsRoot, 'typst-aarch64-apple-darwin/typst') }, cache: join(toolsRoot, 'cache') } }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of diagnosticRender ? ['capture'] : ['capture', 'restart']) {
    const optionsFile = join(temporary, phase + '.json'); await writeFile(optionsFile, JSON.stringify({ ...params, phase }))
    await rm(join(evidence, phase + '-render.json'), { force: true })
    const lines = []; const outcome = await runProbeProcess(require('electron'), [join(temporary, 'main.cjs'), optionsFile], { temporaryRoot: temporary, cwd: repository, env, timeoutMs: 240000, onLine: line => lines.push(line) })
    result[phase + 'Outcome'] = outcome
    await writeFile(join(evidence, phase + '-process.log'), lines.join('\n')); const native = JSON.parse(await readFile(join(evidence, phase + '-render.json'), 'utf8'))
    result[phase] = native
    assertOutcome(outcome, native.failure?.message); assert.equal(native.passed, true)
    for (const frame of native.frames) result.frames.push({ ...frame, sha256: sha(await readFile(join(evidence, frame.file))) })
  }
  if (diagnosticRender) { result.diagnosticRender = true; result.diagnosticPassed = true } else {
  assert.notEqual(result.capture.pid, result.restart.pid); assert.deepEqual(result.capture.diskBefore, result.restart.diskAfter)
  assert.deepEqual(await coreArtifacts(), result.coreCompiled, 'Both processes and all real CLI calls consume the same Core artifacts')
  await assertLoadedSources(result.loadedSources)
  assert.deepEqual(await identity(), candidate, 'Native capture binds an unchanged candidate source set')
  result.passed = true
  }
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  result.cleanup = { remaining: await listProbeProcesses(-1, temporary) }; if (diagnosticRender) result.diagnosticTemporary = temporary; else await rm(temporary, { recursive: true, force: true })
  await writeFile(join(evidence, 'capture-receipt.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: result.passed, evidence, sourceDigest: candidate.digest, diagnosticPassed: result.diagnosticPassed ?? null, failure: result.failure ?? null })); process.exitCode = result.passed || result.diagnosticPassed ? 0 : 1
}
