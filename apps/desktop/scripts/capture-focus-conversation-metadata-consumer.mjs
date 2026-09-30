import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/focus-conversation-metadata-consumer')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/focus-conversation-metadata-scene'))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = require('electron')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const producerFile = 'docs/reviews/evidence/focus-conversation-metadata-consumer-2026-10-04/public-producer.json'
const producer = await fs.readFile(path.join(root, producerFile))
assert.equal(hash(producer), 'eb3f0a68f5068ed2bb66dc11f2b6f744d7527cdaacecdc5c257e5482716d88ab')
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-metadata-')
const product = [
  'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx',
  'apps/desktop/src/renderer/src/components/ConversationMessage.tsx', 'apps/desktop/src/renderer/src/components/ConversationMessageAvatar.tsx',
  'apps/desktop/src/renderer/src/components/ConversationInputDetails.tsx', 'apps/desktop/src/renderer/src/lib/conversation-speaker.ts',
  'apps/desktop/src/renderer/src/lib/conversation-sender-details.ts', 'apps/desktop/src/renderer/src/lib/session-user-messages.ts',
  'apps/desktop/src/renderer/src/styles/focus.css'
]
const sourcePaths = [...product, ...['entry.mjs', 'main.mjs', 'preload.cjs', 'index.html'].map(file =>
  `apps/desktop/scripts/fixtures/focus-conversation-metadata-consumer/${file}`)]
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-conversation-metadata-scene.v1', passed: false, sourceRoot: root,
  inputs: await binding(), publicProducer: { path: producerFile, sha256: hash(producer) }, compiled: {}, images: [], cleanup: null,
  boundary: 'Light actual production Renderer compile, Store and common message consumption with sealed genuine producer records. Isolated typed read transport; no new Reader/Writer, real healthy Run, ordinary restart, package or installation qualification.' }
await fs.mkdir(evidence, { recursive: true })
try {
  const { assertWorkspaceDistBuiltFromCurrentSource } = await import(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)
  await assertWorkspaceDistBuiltFromCurrentSource(root)
  const loaded = [], binder = { name: 'actual-focus-metadata-scene-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0], before = code
    if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/.test(file)) return
    if (file === path.join(root, 'apps/desktop/src/renderer/src/lib/conversation-sender-details.ts')) {
      const needle = '  const metadata = currentConversationSpeakerMetadata(sessionId, snapshot)'
      assert.equal(code.split(needle).length, 2, 'Actual explicit detail-read instrumentation is unique')
      code = code.replace(needle, '  ;(window.__focusMetadataDetailReads ??= []).push(sessionId)\n' + needle)
    }
    loaded.push({ path: path.relative(root, file), originalSHA256: hash(before), sha256: hash(code), bytes: Buffer.byteLength(code),
      ...(before === code ? {} : { instrumentation: 'explicit-detail-read-counter' }) })
    if (before !== code) return { code, map: null }
  } }
  const cssBinder = { postcssPlugin: 'actual-focus-metadata-css-source', OnceExit(css) {
    const inputs = new Map()
    css.walk(node => {
      const input = node.source?.input
      if (input?.file !== path.join(root, product.at(-1))) return
      const item = inputs.get(input.file) ?? { input, nodes: 0 }
      item.nodes++; inputs.set(input.file, item)
    })
    for (const { input, nodes } of inputs.values()) loaded.push({ path: path.relative(root, input.file),
      originalSHA256: hash(input.css), sha256: hash(input.css), bytes: Buffer.byteLength(input.css), nodes,
      source: 'actual-postcss-import-input' })
  } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [binder],
    css: { postcss: { plugins: [cssBinder] } },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true,
      rollupOptions: { input: path.join(fixture, 'index.html') } } })
  receipt.actualLoadedModules = loaded
  for (const file of product) assert.ok(loaded.some(item => item.path === file && item.originalSHA256 === receipt.inputs[file] && item.bytes > 0), `Actual loaded Source not bound: ${file}`)
  for (const file of ['main.mjs', 'preload.cjs']) await fs.copyFile(path.join(fixture, file), path.join(privateRoot, file))
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
  receipt.compiled = Object.fromEntries(await Promise.all((await files(path.join(privateRoot, 'renderer'))).map(async file =>
    [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }
  delete env.ELECTRON_RUN_AS_NODE
  const lines = [], result = await runProbeProcess(electron,
    [path.join(privateRoot, 'main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence, path.join(root, producerFile)],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90000, onLine: line => lines.push(line) })
  await fs.writeFile(path.join(evidence, 'scene.log'), lines.join('\n'))
  receipt.actual = { ...JSON.parse(await fs.readFile(path.join(evidence, 'scene.json'), 'utf8')), result }
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, receipt.actual.failure?.message)
  assert.equal(receipt.actual.passed, true); assert.deepEqual(receipt.actual.controls, [])
  const loadedCSS = loaded.filter(item => item.path === product.at(-1))
  assert.equal(loadedCSS.length, 1); assert.ok(loadedCSS[0].nodes > 0)
  assert.equal(loadedCSS[0].originalSHA256, receipt.inputs[product.at(-1)])
  assert.equal(loadedCSS[0].sha256, loadedCSS[0].originalSHA256)
  assert.equal(receipt.actual.loadedCSS.rules.length, 1)
  for (const stylesheet of receipt.actual.loadedCSS.stylesheets) {
    const relativePath = path.relative(privateRoot, new URL(stylesheet.href).pathname)
    assert.ok(relativePath.endsWith('.css')); assert.ok(receipt.compiled[relativePath])
    stylesheet.compiledPath = relativePath; stylesheet.compiledSHA256 = receipt.compiled[relativePath]
  }
  assert.equal(receipt.actual.headerCover.counterfactual.failure.name, 'AssertionError')
  assert.equal(receipt.actual.headerCover.restored.validationStyles, 0)
  receipt.counterfactualImages = [{ path: receipt.actual.headerCover.counterfactual.image,
    sha256: hash(await fs.readFile(path.join(evidence, receipt.actual.headerCover.counterfactual.image))),
    boundary: 'Actual compiled-page CSS counterfactual: only changed header top/margin/padding are reset to the original computed values. Not an independent compile of the old Source.' }]
  for (const frame of receipt.actual.frames) receipt.images.push({ path: frame.image, width: frame.width,
    sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  assert.deepEqual(await binding(), receipt.inputs); receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
console.log(JSON.stringify({ passed: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')), images: receipt.images }))
