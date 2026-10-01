import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { createServer } from 'node:http'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from '../../probe-process.mjs'
import { sourceAliases } from './vitest.owning.config.mts'
const require = createRequire(import.meta.url), { build } = await import('vite'), esbuild = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceNames = ['src/shared/bookmark-file.ts', 'src/main/bookmark-file.ts', 'src/main/workspace-files.ts', 'src/main/pasted-image-read.ts', 'src/main/pasted-directory.ts',
  'src/main/browser-view-manager.ts', 'src/main/native-overlay-surfaces.ts', 'src/shared/native-overlay.ts', 'src/renderer/src/hooks/useNativeOverlayChrome.ts', 'src/renderer/src/lib/native-overlay-regions.ts',
  'src/main/browser-profile-manager.ts', 'src/main/browser-profile-store.ts', 'src/main/browser-ref-ledger-store.ts', 'src/preload/index.ts', 'src/renderer/src/store.ts',
  'src/renderer/src/lib/workbench-persistence.ts', 'src/renderer/src/lib/workbench-tabs.ts', 'src/renderer/src/lib/markdown-file-reference.ts', 'src/renderer/src/lib/terminal-path-link.ts',
  'src/renderer/src/lib/agent-markdown.ts', 'src/renderer/src/components/AgentMarkdown.tsx', 'src/renderer/src/components/ConversationImage.tsx', 'src/renderer/src/components/ConversationMessage.tsx', 'src/renderer/src/components/SessionPane.tsx',
  'src/renderer/src/components/FileSurfaceView.tsx', 'src/renderer/src/components/FilePreviewPane.tsx', 'src/renderer/src/components/BrowserPane.tsx', 'src/renderer/src/components/FileExplorer.tsx',
  'src/renderer/src/components/WorkspaceWorkbench.tsx', 'src/renderer/src/styles/browser.css', 'src/renderer/src/styles/index.css',
  ...['entry.tsx', 'main.cjs', 'preload.ts', 'native-owner.ts', 'index.html', 'vitest.owning.config.mts', 'native-proof.mjs'].map(name => 'scripts/fixtures/local-link-preview-maintenance/' + name),
  'scripts/fixtures/bookmark-local-link/vitest.owning.config.mts', 'scripts/verify-local-link-preview-maintenance.mjs']
async function bindings(root) {
  const entries = []; for (const file of sourceNames) entries.push(['apps/desktop/' + file, sha(await readFile(join(root, 'apps/desktop', file)))])
  const sdk = 'packages/core/node_modules/@ctxmux/sdk'
  const dependencies = ['packages/core/vendor/ctxmux/darwin-arm64/manifest.json', 'packages/core/vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz', sdk + '/package.json',
    ...(await readdir(join(root, sdk, 'dist'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(root.length + 1)).sort()]
  for (const file of dependencies) entries.push([file, sha(await readFile(join(root, file)))])
  return Object.fromEntries(entries)
}
function assertFrames(frames, lane) {
  assert.ok(frames.length > 0); const browserLayers = frames.flatMap(frame => frame.layers).filter(layer => layer.kind === 'browser')
  if (lane === 'markdown') { assert.ok(browserLayers.length > 0); assert.ok(browserLayers.some(layer => new URL(layer.url).protocol === 'http:')) }
  for (const frame of frames) { assert.ok(frame.root.pixelSize.width > 0 && frame.root.pixelSize.height > 0); assert.ok(frame.method.includes('composed workface')); for (const layer of frame.layers) { assert.equal(layer.visible, true); assert.ok(layer.bounds.width > 0 && layer.bounds.height > 0); assert.ok(layer.pixelSize.width > 0 && layer.pixelSize.height > 0) } }
}
export async function consumeNative({ root, evidence, lane }) {
  const receipt = JSON.parse(await readFile(join(evidence, 'capture-receipt.json'), 'utf8')), identity = await bindings(root)
  assert.equal(receipt.schema, 'agentmux.local-link-preview-maintenance-native.v1'); assert.equal(receipt.passed, true); assert.equal(receipt.lane, lane)
  assert.deepEqual(receipt.identity, identity); assert.equal(receipt.sourceDigest, sha(JSON.stringify(identity)))
  assert.equal(receipt.processes.length, lane === 'markdown' ? 2 : 1)
  if (lane === 'markdown') { assert.notEqual(receipt.processes[0].render.pid, receipt.processes[1].render.pid); assert.equal(receipt.processes[1].render.durable.passed, true) }
  else {
    const process = receipt.processes[0].render, attachment = process.attachment
    assert.equal(attachment.passed, true); assert.ok(attachment.nativeImageEvents.length > 0)
    assert.ok(attachment.nativeImageEvents.some(event => event.kind === 'load' && event.trusted && event.className === 'md-conversation-image__thumb' && event.naturalWidth === 640))
    for (const className of ['md-conversation-image__thumb', 'md-conversation-image__full']) assert.ok(attachment.nativeImageEvents.some(event => event.kind === 'error' && event.trusted && event.className === className && event.src === 'data:image/png;base64,aGVsbG8='))
    assert.ok(process.reads.some(read => read.method === 'readPastedImage' && read.dataUrl === 'data:image/png;base64,aGVsbG8=')); assert.equal(attachment.originalDraft.dirty, true)
    assert.ok(process.messageBounds.some(bounds => bounds.name === 'narrow-light' && bounds.width < 360 && bounds.width > 250))
  }
  for (const item of receipt.processes) {
    assert.equal(item.outcome.exitCode, 0); assert.equal(item.outcome.timedOut, false); assert.equal(item.outcome.interruption, null); assert.equal(item.render.passed, true); assert.ok(item.render.pid > 0)
    for (const key of ['nativeOwnerSha256', 'preloadSha256', 'mainSha256']) assert.equal(item.render.loaded[key], receipt.compiled[key])
    assert.equal(item.render.loaded.rendererHtmlSha256, receipt.compiled.archive['renderer/index.html']); assert.ok(item.render.frames.length > 0)
    assert.equal(sha(await readFile(join(evidence, item.log))), item.logSha256)
    const raw = await readFile(join(evidence, item.report), 'utf8'); assert.equal(sha(raw), item.reportSha256); assert.deepEqual(JSON.parse(raw), item.render)
  }
  assertFrames(receipt.frames, lane)
  const originalFrames = receipt.frames.map(({ sha256, root: frameRoot, layers, ...frame }) => ({ ...frame,
    root: Object.fromEntries(Object.entries(frameRoot).filter(([key]) => key !== 'sha256')), layers: layers.map(layer => Object.fromEntries(Object.entries(layer).filter(([key]) => key !== 'sha256'))) }))
  assert.deepEqual(originalFrames, receipt.processes.flatMap(item => item.render.frames))
  for (const frame of receipt.frames) { assert.equal(sha(await readFile(join(evidence, frame.file))), frame.sha256); assert.equal(sha(await readFile(join(evidence, frame.root.file))), frame.root.sha256); for (const layer of frame.layers) assert.equal(sha(await readFile(join(evidence, layer.file))), layer.sha256) }
  assert.ok(Object.keys(receipt.compiled.archive).length > 0)
  for (const [file, hash] of Object.entries(receipt.compiled.archive)) assert.equal(sha(await readFile(join(evidence, 'compiled', file))), hash)
  for (const [file, hash] of Object.entries(receipt.compiled.loaded)) if (identity[file]) assert.equal(identity[file], hash)
  assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.cleanup.rootRemoved, true); assert.equal(receipt.userRunTouched, false)
  console.log(JSON.stringify({ passed: true, lane, mode: 'read-only-current-native-proof', frames: receipt.frames.length, sourceDigest: receipt.sourceDigest }))
  return receipt
}
export async function runNative({ root, evidence, lane }) {
  const desktop = join(root, 'apps/desktop'), fixture = join(desktop, 'scripts/fixtures/local-link-preview-maintenance'), identity = await bindings(root)
  await mkdir(evidence, { recursive: true }); const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-local-preview-")), profile = join(privateRoot, 'profile'), home = join(privateRoot, 'home'), workspace = join(privateRoot, 'workspace'), outDir = join(privateRoot, 'out')
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>Research &amp; Notes</title><style>body{background:#f0f5f1;color:#24352b;font:20px system-ui;padding:48px}p{color:#557062}</style><h1>A local saved link</h1><p>The original AgentMux Browser opened this generic HTTP target.</p>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const httpUrl = `http://127.0.0.1:${server.address().port}/`
  const report = { schema: 'agentmux.local-link-preview-maintenance-native.v1', lane, passed: false, identity, sourceDigest: sha(JSON.stringify(identity)), processes: [], frames: [], userRunTouched: false,
    boundary: 'Private production Workbench/FileExplorer/FileSurfaceView/ConversationMessage/AgentMarkdown/Radix overlays and preload call real WorkspaceFiles, bookmark and pasted-image byte readers, BrowserViewManager/presentation/native-Chrome owners through a narrow private IPC adapter. Configuration/discovery and the complete ConversationMessage record is controlled; SessionPane is compiled as an adjacent Workbench consumer but not mounted for the attachment scene. No Session or Agent process is created. Actual Chromium decode and CDP input use software rendering. Captures explicitly compose actual Renderer root and visible native layers with their bounds; they are not OS screenshots. Markdown alone uses two same-profile processes to verify original File/dirty source/Tab/Region/layout and bookmark restoration. No installed App, GPU or healthy Run claim.' }
  try {
    await mkdir(profile); await mkdir(join(home, '.agentmux/pasted'), { recursive: true }); await mkdir(join(workspace, 'docs/images'), { recursive: true })
    await writeFile(join(home, '.agentmux/pasted/bad.png'), 'hello')
    await writeFile(join(workspace, 'notes.md'), '# Original neighbor\n\nThis File Region retains its reading context.\n')
    await writeFile(join(workspace, 'docs/readme.md'), '# Local previews\n\nThe current document owns these paths.\n\n![Photo with spaces](images/photo%20one.png)\n\n![中文图片](./图片.png)\n\n[Research & Notes](./Research%20%26%20Notes.webloc)\n\nPlain root code stays strict: `src/example.ts:3`.\n')
    await writeFile(join(workspace, 'docs/Research & Notes.webloc'), `<?xml version="1.0"?><plist version="1.0"><dict><key>URL</key><string>${httpUrl}</string></dict></plist>`)
    const loaded = {}, styles = {}, alias = sourceAliases
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias }, plugins: [{ name: 'preview-owning-production-identity', enforce: 'pre',
      transform(bytes, id) { if (id.startsWith(desktop + '/src/') && !id.includes('?')) loaded[id.slice(root.length + 1)] = sha(bytes) },
      async generateBundle() { for (const file of this.getWatchFiles()) if (file.startsWith(desktop + '/src/') && file.endsWith('.css')) styles[file.slice(root.length + 1)] = sha(await readFile(file)) } }],
      define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir, emptyOutDir: true } })
    for (const file of sourceNames.filter(file => file.startsWith('src/renderer/') && !file.endsWith('.css'))) assert.equal(loaded['apps/desktop/' + file], identity['apps/desktop/' + file], 'Actual compiled production module: ' + file)
    for (const file of sourceNames.filter(file => file.endsWith('.css'))) assert.equal(styles['apps/desktop/' + file], identity['apps/desktop/' + file])
    const nativeModule = join(privateRoot, 'native-owner.mjs')
    await esbuild.build({ entryPoints: [join(fixture, 'native-owner.ts')], outfile: nativeModule, bundle: true, platform: 'node', format: 'esm', banner: { js: "import { createRequire as previewProofCreateRequire } from 'node:module'; const require = previewProofCreateRequire(import.meta.url);" }, external: ['electron'], alias: Object.fromEntries(alias.map(item => [item.find, item.replacement])), logLevel: 'error' })
    await esbuild.build({ entryPoints: [join(fixture, 'preload.ts')], outfile: join(privateRoot, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error' })
    const main = join(privateRoot, 'main.cjs'); await copyFile(join(fixture, 'main.cjs'), main)
    report.compiled = { loaded, styles, nativeOwnerSha256: sha(await readFile(nativeModule)), preloadSha256: sha(await readFile(join(privateRoot, 'preload.cjs'))), mainSha256: sha(await readFile(main)), archive: {} }
    await mkdir(join(evidence, 'compiled'), { recursive: true })
    for (const [name, file] of [['native-owner.mjs', nativeModule], ['preload.cjs', join(privateRoot, 'preload.cjs')], ['main.cjs', main]]) { await copyFile(file, join(evidence, 'compiled', name)); report.compiled.archive[name] = sha(await readFile(file)) }
    for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const file = join(entry.parentPath, entry.name), name = 'renderer/' + file.slice(outDir.length + 1); await mkdir(resolve(evidence, 'compiled', name, '..'), { recursive: true }); await copyFile(file, join(evidence, 'compiled', name)); report.compiled.archive[name] = sha(await readFile(file)) }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    for (const phase of lane === 'markdown' ? ['capture', 'restart'] : ['capture']) {
      const lines = [], outcome = await runProbeProcess(require('electron'), [main, join(outDir, 'index.html'), profile, evidence, phase, nativeModule, workspace, httpUrl, httpUrl, home, lane], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120000, onLine: line => lines.push(line) })
      await writeFile(join(evidence, phase + '-process.log'), lines.join('\n')); const item = { phase, outcome, log: phase + '-process.log', logSha256: sha(await readFile(join(evidence, phase + '-process.log'))) }; report.processes.push(item)
      const raw = await readFile(join(evidence, phase + '-render.json'), 'utf8').catch(() => null); assert.ok(raw?.trim(), `Private ${phase} ended without a Renderer report: ${JSON.stringify(outcome)}`)
      const render = JSON.parse(raw); Object.assign(item, { render, report: phase + '-render.json', reportSha256: sha(raw) }); assert.equal(outcome.exitCode, 0, render.failure?.message); assert.equal(render.passed, true)
      for (const key of ['nativeOwnerSha256', 'preloadSha256', 'mainSha256']) assert.equal(render.loaded[key], report.compiled[key]); assert.equal(render.loaded.rendererHtmlSha256, report.compiled.archive['renderer/index.html'])
      for (const frame of render.frames) report.frames.push({ ...frame, sha256: sha(await readFile(join(evidence, frame.file))), root: { ...frame.root, sha256: sha(await readFile(join(evidence, frame.root.file))) }, layers: await Promise.all(frame.layers.map(async layer => ({ ...layer, sha256: sha(await readFile(join(evidence, layer.file))) }))) })
    }
    if (lane === 'markdown') { assert.notEqual(report.processes[0].render.pid, report.processes[1].render.pid); assert.equal(report.processes[1].render.durable.passed, true) }
    assert.deepEqual(await bindings(root), identity, 'Source remained unchanged during Native qualification'); assertFrames(report.frames, lane); report.passed = true
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    for (const pid of await listProbeProcesses(-1, privateRoot)) await signalOwnedProbeProcess(pid, privateRoot, 'SIGKILL')
    report.cleanup = { remaining: await listProbeProcesses(-1, privateRoot) }; await rm(privateRoot, { recursive: true, force: true }); report.cleanup.rootRemoved = true
    await new Promise(resolve => server.close(resolve)); await writeFile(join(evidence, 'capture-receipt.json'), JSON.stringify(report, null, 2));
    await writeFile(join(evidence, 'review-exact-frames.json'), JSON.stringify({ schema: 'agentmux.local-preview-exactframes.v1', lane, sourceDigest: report.sourceDigest, frames: report.frames.map(frame => ({ name: frame.name, file: frame.file, sha256: frame.sha256, method: frame.method, root: frame.root, layers: frame.layers })) }, null, 2))
  }
  assert.equal(report.passed, true, JSON.stringify(report.failure)); return report
}
