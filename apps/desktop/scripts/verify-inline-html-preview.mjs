import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const require = createRequire(import.meta.url), { build } = await import('vite')
const viteRequire = createRequire(require.resolve('vite')), esbuild = viteRequire('esbuild'), ts = require('typescript')
const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const rendererRoot = join(desktop, 'src/renderer/src'), fixture = join(desktop, 'scripts/fixtures/inline-html-preview')
const arg = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const evidence = arg('--output') ? resolve(repository, arg('--output')) : join(repository, 'docs/reviews/evidence/editor-inline-html')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const rendererModules = ['components/HtmlFilePreview.tsx', 'components/FileSurfaceView.tsx', 'components/EditorPane.tsx', 'components/FileSourceEditor.tsx',
  'components/WorkspaceWorkbench.tsx', 'components/FileExplorer.tsx', 'components/DesktopClientUiProvider.tsx', 'lib/file-region-presentation.ts',
  'lib/workbench-tabs.ts', 'lib/file-workbench-state.ts', 'lib/workface-file-view.ts', 'lib/api.ts', 'store.ts', 'styles/file-preview.css']
const productionFiles = [...rendererModules.map(file => 'apps/desktop/src/renderer/src/' + file), 'apps/desktop/src/main/html-file-previews.ts',
  'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/ipc-sender-trust.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/shared/workspace-file-format.ts', 'apps/desktop/src/shared/workspace-file-bytes.ts', 'apps/desktop/src/renderer/index.html',
  'apps/desktop/native/workspace-move.c', 'apps/desktop/resources/bin/agentmux-workspace-move']
async function bindings() {
  const sources = {}
  for (const file of [...productionFiles, 'docs/design/behavior/files-and-git.md', 'docs/design/presentation/files-and-git.md', 'apps/desktop/scripts/verify-inline-html-preview.mjs']) sources[file] = sha(await readFile(join(repository, file)))
  for (const file of (await readdir(fixture)).sort()) sources['apps/desktop/scripts/fixtures/inline-html-preview/' + file] = sha(await readFile(join(fixture, file)))
  return { sources, digest: sha(JSON.stringify(sources)) }
}
async function callers() {
  const edges = [
    ['FileSurfaceView', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'],
    ['HtmlFilePreview', 'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx'],
    ['api.files.openHtmlPreview', 'apps/desktop/src/renderer/src/components/HtmlFilePreview.tsx'],
    ['api.files.releaseHtmlPreview', 'apps/desktop/src/renderer/src/components/HtmlFilePreview.tsx'],
    ['htmlPreviews.open', 'apps/desktop/src/main/ipc.ts'],
    ['htmlPreviews.release', 'apps/desktop/src/main/ipc.ts']
  ], facts = []
  for (const [symbol, file] of edges) {
    const bytes = await readFile(join(repository, file), 'utf8'), source = ts.createSourceFile(file, bytes, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), hits = []
    const visit = node => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === symbol) hits.push(node.getText(source))
      if (ts.isCallExpression(node) && node.expression.getText(source) === symbol) hits.push(node.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.ok(hits.length > 0, 'Actual production caller beyond import/definition: ' + symbol)
    facts.push({ symbol, file, hits })
  }
  const preload = await readFile(join(desktop, 'src/preload/index.ts'), 'utf8')
  for (const channel of ['files:openHtmlPreview', 'files:releaseHtmlPreview']) assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), 'Production file preload reaches ' + channel)
  return facts
}
async function currentSourceSet(sources, identity, label) {
  assert.ok(sources && Object.keys(sources).length > 0, label + ' source set is nonempty')
  for (const [file, expected] of Object.entries(sources)) {
    assert.equal(sha(await readFile(join(repository, file))), expected, label + ': current source ' + file)
    assert.equal(identity.sources[file], expected, label + ': same candidate as Chromium capture ' + file)
  }
}
async function rawLog(proof, label) {
  assert.ok(proof.log && proof.sha256, label + ' binds its raw log')
  const bytes = await readFile(join(evidence, proof.log))
  assert.equal(sha(bytes), proof.sha256, label + ' exact raw log hash')
  assert.ok(bytes.length > 0, label + ' raw log is nonempty')
  return bytes.toString('utf8')
}
await mkdir(evidence, { recursive: true })
const identity = await bindings(), realCallers = await callers()
if (process.argv.includes('--check')) {
  const capture = JSON.parse(await readFile(join(evidence, 'capture-receipt.json'), 'utf8'))
  assert.equal(capture.passed, true, 'Successful native Chromium capture exists')
  assert.deepEqual(capture.identity, identity, 'Capture consumes the current candidate')
  assert.equal(capture.sourceDigest, identity.digest)
  assert.ok(capture.frames.length > 0)
  assert.equal(capture.native.passed, true)
  assert.equal(capture.outcome.exitCode, 0)
  assert.deepEqual(capture.cleanup.remaining, [])
  const review = JSON.parse(await readFile(join(evidence, 'visual-review.json'), 'utf8'))
  assert.equal(review.approved, true, 'Independent Agent judged the exact screenshots deliverable')
  assert.ok(review.reviewer && review.reviewer !== 'html_native_probe', 'Reviewer is independent from the capture author')
  assert.equal(review.sourceDigest, identity.digest, 'Independent visual review binds the same candidate')
  assert.ok(review.screenshots.length > 0)
  for (const frame of capture.frames) {
    assert.equal(sha(await readFile(join(evidence, frame.file))), frame.sha256, 'Exact captured PNG: ' + frame.file)
    assert.equal(review.screenshots.find(item => item.file === frame.file)?.sha256, frame.sha256, 'Independent Agent opened exact PNG: ' + frame.file)
  }
  const mutations = JSON.parse(await readFile(join(evidence, 'mutation-receipt.json'), 'utf8'))
  assert.equal(mutations.passed, true)
  await currentSourceSet(mutations.sources, identity, 'Actual implementation mutations')
  assert.ok(mutations.mutations.length > 0, 'Mutation set is nonempty')
  for (const mutation of mutations.mutations) {
    assert.notEqual(mutation.red.exitCode, 0, mutation.name + ' produced red')
    assert.equal(mutation.red.assertionError, true, mutation.name + ' was an assertion failure')
    assert.ok((await rawLog(mutation.red, mutation.name)).includes('AssertionError'), mutation.name + ' raw log contains AssertionError')
  }
  assert.equal(mutations.restoredGreen.exitCode, 0)
  assert.match(await rawLog(mutations.restoredGreen, 'Restored implementation'), /\bpassed\b/)
  const acceptance = { schema: 'agentmux.inline-html-acceptance.v1', passed: true, identity, callers: realCallers, capture, mutations, independentVisualReview: review, boundary: capture.boundary }
  await writeFile(join(evidence, 'acceptance-receipt.json'), JSON.stringify(acceptance, null, 2))
  console.log(JSON.stringify({ passed: true, sourceDigest: identity.digest, receipt: join(evidence, 'acceptance-receipt.json') }))
} else {
  const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-inline-html-")), profile = join(privateRoot, 'profile'), workspace = join(privateRoot, 'workspace'), outDir = join(privateRoot, 'out')
  const result = { schema: 'agentmux.inline-html-capture.v1', passed: false, sourceDigest: identity.digest, identity, callers: realCallers, frames: [], userRunTouched: false,
    boundary: 'Actual production WorkspaceWorkbench/FileExplorer/FileSurfaceView/HtmlFilePreview/Monaco/CSS. Production preload file IPC enters real WorkspaceFiles and HtmlFilePreviews in a private Electron/profile/workspace. Native Chromium WebFrameMain observes current-buffer scripts/assets and opaque sandbox isolation; CDP pointer and keyboard input operate actual controls. IPC registration is a narrow private fixture with original-frame admission. Core/config/Git/Browser facts outside files are controlled. Fault/delay injection is fixture transport only. No user App, installed package, Session lifecycle, restart or real CLI claim; independent visual review and public CLI evidence are separate.' }
  try {
    await mkdir(workspace)
    await mkdir(profile)
    for (const [source, target] of [['page.html', 'index.html'], ['preview.css', 'preview.css'], ['behavior.mjs', 'behavior.mjs'], ['motif.svg', 'motif.svg']]) await copyFile(join(fixture, source), join(workspace, target))
    await writeFile(join(workspace, 'notes.md'), '# Release checklist\n\nKeep the draft close to its source.\n\n- Review the layout\n- Try the page interaction\n- Keep the original file\n\nThe preview shares this workspace.\n')
    await writeFile(join(privateRoot, 'outside-private.txt'), 'PRIVATE_OUTSIDE_SENTINEL')
    const before = {}
    for (const name of (await readdir(workspace)).sort()) before[name] = sha(await readFile(join(workspace, name)))
    result.originalFiles = before
    const loaded = {}, styles = {}
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
      plugins: [{ name: 'inline-html-source-identity', enforce: 'pre', transform(bytes, id) { if (id.startsWith(rendererRoot + '/') && !id.includes('?')) loaded[id.slice(rendererRoot.length + 1)] = sha(bytes) },
        async generateBundle() { for (const file of this.getWatchFiles()) if (file.startsWith(rendererRoot + '/') && file.endsWith('.css')) styles[file.slice(rendererRoot.length + 1)] = sha(await readFile(file)) } }],
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir, emptyOutDir: true } })
    for (const file of rendererModules.filter(file => !file.endsWith('.css'))) assert.equal(loaded[file], identity.sources['apps/desktop/src/renderer/src/' + file], 'Actual product module compiled: ' + file)
    for (const file of rendererModules.filter(file => file.endsWith('.css'))) assert.equal(styles[file], identity.sources['apps/desktop/src/renderer/src/' + file], 'Actual product stylesheet compiled: ' + file)
    // Keep the production import.meta.dirname-relative native helper address intact.
    // The helper is the real production binary, copied into this invocation's private tree.
    const nativeModule = join(privateRoot, 'native/src/main/native-file-owner.mjs')
    const nativeHelper = join(privateRoot, 'native/resources/bin/agentmux-workspace-move')
    await mkdir(join(privateRoot, 'native/resources/bin'), { recursive: true })
    await copyFile(join(desktop, 'resources/bin/agentmux-workspace-move'), nativeHelper)
    await esbuild.build({ entryPoints: [join(fixture, 'native-file-owner.ts')], outfile: nativeModule, bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
    await esbuild.build({ entryPoints: [join(fixture, 'preload.ts')], outfile: join(privateRoot, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error' })
    const compiled = {}
    for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) compiled[join(entry.parentPath, entry.name).slice(outDir.length + 1)] = sha(await readFile(join(entry.parentPath, entry.name)))
    assert.ok(Object.keys(compiled).length > 0)
    result.compiled = { files: compiled, loadedSources: loaded, styles, mainSha256: sha(await readFile(nativeModule)), preloadSha256: sha(await readFile(join(privateRoot, 'preload.cjs'))), nativeHelperSha256: sha(await readFile(nativeHelper)) }
    const main = join(privateRoot, 'main.cjs')
    await copyFile(join(fixture, 'main.cjs'), main)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const lines = []
    result.outcome = await runProbeProcess(require('electron'), [main, join(outDir, 'index.html'), profile, evidence, nativeModule, workspace], { temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 120000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, 'native-process.log'), lines.join('\n'))
    result.native = JSON.parse(await readFile(join(evidence, 'native-render.json'), 'utf8'))
    assert.equal(result.outcome.exitCode, 0, result.native.failure?.message)
    assert.equal(result.native.passed, true)
    for (const frame of result.native.frames) result.frames.push({ ...frame, sha256: sha(await readFile(join(evidence, frame.file))) })
    const after = {}
    for (const name of (await readdir(workspace)).sort()) after[name] = sha(await readFile(join(workspace, name)))
    assert.deepEqual(after, before, 'Current-buffer preview never writes workspace bytes')
    result.originalFilesAfter = after
    assert.deepEqual(await bindings(), identity, 'Relevant candidate sources stayed unchanged during capture')
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    for (const pid of await listProbeProcesses(-1, privateRoot)) await signalOwnedProbeProcess(pid, privateRoot, 'SIGKILL')
    result.cleanup = { remaining: await listProbeProcesses(-1, privateRoot) }
    assert.deepEqual(result.cleanup.remaining, [])
    await rm(privateRoot, { recursive: true, force: true })
    await writeFile(join(evidence, 'capture-receipt.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ passed: result.passed, evidence, sourceDigest: identity.digest, failure: result.failure ?? null }))
    process.exitCode = result.passed ? 0 : 1
  }
}
